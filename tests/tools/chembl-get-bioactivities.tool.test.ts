/**
 * @fileoverview Behavior tests for the chembl_get_bioactivities flagship beyond
 * the molecule/target input gate: the canvas-disabled path (preview capped at
 * limit, no spill, canvasDisabled output flag), the empty-result notice, the
 * two-phase honest totalCount + potency-ranked preview (#3: isnull=false on the
 * stream, not the count), the compound × target pair (#8: both ids AND upstream,
 * combined appliedFilters.scope, empty pair, both potency views), the canvas
 * handle guidance (#15: describe-then-query named wherever a canvas_id is handed
 * back, and nowhere it is not), the DataCanvas spill path (staged set → canvas_id
 * + spilled:true + table_name "bioactivities" with the staged rows queryable),
 * canvas reuse via canvas_id, the no-spill canvas path, and the pure format()
 * (spill note, "not reported" for null potency, and the canvas-disabled cap
 * notice for #4).
 *
 * The DataCanvas is a structural fake wired via setCanvas — the handler runs its
 * real spillover()/acquire() paths against it; `fetch` is stubbed so no live
 * ChEMBL call is made.
 * @module tests/tools/chembl-get-bioactivities.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblGetBioactivities } from '@/mcp-server/tools/definitions/chembl-get-bioactivities.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { initChemblService } from '@/services/chembl/chembl-service.js';
import { FakeDataCanvas } from '../_fake-canvas.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Script the two-phase upstream (#3): the honest count call returns `honest`; the
 * view stream returns `activities` with `potent` as its page total. The two are told
 * apart by `order_by`, which only the stream carries — view-agnostic, so the same
 * helper scripts both the potency-ranked and the null-potency stream. URL-aware, so
 * call order is irrelevant. `potent` defaults to `honest` (nothing excluded).
 */
function mockUpstream(opts: {
  honest: number;
  potent?: number;
  activities: Record<string, unknown>[];
}): void {
  const potent = opts.potent ?? opts.honest;
  fetchMock.mockImplementation((url: string | URL) => {
    const isStream = String(url).includes('order_by=');
    return Promise.resolve(
      isStream
        ? jsonResponse({
            activities: opts.activities,
            page_meta: { total_count: potent, next: null },
          })
        : jsonResponse({ activities: [], page_meta: { total_count: opts.honest, next: null } }),
    );
  });
}

/**
 * Script a multi-page upstream stream: `pages` pages of `perPage` rows each,
 * chained via `page_meta.next` exactly as ChEMBL does (a relative path the
 * service resolves against the configured origin). The honest count call
 * (no `order_by`) answers `honest`.
 */
function mockPagedUpstream(opts: {
  honest: number;
  potent?: number;
  pages: number;
  perPage: number;
}): void {
  const potent = opts.potent ?? opts.pages * opts.perPage;
  fetchMock.mockImplementation((url: string | URL) => {
    const href = String(url);
    if (!href.includes('order_by=')) {
      return Promise.resolve(
        jsonResponse({ activities: [], page_meta: { total_count: opts.honest, next: null } }),
      );
    }
    const offset = Number(new URL(href).searchParams.get('offset') ?? 0);
    const page = Math.floor(offset / opts.perPage);
    const activities = Array.from({ length: opts.perPage }, (_, i) =>
      rawActivity(page * opts.perPage + i),
    );
    const nextOffset = offset + opts.perPage;
    const next =
      page + 1 < opts.pages
        ? `/chembl/api/data/activity.json?offset=${nextOffset}&order_by=x`
        : null;
    return Promise.resolve(jsonResponse({ activities, page_meta: { total_count: potent, next } }));
  });
}

/** Build a raw upstream activity row sized so ~120 of them overflow the 40KB preview budget. */
function rawActivity(i: number): Record<string, unknown> {
  return {
    activity_id: 1000 + i,
    molecule_chembl_id: `CHEMBL${i}`,
    molecule_pref_name: `Compound number ${i} with a deliberately verbose name for byte weight`,
    target_chembl_id: 'CHEMBL203',
    target_pref_name: 'Epidermal growth factor receptor',
    target_organism: 'Homo sapiens',
    assay_chembl_id: `CHEMBL${600000 + i}`,
    assay_type: 'B',
    assay_description: `Inhibition of EGFR in a binding assay, replicate ${i}, with extra descriptive text`,
    standard_type: 'IC50',
    standard_relation: '=',
    standard_value: `${(i + 1) * 1.5}`,
    standard_units: 'nM',
    pchembl_value: `${(9 - i / 50).toFixed(2)}`,
    type: 'IC50',
    value: `${(i + 1) * 0.0015}`,
    units: 'uM',
    relation: '=',
  };
}

/**
 * A raw upstream row of the kind the null-potency view exists to reach: a real
 * measurement ChEMBL could not derive a pchembl_value for (censored relation), so
 * `pchembl_value` is absent from the payload entirely rather than sent as null.
 */
function rawNullActivity(i: number): Record<string, unknown> {
  const { pchembl_value: _omitted, ...rest } = rawActivity(i);
  return { ...rest, standard_relation: '>', relation: '>' };
}

/** A row from the Imatinib × K562 intersection — every row carries BOTH IDs. */
function rawPairActivity(i: number): Record<string, unknown> {
  return {
    ...rawActivity(i),
    molecule_chembl_id: 'CHEMBL941',
    molecule_pref_name: 'IMATINIB',
    target_chembl_id: 'CHEMBL385',
    target_pref_name: 'Chronic myelogenous leukemia K562',
  };
}

/** The pair's null-potency counterpart — same intersection, no derivable pchembl_value. */
function rawNullPairActivity(i: number): Record<string, unknown> {
  const { pchembl_value: _omitted, ...rest } = rawPairActivity(i);
  return { ...rest, standard_relation: '>', relation: '>' };
}

/**
 * Script an upstream whose total depends on WHICH filters the request carries —
 * the mocked stand-in for ChEMBL's own AND. A request naming both IDs answers
 * `both`; one naming a single ID answers that side's count. The delta is the whole
 * point: ChEMBL answers 200 for a parameter it does not recognize, so a call that
 * merely succeeds proves nothing — only a narrowed count proves the second filter
 * was forwarded rather than dropped.
 */
function mockPairUpstream(
  counts: { molecule: number; target: number; both: number },
  opts: { rows?: number; row?: (i: number) => Record<string, unknown> } = {},
): void {
  const rowCount = opts.rows ?? 1;
  const row = opts.row ?? rawPairActivity;
  fetchMock.mockImplementation((url: string | URL) => {
    const params = new URL(String(url)).searchParams;
    const hasMolecule = params.has('molecule_chembl_id');
    const hasTarget = params.has('target_chembl_id');
    const total =
      hasMolecule && hasTarget ? counts.both : hasMolecule ? counts.molecule : counts.target;
    const isStream = params.has('order_by');
    return Promise.resolve(
      jsonResponse({
        activities: isStream ? Array.from({ length: rowCount }, (_, i) => row(i)) : [],
        page_meta: { total_count: total, next: null },
      }),
    );
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(() => {
  initChemblService(getServerConfig());
});

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setCanvas(undefined);
});

const ctx = () => createMockContext({ tenantId: 'default', errors: chemblGetBioactivities.errors });

/** Read the enrichment fields the handler wrote for one request. */
function enrichmentOf(c: ReturnType<typeof ctx>) {
  return getEnrichment(c) as { notice?: string; appliedFilters?: { scope?: string } };
}

describe('chembl_get_bioactivities — canvas disabled (preview only)', () => {
  it('caps the preview at the limit, marks spilled:false, and flags canvasDisabled', async () => {
    setCanvas(undefined);
    const activities = Array.from({ length: 60 }, (_, i) => rawActivity(i));
    mockUpstream({ honest: 26600, activities });
    const c = ctx();
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', limit: 10 }),
      c,
    );
    expect(result.spilled).toBe(false);
    expect(result.canvas_id).toBeNull();
    expect(result.table_name).toBeNull();
    // Preview capped at the requested limit even though 60 rows were available.
    expect(result.activities).toHaveLength(10);
    // #1: the standardized output count is totalCount (totalFound is gone).
    expect(result.totalCount).toBe(26600);
    expect('totalFound' in result).toBe(false);
    // #4: canvasDisabled is on the OUTPUT now (so format() can branch on it), not enrichment.
    expect(result.canvasDisabled).toBe(true);
    expect((getEnrichment(c) as { notice?: string }).notice).toContain('Canvas disabled');
  });

  it('emits a no-match notice for an empty result', async () => {
    setCanvas(undefined);
    mockUpstream({ honest: 0, activities: [] });
    const c = ctx();
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ molecule_chembl_id: 'CHEMBL25', standard_type: 'IC50' }),
      c,
    );
    expect(result.activities).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect((getEnrichment(c) as { notice?: string }).notice).toContain('No measurements matched');
  });

  it('sends pchembl_value__isnull=false on the stream but NOT on the honest count (#3)', async () => {
    setCanvas(undefined);
    mockUpstream({ honest: 26600, potent: 19378, activities: [rawActivity(0)] });
    await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({
        target_chembl_id: 'CHEMBL203',
        standard_type: 'IC50',
        limit: 2,
      }),
      ctx(),
    );
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    const streamUrl = urls.find((u) => u.includes('order_by=-pchembl_value'));
    const countUrl = urls.find((u) => !u.includes('order_by=-pchembl_value'));
    expect(streamUrl).toBeDefined();
    expect(streamUrl).toContain('pchembl_value__isnull=false');
    // The honest-count call must NOT carry the potency presence filter, so totalCount
    // stays the full match count (incl. measurements without a pchembl_value).
    expect(countUrl).toBeDefined();
    expect(countUrl).not.toContain('pchembl_value__isnull');
  });

  it('reports the honest total while the preview leads with potent rows + a potency notice (#3)', async () => {
    setCanvas(undefined);
    // 26600 measurements match; only 19378 carry a pchembl_value. The stream returns
    // potent rows (rawActivity has non-null pchembl_value), the count returns the full total.
    const activities = Array.from({ length: 5 }, (_, i) => rawActivity(i));
    const c = ctx();
    mockUpstream({ honest: 26600, potent: 19378, activities });
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', standard_type: 'IC50' }),
      c,
    );
    // totalCount is the honest full match count, NOT the narrowed potent count.
    expect(result.totalCount).toBe(26600);
    // The surfaced preview rows are potent (non-null pchembl_value).
    expect(result.activities[0]?.pchembl_value).not.toBeNull();
    expect(typeof result.activities[0]?.pchembl_value).toBe('number');
    const notice = (getEnrichment(c) as { notice?: string }).notice ?? '';
    expect(notice).toContain('Ranked by potency');
    expect(notice).toContain('19378');
    expect(notice).toContain('26600');
  });
});

describe('chembl_get_bioactivities — molecule × target pair (#8)', () => {
  it('forwards both ids on every upstream call and names both in appliedFilters.scope', async () => {
    setCanvas(undefined);
    mockPairUpstream({ molecule: 4878, target: 76565, both: 116 });
    const c = ctx();
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({
        molecule_chembl_id: 'CHEMBL941',
        target_chembl_id: 'CHEMBL385',
      }),
      c,
    );

    // Both filters ride the honest-count call AND the view stream — not just one.
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      expect(url).toContain('molecule_chembl_id=CHEMBL941');
      expect(url).toContain('target_chembl_id=CHEMBL385');
    }

    expect(result.totalCount).toBe(116);
    expect(result.activities[0]?.molecule_chembl_id).toBe('CHEMBL941');
    expect(result.activities[0]?.target_chembl_id).toBe('CHEMBL385');
    // structuredContent surface: the scope must name the target, not silently drop it.
    expect(enrichmentOf(c).appliedFilters?.scope).toBe('molecule CHEMBL941 × target CHEMBL385');
  });

  it('narrows to the intersection instead of either single filter', async () => {
    setCanvas(undefined);
    mockPairUpstream({ molecule: 4878, target: 76565, both: 116 });
    const totalFor = async (input: Record<string, unknown>): Promise<number> => {
      const result = await chemblGetBioactivities.handler(
        chemblGetBioactivities.input.parse(input),
        ctx(),
      );
      return result.totalCount;
    };
    // The count delta is the proof the second filter applied. Upstream answers 200
    // for a parameter it does not recognize, so a successful call proves nothing.
    expect(await totalFor({ molecule_chembl_id: 'CHEMBL941' })).toBe(4878);
    expect(await totalFor({ target_chembl_id: 'CHEMBL385' })).toBe(76565);
    expect(await totalFor({ molecule_chembl_id: 'CHEMBL941', target_chembl_id: 'CHEMBL385' })).toBe(
      116,
    );
  });

  it('renders the pair scope on the content[] surface too', () => {
    const trailer = chemblGetBioactivities.enrichmentTrailer?.appliedFilters?.render?.({
      scope: 'molecule CHEMBL941 × target CHEMBL385',
      standard_type: 'IC50',
      pchembl_value_min: null,
      assay_type: null,
      organism: null,
    });
    expect(trailer).toContain('Scope: molecule CHEMBL941 × target CHEMBL385');
  });

  it('returns the empty-result shape — not an error — for a pair with no measurements', async () => {
    setCanvas(undefined);
    // Aspirin against ABL kinase: a legitimate pair ChEMBL has never measured.
    mockPairUpstream({ molecule: 4087, target: 12000, both: 0 }, { rows: 0 });
    const c = ctx();
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({
        molecule_chembl_id: 'CHEMBL25',
        target_chembl_id: 'CHEMBL2111414',
      }),
      c,
    );
    expect(result.activities).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(enrichmentOf(c).notice).toContain('No measurements matched');
  });

  it('carries the pair into the null-potency view and its own staged table', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    mockPairUpstream(
      { molecule: 4878, target: 76565, both: 116 },
      { rows: 120, row: rawNullPairActivity },
    );
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({
        molecule_chembl_id: 'CHEMBL941',
        target_chembl_id: 'CHEMBL385',
        potency_view: 'null_potency',
      }),
      ctx(),
    );

    // Both ids forward through the same filter-params path the presence filter rides.
    const streamUrl = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((u) => u.includes('order_by='));
    expect(streamUrl).toContain('molecule_chembl_id=CHEMBL941');
    expect(streamUrl).toContain('target_chembl_id=CHEMBL385');
    expect(streamUrl).toContain('pchembl_value__isnull=true');

    expect(result.potency_view).toBe('null_potency');
    expect(result.table_name).toBe('bioactivities_null_potency');
    expect(result.totalCount).toBe(116);
    expect(result.activities.every((a) => a.pchembl_value === null)).toBe(true);

    const instance = await fake.acquire(result.canvas_id ?? undefined, { tenantId: 'default' });
    const staged = (await instance.describe()).find((t) => t.name === 'bioactivities_null_potency');
    expect(staged?.rowCount).toBe(120);
  });

  it('leaves single-id scope and filters exactly as they were', async () => {
    setCanvas(undefined);
    mockPairUpstream({ molecule: 4878, target: 76565, both: 116 });

    const byMolecule = ctx();
    await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ molecule_chembl_id: 'CHEMBL941' }),
      byMolecule,
    );
    expect(enrichmentOf(byMolecule).appliedFilters?.scope).toBe('molecule CHEMBL941');

    const byTarget = ctx();
    await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL385' }),
      byTarget,
    );
    expect(enrichmentOf(byTarget).appliedFilters?.scope).toBe('target CHEMBL385');

    // The absent side is never invented as an upstream filter.
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(
      urls.some((u) => u.includes('molecule_chembl_id') && u.includes('target_chembl_id')),
    ).toBe(false);
  });

  it('treats a blank id on one side as absent (form-client guard)', async () => {
    setCanvas(undefined);
    mockPairUpstream({ molecule: 4878, target: 76565, both: 116 });
    const c = ctx();
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({
        molecule_chembl_id: '   ',
        target_chembl_id: 'CHEMBL385',
      }),
      c,
    );
    expect(enrichmentOf(c).appliedFilters?.scope).toBe('target CHEMBL385');
    expect(result.totalCount).toBe(76565);
    for (const url of fetchMock.mock.calls.map((call) => String(call[0]))) {
      expect(url).not.toContain('molecule_chembl_id');
    }
  });
});

describe('chembl_get_bioactivities — canvas handle guidance (#15)', () => {
  it('names chembl_dataframe_describe before chembl_dataframe_query in the spill notice', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    mockUpstream({
      honest: 26600,
      activities: Array.from({ length: 120 }, (_, i) => rawActivity(i)),
    });
    const c = ctx();
    await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', limit: 25 }),
      c,
    );
    const notice = enrichmentOf(c).notice ?? '';
    expect(notice).toContain('chembl_dataframe_describe');
    expect(notice).toContain('chembl_dataframe_query');
    // Columns before SQL — valid SQL needs the schema first.
    expect(notice.indexOf('chembl_dataframe_describe')).toBeLessThan(
      notice.indexOf('chembl_dataframe_query'),
    );
    // Every name must be callable as written — no combined shorthand.
    expect(notice).not.toContain('chembl_dataframe_query/describe');
  });

  it('names both tools in the format() spill note', () => {
    const blocks = chemblGetBioactivities.format!({
      activities: [],
      totalCount: 26600,
      potency_view: 'potency_ranked',
      spilled: true,
      canvas_id: 'abc1234567',
      table_name: 'bioactivities',
      staged_row_count: 19378,
      truncated: false,
      canvasDisabled: false,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('chembl_dataframe_describe');
    expect(text).toContain('chembl_dataframe_query');
    expect(text).not.toContain('chembl_dataframe_query/describe');
  });

  it('names both tools on canvas_id, and only the SQL tool on table_name', () => {
    const shape = chemblGetBioactivities.output.shape;
    const canvasId = shape.canvas_id.description ?? '';
    expect(canvasId).toContain('chembl_dataframe_describe');
    expect(canvasId).toContain('chembl_dataframe_query');
    expect(canvasId).not.toContain('chembl_dataframe_query/describe');
    // table_name is the SQL FROM target by design, so it names only the query tool.
    const tableName = shape.table_name.description ?? '';
    expect(tableName).toContain('chembl_dataframe_query');
    expect(tableName).not.toContain('chembl_dataframe_describe');
  });

  it('adds no dataframe guidance to the branches that hand back no canvas handle', async () => {
    // Canvas disabled: nothing is staged, so there is nothing to describe or query.
    setCanvas(undefined);
    mockUpstream({ honest: 26600, activities: [rawActivity(0)] });
    const disabled = ctx();
    await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', limit: 1 }),
      disabled,
    );
    expect(enrichmentOf(disabled).notice).toContain('Canvas disabled');
    expect(enrichmentOf(disabled).notice).not.toContain('chembl_dataframe_');

    // No match: same reasoning, different branch.
    mockUpstream({ honest: 0, activities: [] });
    const empty = ctx();
    await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203' }),
      empty,
    );
    expect(enrichmentOf(empty).notice).not.toContain('chembl_dataframe_');
  });

  it('adds no dataframe guidance when the whole view fit inline', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    mockUpstream({ honest: 3, activities: Array.from({ length: 3 }, (_, i) => rawActivity(i)) });
    const c = ctx();
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203' }),
      c,
    );
    expect(result.spilled).toBe(false);
    expect(enrichmentOf(c).notice ?? '').not.toContain('chembl_dataframe_');
  });
});

describe('chembl_get_bioactivities — DataCanvas spill', () => {
  it('stages the full set to the bioactivities table and returns canvas_id + spilled:true', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    // ~120 fat rows overflow the 40KB preview budget, forcing a spill.
    const activities = Array.from({ length: 120 }, (_, i) => rawActivity(i));
    mockUpstream({ honest: 26600, activities });
    const c = ctx();
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({
        target_chembl_id: 'CHEMBL203',
        standard_type: 'IC50',
        limit: 25,
      }),
      c,
    );
    expect(result.spilled).toBe(true);
    expect(result.table_name).toBe('bioactivities');
    expect(result.canvas_id).toBeTruthy();
    expect(result.canvasDisabled).toBe(false);
    // The inline preview is capped at the requested limit, not the whole set.
    expect(result.activities.length).toBeLessThanOrEqual(25);
    expect(result.totalCount).toBe(26600);

    // The full set is staged on the canvas under "bioactivities" — assert it landed.
    const instance = await fake.acquire(result.canvas_id ?? undefined, { tenantId: 'default' });
    const tables = await instance.describe();
    const bio = tables.find((t) => t.name === 'bioactivities');
    expect(bio).toBeDefined();
    expect(bio?.rowCount).toBe(120);
    // standard_value coerced to a number → DOUBLE column type inferred by the fake.
    expect(bio?.columns.find((col) => col.name === 'standard_value')?.type).toBe('DOUBLE');

    const notice = (getEnrichment(c) as { notice?: string }).notice;
    expect(notice).toContain('bioactivities');
    expect(notice).toContain('chembl_dataframe_describe');
    expect(notice).toContain('chembl_dataframe_query');
  });

  it('reuses an existing canvas when canvas_id is supplied', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    // Pre-mint a canvas the handler should reuse rather than minting a fresh one.
    const existing = await fake.acquire(undefined, { tenantId: 'default' });
    const activities = Array.from({ length: 120 }, (_, i) => rawActivity(i));
    mockUpstream({ honest: 999, activities });
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({
        target_chembl_id: 'CHEMBL203',
        canvas_id: existing.canvasId,
        limit: 25,
      }),
      ctx(),
    );
    expect(result.canvas_id).toBe(existing.canvasId);
    // No second canvas was minted.
    expect(fake.countForTenant({ tenantId: 'default' })).toBe(1);
  });

  it('inlines without spilling when the result fits the preview budget (canvas enabled)', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const activities = Array.from({ length: 3 }, (_, i) => rawActivity(i));
    mockUpstream({ honest: 3, activities });
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', limit: 25 }),
      ctx(),
    );
    expect(result.spilled).toBe(false);
    expect(result.canvas_id).toBeNull();
    expect(result.canvasDisabled).toBe(false);
    expect(result.activities).toHaveLength(3);
  });
});

describe('chembl_get_bioactivities — upstream page drain', () => {
  it('follows page_meta.next to exhaustion and stages every page', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    mockPagedUpstream({ honest: 400, potent: 150, pages: 3, perPage: 50 });
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', limit: 25 }),
      ctx(),
    );
    expect(result.spilled).toBe(true);

    // Three stream pages were fetched (plus the separate honest-count call).
    const streamCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('order_by='),
    );
    expect(streamCalls).toHaveLength(3);

    // Every row from every page landed on the canvas — the drain is not short-circuited.
    const instance = await fake.acquire(result.canvas_id ?? undefined, { tenantId: 'default' });
    const staged = (await instance.describe()).find((t) => t.name === 'bioactivities');
    expect(staged?.rowCount).toBe(150);
  });

  it('sends the potency-ranked stream params and stages under "bioactivities" by default', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const activities = Array.from({ length: 120 }, (_, i) => rawActivity(i));
    mockUpstream({ honest: 26600, potent: 19378, activities });
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203' }),
      ctx(),
    );
    const streamUrl = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((u) => u.includes('order_by='));
    expect(streamUrl).toContain('order_by=-pchembl_value');
    expect(streamUrl).toContain('pchembl_value__isnull=false');
    expect(result.table_name).toBe('bioactivities');
  });
});

describe('chembl_get_bioactivities — null-potency view (#9)', () => {
  it('switches the stream to pchembl_value__isnull=true and stages its own table', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const activities = Array.from({ length: 120 }, (_, i) => rawNullActivity(i));
    // CHEMBL25: 4087 measurements match, 3929 of them report no pchembl_value.
    mockUpstream({ honest: 4087, potent: 3929, activities });
    const c = ctx();
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({
        molecule_chembl_id: 'CHEMBL25',
        potency_view: 'null_potency',
      }),
      c,
    );

    const streamUrl = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((u) => u.includes('order_by='));
    expect(streamUrl).toContain('pchembl_value__isnull=true');
    expect(streamUrl).not.toContain('pchembl_value__isnull=false');

    expect(result.potency_view).toBe('null_potency');
    expect(result.table_name).toBe('bioactivities_null_potency');
    expect(result.totalCount).toBe(4087);
    // The rows this view exists to reach: every one reports no derivable potency.
    expect(result.activities.every((a) => a.pchembl_value === null)).toBe(true);

    const notice = (getEnrichment(c) as { notice?: string }).notice ?? '';
    expect(notice).toContain('bioactivities_null_potency');
    expect(notice).toContain('potency_ranked');
  });

  it('leaves the default bioactivities table intact when reusing a canvas', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());

    mockUpstream({
      honest: 4087,
      potent: 158,
      activities: Array.from({ length: 120 }, (_, i) => rawActivity(i)),
    });
    const first = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ molecule_chembl_id: 'CHEMBL25' }),
      ctx(),
    );
    expect(first.table_name).toBe('bioactivities');

    mockUpstream({
      honest: 4087,
      potent: 3929,
      activities: Array.from({ length: 120 }, (_, i) => rawNullActivity(i)),
    });
    const second = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({
        molecule_chembl_id: 'CHEMBL25',
        potency_view: 'null_potency',
        canvas_id: first.canvas_id ?? undefined,
      }),
      ctx(),
    );
    expect(second.canvas_id).toBe(first.canvas_id);

    // Both views coexist on the one canvas, so SQL can UNION them for the honest set.
    const instance = await fake.acquire(first.canvas_id ?? undefined, { tenantId: 'default' });
    const names = (await instance.describe()).map((t) => t.name).sort();
    expect(names).toEqual(['bioactivities', 'bioactivities_null_potency']);
  });

  it('returns an empty result — not an error — when no null-potency rows exist', async () => {
    setCanvas(undefined);
    mockUpstream({ honest: 12, potent: 0, activities: [] });
    const c = ctx();
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({
        target_chembl_id: 'CHEMBL203',
        potency_view: 'null_potency',
      }),
      c,
    );
    expect(result.activities).toEqual([]);
    expect(result.potency_view).toBe('null_potency');
    expect(result.totalCount).toBe(12);
    const notice = (getEnrichment(c) as { notice?: string }).notice ?? '';
    expect(notice).toContain('potency_ranked');
  });

  it('points at the null-potency view when every match lacks a pchembl_value', async () => {
    setCanvas(undefined);
    mockUpstream({ honest: 4087, potent: 0, activities: [] });
    const c = ctx();
    await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ molecule_chembl_id: 'CHEMBL25' }),
      c,
    );
    const notice = (getEnrichment(c) as { notice?: string }).notice ?? '';
    expect(notice).toContain('null_potency');
  });

  it('rejects a potency floor on the null-potency view instead of returning a silent empty set', async () => {
    setCanvas(undefined);
    mockUpstream({ honest: 4087, potent: 0, activities: [] });
    await expect(
      Promise.resolve(
        chemblGetBioactivities.handler(
          chemblGetBioactivities.input.parse({
            molecule_chembl_id: 'CHEMBL25',
            potency_view: 'null_potency',
            pchembl_value_min: 7,
          }),
          ctx(),
        ),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'contradictory_potency_filter' },
    });
    // The gate fires before any upstream call.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('defaults to the potency-ranked view when potency_view is omitted', async () => {
    setCanvas(undefined);
    mockUpstream({ honest: 4087, potent: 158, activities: [rawActivity(0)] });
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ molecule_chembl_id: 'CHEMBL25', limit: 2 }),
      ctx(),
    );
    expect(result.potency_view).toBe('potency_ranked');
    const streamUrl = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((u) => u.includes('order_by='));
    expect(streamUrl).toContain('pchembl_value__isnull=false');
  });
});

describe('chembl_get_bioactivities format()', () => {
  it('renders the spill note and a row block when spilled', () => {
    const blocks = chemblGetBioactivities.format!({
      activities: [
        {
          activity_id: 1,
          molecule_chembl_id: 'CHEMBL68920',
          molecule_pref_name: null,
          target_chembl_id: 'CHEMBL203',
          target_pref_name: 'EGFR',
          target_organism: 'Homo sapiens',
          assay_chembl_id: 'CHEMBL674637',
          assay_type: 'B',
          assay_description: 'Inhibition of EGFR',
          standard_type: 'IC50',
          standard_relation: '=',
          standard_value: 41,
          standard_units: 'nM',
          pchembl_value: 7.39,
          type: 'IC50',
          value: '0.041',
          units: 'uM',
          relation: '=',
        },
      ],
      totalCount: 26600,
      potency_view: 'potency_ranked',
      spilled: true,
      canvas_id: 'abc1234567',
      table_name: 'bioactivities',
      staged_row_count: 19378,
      truncated: false,
      canvasDisabled: false,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**26600** measurements total');
    expect(text).toContain('spilled: yes');
    expect(text).toContain('`bioactivities`');
    expect(text).toContain('**CHEMBL68920**');
    expect(text).toContain('IC50: =41 nM');
    expect(text).toContain('pChEMBL: 7.39');
    // Which view these rows are, and that the table is complete.
    expect(text).toContain('potency_view: `potency_ranked`');
    expect(text).toContain('null_potency');
    expect(text).toContain('staged_row_count: 19378');
    expect(text).toContain('truncated: no');
  });

  it('flags a capped table as a bounded slice, never as the complete view (#14)', () => {
    const blocks = chemblGetBioactivities.format!({
      activities: [],
      totalCount: 405219,
      potency_view: 'potency_ranked',
      spilled: true,
      canvas_id: 'abc1234567',
      table_name: 'bioactivities',
      staged_row_count: 50000,
      truncated: true,
      canvasDisabled: false,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('truncated: yes');
    expect(text).toContain('staged_row_count: 50000');
    expect(text).toContain('NOT the complete view');
    expect(text).not.toContain('truncated: no');
  });

  it('names the null-potency view and the way back to the ranked one (#9)', () => {
    const blocks = chemblGetBioactivities.format!({
      activities: [],
      totalCount: 4087,
      potency_view: 'null_potency',
      spilled: true,
      canvas_id: 'abc1234567',
      table_name: 'bioactivities_null_potency',
      staged_row_count: 3929,
      truncated: false,
      canvasDisabled: false,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('potency_view: `null_potency`');
    expect(text).toContain('`potency_ranked`');
    expect(text).toContain('`bioactivities_null_potency`');
  });

  it('renders "not reported" for a null potency rather than 0', () => {
    const blocks = chemblGetBioactivities.format!({
      activities: [
        {
          activity_id: 99,
          molecule_chembl_id: 'CHEMBL1',
          molecule_pref_name: null,
          target_chembl_id: 'CHEMBL203',
          target_pref_name: null,
          target_organism: null,
          assay_chembl_id: 'CHEMBL2',
          assay_type: null,
          assay_description: null,
          standard_type: 'IC50',
          standard_relation: null,
          standard_value: null,
          standard_units: null,
          pchembl_value: null,
          type: null,
          value: null,
          units: null,
          relation: null,
        },
      ],
      totalCount: 1,
      potency_view: 'potency_ranked',
      spilled: false,
      canvas_id: null,
      table_name: null,
      staged_row_count: null,
      truncated: false,
      canvasDisabled: false,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('spilled: no');
    expect(text).toContain('not reported');
    expect(text).not.toContain('IC50: 0');
    expect(text).toContain('pChEMBL: —');
  });

  it('renders the no-rows marker when the preview is empty', () => {
    const blocks = chemblGetBioactivities.format!({
      activities: [],
      totalCount: 0,
      potency_view: 'potency_ranked',
      spilled: false,
      canvas_id: null,
      table_name: null,
      staged_row_count: null,
      truncated: false,
      canvasDisabled: false,
    });
    expect((blocks[0] as { text: string }).text).toContain('No rows in preview');
  });

  it('does NOT claim the capped rows are the full set when canvas is disabled (#4)', () => {
    const blocks = chemblGetBioactivities.format!({
      activities: [
        {
          activity_id: 32770,
          molecule_chembl_id: 'CHEMBL1',
          molecule_pref_name: null,
          target_chembl_id: 'CHEMBL203',
          target_pref_name: 'EGFR',
          target_organism: 'Homo sapiens',
          assay_chembl_id: 'CHEMBL2',
          assay_type: 'B',
          assay_description: null,
          standard_type: 'IC50',
          standard_relation: '=',
          standard_value: 500000,
          standard_units: 'nM',
          pchembl_value: null,
          type: 'IC50',
          value: '500000',
          units: 'nM',
          relation: '=',
        },
      ],
      // 26600 total but only 2 rows previewed, canvas disabled — must NOT say "full set".
      totalCount: 26600,
      potency_view: 'potency_ranked',
      spilled: false,
      canvas_id: null,
      table_name: null,
      staged_row_count: null,
      truncated: false,
      canvasDisabled: true,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**26600** measurements total');
    expect(text).not.toContain('preview is the full set');
    expect(text).toContain('canvas disabled');
    expect(text).toContain('capped preview');
  });
});
