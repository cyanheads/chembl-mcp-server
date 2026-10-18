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
 * canvas reuse via canvas_id, the no-spill canvas path, the mint-on-spill canvas and
 * the supplied-canvas staging swap with its per-table write turn (#28), the
 * inline-fit re-stage on a supplied canvas (#31), the offset page walk (#32: tie
 * groups across page edges staged once), the concurrent spill walk under its time
 * budget (#16) and the inline page's one budget (#33), the inline-page cursor (#17:
 * round trip, walk to exhaustion, past the end, malformed, canvas-on cursor pages
 * that never stage), and the pure format() (spill note, "not reported" for null
 * potency, the canvas-disabled cap notice for #4, the cursor continuation line).
 *
 * The DataCanvas is a structural fake wired via setCanvas — the handler runs its
 * real spillover()/acquire() paths against it; `fetch` is stubbed so no live
 * ChEMBL call is made.
 * @module tests/tools/chembl-get-bioactivities.tool
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { decodeCursor, encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblGetBioactivities } from '@/mcp-server/tools/definitions/chembl-get-bioactivities.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { initChemblService } from '@/services/chembl/chembl-service.js';
import {
  type ActivityCorpusOptions,
  activityCorpus,
  type CorpusTraffic,
  corpusTraffic,
  viewRequests,
} from '../_fake-activity-upstream.js';
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
 * Serve a multi-page view: `rows` corpus rows behind a fake `/activity` that
 * honors `offset` / `limit` as ChEMBL does, walked by the service at `pageSize`
 * rows per page (its CHEMBL_MAX_PAGE_SIZE). The honest count call (no
 * `order_by`) answers `honest`. `afterEach` restores the configured page size.
 */
function mockPagedUpstream(opts: {
  honest: number;
  rows: Record<string, unknown>[];
  pageSize: number;
}): void {
  initChemblService({ ...getServerConfig(), maxPageSize: opts.pageSize });
  fetchMock.mockImplementation(activityCorpus({ honest: opts.honest, rows: opts.rows }));
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
  initChemblService(getServerConfig());
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
      truncated_by: null,
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

/**
 * 150 ranked rows served by offset in 50-row pages. ~68 rows fill the 40 KB
 * preview budget, so the preview drain reads the pages at offsets 0 and 50 (the
 * overflow sentinel sits in the second) and the spill reads offset 100 while the
 * table is being registered.
 */
const SPILL_ROWS = Array.from({ length: 150 }, (_, i) => rawActivity(i));

/**
 * Serve SPILL_ROWS, running `interrupt` when the view page at `offset` is
 * requested: a Response it returns replaces that page (an upstream failure), and
 * one it does not return lets the page through (an abort fired mid-request).
 */
function interruptPageAt(offset: number, interrupt: () => Response | undefined): void {
  initChemblService({ ...getServerConfig(), maxPageSize: 50 });
  const corpus = activityCorpus({ honest: 400, rows: SPILL_ROWS });
  fetchMock.mockImplementation((input: string | URL) => {
    const params = new URL(String(input)).searchParams;
    if (params.has('order_by') && Number(params.get('offset')) === offset) {
      const replaced = interrupt();
      if (replaced) return Promise.resolve(replaced);
    }
    return corpus(input);
  });
}

/** A ChEMBL page that answers 404 — a non-retried upstream failure. */
const upstream404 = () => jsonResponse({ error_message: 'Not found.' }, 404);

/** Stage a table of each view on a fresh canvas — what a caller's earlier calls left there. */
async function canvasWithBothViews(fake: FakeDataCanvas) {
  const existing = await fake.acquire(undefined, { tenantId: 'default' });
  const ranked = [{ activity_id: 1, molecule_chembl_id: 'CHEMBL1' }];
  const unranked = [{ activity_id: 2, molecule_chembl_id: 'CHEMBL2' }];
  await existing.registerTable('bioactivities', ranked);
  await existing.registerTable('bioactivities_null_potency', unranked);
  return { canvasId: existing.canvasId, ranked, unranked };
}

/** The rows each table on `canvasId` holds, by table name. */
function tablesOn(fake: FakeDataCanvas, canvasId: string): Record<string, unknown[]> {
  const tables = fake.canvases.get(canvasId)?.tables ?? new Map();
  return Object.fromEntries([...tables].map(([name, table]) => [name, table.rows]));
}

describe('chembl_get_bioactivities — supplied canvas_id across failures (#28)', () => {
  it('keeps a supplied canvas and its tables when upstream fails before anything stages', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const { canvasId, ranked, unranked } = await canvasWithBothViews(fake);
    interruptPageAt(0, upstream404);
    await expect(
      Promise.resolve(
        chemblGetBioactivities.handler(
          chemblGetBioactivities.input.parse({
            target_chembl_id: 'CHEMBL203',
            canvas_id: canvasId,
          }),
          ctx(),
        ),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'not_found' } });
    expect(tablesOn(fake, canvasId)).toEqual({
      bioactivities: ranked,
      bioactivities_null_potency: unranked,
    });
  });

  it('keeps a supplied canvas and its tables when the call is cancelled before anything stages', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const { canvasId, ranked, unranked } = await canvasWithBothViews(fake);
    const controller = new AbortController();
    interruptPageAt(50, () => {
      controller.abort();
      return;
    });
    await expect(
      Promise.resolve(
        chemblGetBioactivities.handler(
          chemblGetBioactivities.input.parse({
            target_chembl_id: 'CHEMBL203',
            canvas_id: canvasId,
          }),
          createMockContext({
            tenantId: 'default',
            errors: chemblGetBioactivities.errors,
            signal: controller.signal,
          }),
        ),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(tablesOn(fake, canvasId)).toEqual({
      bioactivities: ranked,
      bioactivities_null_potency: unranked,
    });
  });

  it('keeps a supplied canvas and both its tables when the spill itself fails', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const { canvasId, ranked, unranked } = await canvasWithBothViews(fake);
    const drop = vi.spyOn(fake, 'drop');
    interruptPageAt(100, upstream404);
    await expect(
      Promise.resolve(
        chemblGetBioactivities.handler(
          chemblGetBioactivities.input.parse({
            target_chembl_id: 'CHEMBL203',
            canvas_id: canvasId,
          }),
          ctx(),
        ),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
    // The canvas a caller handed in is never released, whatever the call did.
    expect(drop).not.toHaveBeenCalled();
    expect(fake.canvases.has(canvasId)).toBe(true);
    // The spill wrote only its own staging table, dropped on failure: the view keeps its earlier rows.
    expect(tablesOn(fake, canvasId)).toEqual({
      bioactivities: ranked,
      bioactivities_null_potency: unranked,
    });
  });

  it('keeps a supplied canvas and both its tables when the call is cancelled mid-spill', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const { canvasId, ranked, unranked } = await canvasWithBothViews(fake);
    const drop = vi.spyOn(fake, 'drop');
    // The page at offset 100 never answers, so the spill registers rows 0–99, then waits on it.
    initChemblService({ ...getServerConfig(), maxPageSize: 50 });
    fetchMock.mockImplementation(activityCorpus({ honest: 400, rows: SPILL_ROWS, stallAt: [100] }));
    const controller = new AbortController();
    const call = Promise.resolve(
      chemblGetBioactivities.handler(
        chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', canvas_id: canvasId }),
        createMockContext({
          tenantId: 'default',
          errors: chemblGetBioactivities.errors,
          signal: controller.signal,
        }),
      ),
    ).catch((error: unknown) => error);
    // Cancel once the spill has registered its partial rows on the canvas.
    await vi.waitFor(() => {
      expect(Object.values(tablesOn(fake, canvasId)).some((rows) => rows.length === 100)).toBe(
        true,
      );
    });
    // Mid-registration, the view's earlier table is still there to read.
    expect(tablesOn(fake, canvasId).bioactivities).toEqual(ranked);
    controller.abort();

    expect(await call).toMatchObject({ name: 'AbortError' });
    expect(drop).not.toHaveBeenCalled();
    expect(fake.canvases.has(canvasId)).toBe(true);
    // The partial staging table is gone, and both earlier tables are intact.
    expect(tablesOn(fake, canvasId)).toEqual({
      bioactivities: ranked,
      bioactivities_null_potency: unranked,
    });
  });

  it('keeps the earlier table when the call is cancelled after the spill, before it replaces the table', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const { canvasId, ranked, unranked } = await canvasWithBothViews(fake);
    const controller = new AbortController();
    // Cancel the moment the spill's registration completes, before anything replaces the view's table.
    const acquire = fake.acquire.bind(fake);
    vi.spyOn(fake, 'acquire').mockImplementation(async (...args) => {
      const instance = await acquire(...args);
      const register = instance.registerTable.bind(instance);
      instance.registerTable = async (...registration) => {
        const registered = await register(...registration);
        controller.abort();
        return registered;
      };
      return instance;
    });
    interruptPageAt(-1, () => undefined);
    await expect(
      Promise.resolve(
        chemblGetBioactivities.handler(
          chemblGetBioactivities.input.parse({
            target_chembl_id: 'CHEMBL203',
            canvas_id: canvasId,
          }),
          createMockContext({
            tenantId: 'default',
            errors: chemblGetBioactivities.errors,
            signal: controller.signal,
          }),
        ),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(tablesOn(fake, canvasId)).toEqual({
      bioactivities: ranked,
      bioactivities_null_potency: unranked,
    });
  });

  it('replaces the view table with the spilled rows only once the spill succeeds', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const { canvasId, unranked } = await canvasWithBothViews(fake);
    const unrankedTable = fake.canvases.get(canvasId)?.tables.get('bioactivities_null_potency');
    /**
     * Whole potencies (10–7) lead the view and fractional ones (6.90–6.41) follow,
     * so the preview the spill drains holds no fraction: a table typed from it
     * rather than from the declared schema reads pchembl_value as BIGINT.
     */
    const rows = SPILL_ROWS.map((row, i) => ({
      ...row,
      pchembl_value: i < 100 ? String(10 - Math.floor(i / 25)) : (6.9 - (i - 100) / 100).toFixed(2),
    }));
    initChemblService({ ...getServerConfig(), maxPageSize: 50 });
    fetchMock.mockImplementation(activityCorpus({ honest: 400, rows }));
    const result = await runToolContract(
      chemblGetBioactivities,
      { target_chembl_id: 'CHEMBL203', canvas_id: canvasId, limit: 5 },
      { context: { tenantId: 'default' } },
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      spilled: true,
      canvas_id: canvasId,
      table_name: 'bioactivities',
      staged_row_count: 150,
      truncated: false,
    });
    // The final table holds the new rows at the declared types; no staging table is left behind.
    const tables = fake.canvases.get(canvasId)?.tables;
    expect([...(tables?.keys() ?? [])].sort()).toEqual([
      'bioactivities',
      'bioactivities_null_potency',
    ]);
    expect(stagedIds(fake, canvasId)).toEqual(viewOrder(rows));
    expect(tables?.get('bioactivities')?.columns).toHaveLength(18);
    expect(
      tables?.get('bioactivities')?.columns.find((c) => c.name === 'pchembl_value')?.type,
    ).toBe('DOUBLE');
    // The other view's table is the same object it was: never rewritten.
    expect(tables?.get('bioactivities_null_potency')).toBe(unrankedTable);
    expect(tablesOn(fake, canvasId).bioactivities_null_potency).toEqual(unranked);

    // Both surfaces name the final table, never the staging one.
    const notice = (result.structuredContent as { notice?: string }).notice ?? '';
    expect(notice).toContain(`table "bioactivities" on canvas ${canvasId}`);
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('as table `bioactivities`');
    expect(`${notice}\n${text}`).not.toMatch(/staging/i);
  });

  it('loses only the view table, leaving no staging table, when copying the spill fails', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const { canvasId, unranked } = await canvasWithBothViews(fake);
    const engineFault = new McpError(JsonRpcErrorCode.DatabaseError, 'IO Error: disk full');
    fake.nextQueryError = engineFault;
    interruptPageAt(-1, () => undefined);
    await expect(
      Promise.resolve(
        chemblGetBioactivities.handler(
          chemblGetBioactivities.input.parse({
            target_chembl_id: 'CHEMBL203',
            canvas_id: canvasId,
          }),
          ctx(),
        ),
      ),
    ).rejects.toBe(engineFault);
    // An engine fault inside the copy comes after the old table was dropped; the staging table is cleaned up.
    expect(tablesOn(fake, canvasId)).toEqual({ bioactivities_null_potency: unranked });
    expect(fake.canvases.has(canvasId)).toBe(true);
  });

  /** Three ranked rows CHEMBL204 answers with: an inline fit, ids 1300–1302. */
  const FIT_ROWS = Array.from({ length: 3 }, (_, i) => rawActivity(300 + i));

  /**
   * Serve SPILL_ROWS for CHEMBL203 (a spill) and FIT_ROWS for CHEMBL204 (an inline
   * fit), and hold the first drop of the `bioactivities` table — which only a
   * spill's swap issues — `before` or `after` it runs, until `release()`.
   * `paused` settles once the swap is held.
   */
  function holdSwapDrop(fake: FakeDataCanvas, at: 'before' | 'after') {
    initChemblService({ ...getServerConfig(), maxPageSize: 50 });
    const spillingView = activityCorpus({ honest: 400, rows: SPILL_ROWS });
    const fittingView = activityCorpus({ honest: 3, rows: FIT_ROWS });
    fetchMock.mockImplementation((input: string | URL, init?: RequestInit) =>
      new URL(String(input)).searchParams.get('target_chembl_id') === 'CHEMBL204'
        ? fittingView(input, init)
        : spillingView(input, init),
    );
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const { promise: paused, resolve: hold } = Promise.withResolvers<void>();
    let armed = true;
    const acquire = fake.acquire.bind(fake);
    vi.spyOn(fake, 'acquire').mockImplementation(async (...args) => {
      const instance = await acquire(...args);
      const drop = instance.drop.bind(instance);
      instance.drop = async (name) => {
        if (!armed || name !== 'bioactivities') return await drop(name);
        armed = false;
        const dropped = at === 'after' ? await drop(name) : undefined;
        hold();
        await gate;
        return dropped ?? (await drop(name));
      };
      return instance;
    });
    return { paused, release: () => release() };
  }

  /**
   * Whether `call` settles within a fixed number of event-loop turns. Every request
   * here answers at once, so a write that skips the queue on the view table settles
   * inside a few turns, while a queued one stays parked until `release()`. Counted in
   * turns rather than milliseconds, so the bound holds however loaded the machine is.
   */
  async function settlesUnqueued(call: Promise<unknown>, turns = 50): Promise<boolean> {
    let settled = false;
    call.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    for (let turn = 0; turn < turns && !settled; turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return settled;
  }

  it('lands both of two same-view spills whose swaps overlap on one supplied canvas', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const { canvasId, unranked } = await canvasWithBothViews(fake);
    // Whichever swap drops the view table first is held there until release().
    const { paused, release } = holdSwapDrop(fake, 'after');
    const call = () =>
      Promise.resolve(
        chemblGetBioactivities.handler(
          chemblGetBioactivities.input.parse({
            target_chembl_id: 'CHEMBL203',
            canvas_id: canvasId,
          }),
          ctx(),
        ),
      );
    const calls = [call(), call()];
    await paused;
    // Both spills have staged in full, so the other swap is due while the first is held.
    await vi.waitFor(() => {
      const staged = Object.entries(tablesOn(fake, canvasId)).filter(
        ([name, rows]) => name.includes('_staging_') && rows.length === 150,
      );
      expect(staged).toHaveLength(2);
    });
    // Unqueued, the other swap would land on the dropped name and settle, and the
    // held swap's copy would then be refused the name (register_as_clash).
    expect(await settlesUnqueued(Promise.race(calls))).toBe(false);
    release();
    const outcomes = await Promise.allSettled(calls);

    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(stagedIds(fake, canvasId)).toEqual(viewOrder(SPILL_ROWS));
    expect(tablesOn(fake, canvasId).bioactivities_null_potency).toEqual(unranked);
    expect(Object.keys(tablesOn(fake, canvasId)).sort()).toEqual([
      'bioactivities',
      'bioactivities_null_potency',
    ]);
  });

  it.each(['after', 'before'] as const)(
    'holds an inline re-stage arriving %s a swap drops the view table until the swap lands, then lands it',
    async (at) => {
      const fake = new FakeDataCanvas();
      setCanvas(fake.cast());
      const { canvasId, unranked } = await canvasWithBothViews(fake);
      const { paused, release } = holdSwapDrop(fake, at);
      const run = (target: string) =>
        Promise.resolve(
          chemblGetBioactivities.handler(
            chemblGetBioactivities.input.parse({ target_chembl_id: target, canvas_id: canvasId }),
            ctx(),
          ),
        );
      const spill = run('CHEMBL203');
      await paused;
      const fit = run('CHEMBL204');
      const fitSettledMidSwap = await settlesUnqueued(fit);
      release();
      const [spilled, fitted] = await Promise.allSettled([spill, fit]);

      // Unqueued, the fit's write lands inside the swap: the copy then refuses the
      // name the fit took (register_as_clash), or the swap's drop takes the fit's rows.
      expect(fitSettledMidSwap).toBe(false);
      expect(spilled).toMatchObject({
        status: 'fulfilled',
        value: { spilled: true, table_name: 'bioactivities', staged_row_count: 150 },
      });
      expect(fitted).toMatchObject({
        status: 'fulfilled',
        value: { spilled: false, table_name: 'bioactivities', staged_row_count: 3 },
      });
      // The later writer is the table, and nothing else on the canvas moved.
      expect(stagedIds(fake, canvasId)).toEqual([1300, 1301, 1302]);
      expect(tablesOn(fake, canvasId).bioactivities_null_potency).toEqual(unranked);
      expect(Object.keys(tablesOn(fake, canvasId)).sort()).toEqual([
        'bioactivities',
        'bioactivities_null_potency',
      ]);
    },
  );

  it('leaves the table to the swap before it when a re-stage is cancelled while it waits', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const { canvasId } = await canvasWithBothViews(fake);
    const { paused, release } = holdSwapDrop(fake, 'after');
    const controller = new AbortController();
    const spill = Promise.resolve(
      chemblGetBioactivities.handler(
        chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', canvas_id: canvasId }),
        ctx(),
      ),
    );
    await paused;
    const fit = Promise.resolve(
      chemblGetBioactivities.handler(
        chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL204', canvas_id: canvasId }),
        createMockContext({
          tenantId: 'default',
          errors: chemblGetBioactivities.errors,
          signal: controller.signal,
        }),
      ),
    ).catch((error: unknown) => error);
    // Parked behind the held swap, so the abort lands while the re-stage waits its turn.
    expect(await settlesUnqueued(fit)).toBe(false);
    controller.abort();
    release();
    const [fitted, spilled] = await Promise.allSettled([fit, spill]);

    expect(fitted).toMatchObject({ value: { name: 'AbortError' } });
    expect(spilled).toMatchObject({ value: { spilled: true, staged_row_count: 150 } });
    expect(stagedIds(fake, canvasId)).toEqual(viewOrder(SPILL_ROWS));
  });

  it('hands the turn on when the swap before a re-stage fails, so the re-stage still lands', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const { canvasId, unranked } = await canvasWithBothViews(fake);
    const { paused, release } = holdSwapDrop(fake, 'before');
    // The swap's copy is the next query the canvas sees; it fails after the drop.
    const engineFault = new McpError(JsonRpcErrorCode.DatabaseError, 'IO Error: disk full');
    fake.nextQueryError = engineFault;
    const run = (target: string) =>
      Promise.resolve(
        chemblGetBioactivities.handler(
          chemblGetBioactivities.input.parse({ target_chembl_id: target, canvas_id: canvasId }),
          ctx(),
        ),
      );
    const spill = run('CHEMBL203').catch((error: unknown) => error);
    await paused;
    const fit = run('CHEMBL204');
    // Queued behind the held swap before it fails, so the failure is what hands the turn on.
    expect(await settlesUnqueued(fit)).toBe(false);
    release();

    // The failure is the swap's own call's to report; the re-stage after it is unaffected.
    expect(await spill).toBe(engineFault);
    expect(await fit).toMatchObject({ table_name: 'bioactivities', staged_row_count: 3 });
    expect(tablesOn(fake, canvasId)).toEqual({
      bioactivities: expect.any(Array),
      bioactivities_null_potency: unranked,
    });
    expect(stagedIds(fake, canvasId)).toEqual([1300, 1301, 1302]);
  });

  it('returns the replaced table, logging the leftover, when dropping the staging table fails', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const { canvasId } = await canvasWithBothViews(fake);
    const acquire = fake.acquire.bind(fake);
    vi.spyOn(fake, 'acquire').mockImplementation(async (...args) => {
      const instance = await acquire(...args);
      const drop = instance.drop.bind(instance);
      instance.drop = (name) =>
        name.includes('_staging_') ? Promise.reject(new Error('drop failed')) : drop(name);
      return instance;
    });
    interruptPageAt(-1, () => undefined);
    const c = ctx();
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', canvas_id: canvasId }),
      c,
    );
    expect(result).toMatchObject({
      spilled: true,
      table_name: 'bioactivities',
      staged_row_count: 150,
    });
    expect(stagedIds(fake, canvasId)).toEqual(viewOrder(SPILL_ROWS));
    const leftover = Object.keys(tablesOn(fake, canvasId)).filter((name) =>
      name.includes('_staging_'),
    );
    expect(leftover).toHaveLength(1);
    const logged = (
      c.log as unknown as { calls: { level: string; data?: { tableName?: string } }[] }
    ).calls;
    expect(logged).toContainEqual(
      expect.objectContaining({
        level: 'warning',
        data: expect.objectContaining({ tableName: leftover[0] }),
      }),
    );
  });
});

describe('chembl_get_bioactivities — a canvas is minted only when the view spills (#28)', () => {
  const tenant = { tenantId: 'default' };
  const run = (input: Record<string, unknown>, c = ctx()) =>
    chemblGetBioactivities.handler(chemblGetBioactivities.input.parse(input), c);

  /** A spilling call that must succeed once the tenant has a free slot. */
  async function spillSucceeds(fake: FakeDataCanvas): Promise<void> {
    mockUpstream({
      honest: 26600,
      activities: Array.from({ length: 120 }, (_, i) => rawActivity(i)),
    });
    const spilled = await run({ target_chembl_id: 'CHEMBL203' });
    expect(spilled.spilled).toBe(true);
    expect(fake.countForTenant(tenant)).toBe(1);
    expect(tablesOn(fake, spilled.canvas_id ?? '')).toHaveProperty('bioactivities');
  }

  it('mints nothing for an inline fit, with no acquire and no extra request', async () => {
    const fake = new FakeDataCanvas({ maxCanvasesPerTenant: 1 });
    const acquire = vi.spyOn(fake, 'acquire');
    setCanvas(fake.cast());
    mockUpstream({ honest: 3, activities: Array.from({ length: 3 }, (_, i) => rawActivity(i)) });
    const result = await run({ target_chembl_id: 'CHEMBL203' });
    expect(result.spilled).toBe(false);
    expect(result.canvas_id).toBeNull();
    expect(acquire).not.toHaveBeenCalled();
    expect(fake.countForTenant(tenant)).toBe(0);
    // The honest count plus one view page — the fit costs no request it did not before.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await spillSucceeds(fake);
  });

  it('mints nothing for a zero-match call', async () => {
    const fake = new FakeDataCanvas({ maxCanvasesPerTenant: 1 });
    setCanvas(fake.cast());
    // The live pair CHEMBL4297214 × CHEMBL3137281 shape: nothing matches.
    mockPairUpstream({ molecule: 4, target: 9, both: 0 }, { rows: 0 });
    const result = await run({
      molecule_chembl_id: 'CHEMBL4297214',
      target_chembl_id: 'CHEMBL3137281',
      limit: 5,
    });
    expect(result.totalCount).toBe(0);
    expect(result.canvas_id).toBeNull();
    expect(fake.countForTenant(tenant)).toBe(0);
    await spillSucceeds(fake);
  });

  it('mints nothing when upstream fails before the view spills', async () => {
    const fake = new FakeDataCanvas({ maxCanvasesPerTenant: 1 });
    setCanvas(fake.cast());
    interruptPageAt(0, upstream404);
    await expect(Promise.resolve(run({ target_chembl_id: 'CHEMBL203' }))).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
    expect(fake.countForTenant(tenant)).toBe(0);
    initChemblService(getServerConfig());
    await spillSucceeds(fake);
  });

  it('releases the canvas it minted when upstream fails mid-spill, keeping the original error', async () => {
    const fake = new FakeDataCanvas({ maxCanvasesPerTenant: 1 });
    const drop = vi.spyOn(fake, 'drop');
    setCanvas(fake.cast());
    interruptPageAt(100, upstream404);
    await expect(Promise.resolve(run({ target_chembl_id: 'CHEMBL203' }))).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
    // The canvas was minted for the spill, then released once it held no table.
    expect(drop).toHaveBeenCalledTimes(1);
    expect(fake.countForTenant(tenant)).toBe(0);
    initChemblService(getServerConfig());
    await spillSucceeds(fake);
  });

  it('releases nothing and mints nothing when a call is cancelled before it spills', async () => {
    const fake = new FakeDataCanvas({ maxCanvasesPerTenant: 1 });
    setCanvas(fake.cast());
    const controller = new AbortController();
    interruptPageAt(50, () => {
      controller.abort();
      return;
    });
    const cancelled = createMockContext({
      tenantId: 'default',
      errors: chemblGetBioactivities.errors,
      signal: controller.signal,
    });
    await expect(
      Promise.resolve(run({ target_chembl_id: 'CHEMBL203' }, cancelled)),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.countForTenant(tenant)).toBe(0);
    initChemblService(getServerConfig());
    await spillSucceeds(fake);
  });

  it('releases the canvas it minted when a call is cancelled mid-spill', async () => {
    const fake = new FakeDataCanvas({ maxCanvasesPerTenant: 1 });
    setCanvas(fake.cast());
    const controller = new AbortController();
    /**
     * Cancel the moment the spill has minted its canvas. The walk requests its
     * pages ahead of the spill, so an abort keyed to a page request lands before
     * the mint and never reaches the release this test is for.
     */
    const acquire = fake.acquire.bind(fake);
    const minted = vi.spyOn(fake, 'acquire').mockImplementation(async (...args) => {
      const instance = await acquire(...args);
      controller.abort();
      return instance;
    });
    const drop = vi.spyOn(fake, 'drop');
    interruptPageAt(-1, () => undefined);
    const cancelled = createMockContext({
      tenantId: 'default',
      errors: chemblGetBioactivities.errors,
      signal: controller.signal,
    });
    // The cancellation propagates; releasing the canvas never turns it into a success.
    await expect(
      Promise.resolve(run({ target_chembl_id: 'CHEMBL203' }, cancelled)),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(minted).toHaveBeenCalledTimes(1);
    expect(drop).toHaveBeenCalledTimes(1);
    expect(fake.countForTenant(tenant)).toBe(0);
    minted.mockRestore();
    initChemblService(getServerConfig());
    await spillSucceeds(fake);
  });

  it('propagates the original failure when releasing the minted canvas fails too', async () => {
    const fake = new FakeDataCanvas();
    const drop = vi.spyOn(fake, 'drop').mockRejectedValue(new Error('release failed'));
    setCanvas(fake.cast());
    interruptPageAt(100, upstream404);
    await expect(Promise.resolve(run({ target_chembl_id: 'CHEMBL203' }))).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
    // The release was attempted; its own failure did not replace the upstream error.
    expect(drop).toHaveBeenCalledTimes(1);
  });

  it('answers an inline fit without canvas_id while the tenant sits at its cap', async () => {
    const fake = new FakeDataCanvas({ maxCanvasesPerTenant: 1 });
    setCanvas(fake.cast());
    await fake.acquire(undefined, tenant);
    mockUpstream({ honest: 3, activities: Array.from({ length: 3 }, (_, i) => rawActivity(i)) });
    const result = await run({ target_chembl_id: 'CHEMBL203' });
    expect(result.spilled).toBe(false);
    expect(result.activities).toHaveLength(3);
    expect(fake.countForTenant(tenant)).toBe(1);
  });
});

describe('chembl_get_bioactivities — canvas_capacity_exhausted (#28)', () => {
  /** A spill against a tenant already holding its one allowed canvas. */
  async function spillAtCap() {
    const fake = new FakeDataCanvas({ maxCanvasesPerTenant: 1 });
    setCanvas(fake.cast());
    await fake.acquire(undefined, { tenantId: 'default' });
    mockUpstream({
      honest: 26600,
      activities: Array.from({ length: 120 }, (_, i) => rawActivity(i)),
    });
    return fake;
  }

  it('declares the reason as a retryable RateLimited failure whose recovery names no drop tool', () => {
    const entry = chemblGetBioactivities.errors?.find(
      (e) => e.reason === 'canvas_capacity_exhausted',
    );
    expect(entry).toMatchObject({ code: JsonRpcErrorCode.RateLimited, retryable: true });
    expect(entry?.recovery).toContain('canvas_id');
    // Staging on an earlier canvas costs that canvas its table for the same view.
    expect(entry?.recovery).toContain('replacing its table for the same potency_view');
    expect(entry?.recovery).toMatch(/narrow/i);
    expect(entry?.recovery).not.toMatch(/drop/i);
  });

  it('re-raises the refusal with the framework failure on cause and cap / activeCount in data', async () => {
    const fake = await spillAtCap();
    const err: unknown = await Promise.resolve(
      chemblGetBioactivities.handler(
        chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203' }),
        ctx(),
      ),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.RateLimited);
    expect((err as McpError).data).toMatchObject({
      reason: 'canvas_capacity_exhausted',
      retryable: true,
      cap: 1,
      activeCount: 1,
    });
    // The framework's hint — which offers a drop tool — rides only on cause, never the wire.
    expect((err as McpError).data).not.toHaveProperty('recovery');
    const cause = (err as McpError).cause as McpError;
    expect(cause).toBeInstanceOf(McpError);
    expect(cause.data).toMatchObject({ reason: 'canvas_capacity_exhausted' });
    expect(fake.countForTenant({ tenantId: 'default' })).toBe(1);
  });

  it('carries the reason, retryable, and a drop-free recovery on both surfaces', async () => {
    await spillAtCap();
    const result = await runToolContract(
      chemblGetBioactivities,
      { target_chembl_id: 'CHEMBL203' },
      { context: { tenantId: 'default' } },
    );
    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as { error: { code: number; data: Record<string, unknown> } }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({
      reason: 'canvas_capacity_exhausted',
      retryable: true,
      cap: 1,
      activeCount: 1,
    });
    const hint = (error.data.recovery as { hint: string }).hint;
    expect(hint).toContain('canvas_id');
    expect(hint).toContain('replacing its table for the same potency_view');
    expect(hint).not.toMatch(/drop/i);

    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain(`Recovery: ${hint}`);
    expect(text).toContain('reason canvas_capacity_exhausted · retryable');
    expect(text).not.toMatch(/drop/i);
  });
});

describe('chembl_get_bioactivities — a supplied canvas_id re-stages the view (#31)', () => {
  const run = (input: Record<string, unknown>, c = ctx()) =>
    chemblGetBioactivities.handler(chemblGetBioactivities.input.parse(input), c);

  /** Both client surfaces, through the production contract boundary. */
  async function contract(input: Record<string, unknown>) {
    const result = await runToolContract(chemblGetBioactivities, input, {
      context: { tenantId: 'default' },
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    return { structured: result.structuredContent as Record<string, unknown>, text };
  }

  /** Step 2 of the issue: a broad query spills and hands back a canvas_id. */
  async function spillFirst(fake: FakeDataCanvas): Promise<string> {
    setCanvas(fake.cast());
    mockUpstream({
      honest: 26600,
      activities: Array.from({ length: 120 }, (_, i) => rawActivity(i)),
    });
    const first = await run({ target_chembl_id: 'CHEMBL203', standard_type: 'IC50' });
    expect(first.spilled).toBe(true);
    expect(tablesOn(fake, first.canvas_id ?? '').bioactivities).toHaveLength(120);
    return first.canvas_id as string;
  }

  /** Three rows, as `pchembl_value_min: 11` narrows CHEMBL203 IC50 to. */
  const NARROW = Array.from({ length: 3 }, (_, i) => rawActivity(200 + i));

  it('replaces the view table with exactly the inline-fit rows and names it', async () => {
    const fake = new FakeDataCanvas();
    const canvasId = await spillFirst(fake);
    mockUpstream({ honest: 3, activities: NARROW });
    const result = await run({
      target_chembl_id: 'CHEMBL203',
      standard_type: 'IC50',
      pchembl_value_min: 11,
      canvas_id: canvasId,
    });

    expect(result.spilled).toBe(false);
    expect(result.canvas_id).toBe(canvasId);
    expect(result.table_name).toBe('bioactivities');
    expect(result.staged_row_count).toBe(3);
    expect(result.truncated).toBe(false);
    const staged = tablesOn(fake, canvasId).bioactivities as { activity_id: number }[];
    expect(staged.map((row) => row.activity_id)).toEqual([1200, 1201, 1202]);
    expect(result).toEqual(expect.schemaMatching(chemblGetBioactivities.output));
  });

  it('says on both surfaces that the inline fit was staged, and where', async () => {
    const fake = new FakeDataCanvas();
    const canvasId = await spillFirst(fake);
    mockUpstream({ honest: 3, activities: NARROW });
    const { structured, text } = await contract({
      target_chembl_id: 'CHEMBL203',
      canvas_id: canvasId,
    });
    expect(structured).toMatchObject({
      spilled: false,
      canvas_id: canvasId,
      table_name: 'bioactivities',
      staged_row_count: 3,
      truncated: false,
    });
    const notice = (structured as { notice?: string }).notice ?? '';
    expect(notice).toContain(`"bioactivities" on canvas ${canvasId}`);
    expect(notice).toContain('fit inline');
    expect(notice).toContain('chembl_dataframe_describe');
    // content[]: the spill line must not read as "nothing staged".
    expect(text).toContain('spilled: no');
    expect(text).toContain(`\`${canvasId}\``);
    expect(text).toContain('`bioactivities`');
    expect(text).toContain('staged_row_count: 3');
    expect(text).not.toContain('nothing staged');
    expect(text).toContain('truncated: no');
  });

  it('stages the whole fit view, not just the limit-capped preview', async () => {
    const fake = new FakeDataCanvas();
    const canvasId = await spillFirst(fake);
    mockUpstream({ honest: 40, activities: Array.from({ length: 40 }, (_, i) => rawActivity(i)) });
    const c = ctx();
    const result = await run({ target_chembl_id: 'CHEMBL203', limit: 2, canvas_id: canvasId }, c);
    expect(result.activities).toHaveLength(2);
    expect(result.staged_row_count).toBe(40);
    expect(tablesOn(fake, canvasId).bioactivities).toHaveLength(40);
    // The rows past limit are on the table, so the notice says that — not "raise limit".
    expect(enrichmentOf(c).notice).toContain('Showing 2 of the 40 rows');
    expect(enrichmentOf(c).notice).not.toContain('raise limit');
  });

  it('empties the view table on a zero-match re-query, keeping the declared schema', async () => {
    const fake = new FakeDataCanvas();
    const canvasId = await spillFirst(fake);
    mockUpstream({ honest: 0, activities: [] });
    const c = ctx();
    const result = await run({ target_chembl_id: 'CHEMBL203', canvas_id: canvasId }, c);

    expect(result.activities).toEqual([]);
    expect(result.canvas_id).toBe(canvasId);
    expect(result.table_name).toBe('bioactivities');
    expect(result.staged_row_count).toBe(0);
    const table = fake.canvases.get(canvasId)?.tables.get('bioactivities');
    expect(table?.rows).toEqual([]);
    // An empty table still carries every column at its declared type, so SQL keeps working.
    expect(table?.columns).toHaveLength(18);
    expect(table?.columns.find((col) => col.name === 'pchembl_value')?.type).toBe('DOUBLE');
    expect(table?.columns.find((col) => col.name === 'activity_id')?.type).toBe('BIGINT');

    const notice = enrichmentOf(c).notice ?? '';
    expect(notice).toContain('No measurements matched');
    expect(notice).toContain(`"bioactivities" on canvas ${canvasId}`);
    const text = (chemblGetBioactivities.format!(result)[0] as { text: string }).text;
    expect(text).toContain('staged_row_count: 0');
    expect(text).toContain('No rows in preview');
  });

  it('leaves the other view table untouched, so both still UNION ALL cleanly', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    mockUpstream({
      honest: 4087,
      potent: 3929,
      activities: Array.from({ length: 120 }, (_, i) => rawNullActivity(i)),
    });
    const nullView = await run({ molecule_chembl_id: 'CHEMBL25', potency_view: 'null_potency' });
    const canvasId = nullView.canvas_id as string;
    const unranked = tablesOn(fake, canvasId).bioactivities_null_potency;

    mockUpstream({ honest: 4087, potent: 3, activities: NARROW });
    const ranked = await run({ molecule_chembl_id: 'CHEMBL25', canvas_id: canvasId });
    expect(ranked.table_name).toBe('bioactivities');

    const tables = fake.canvases.get(canvasId)?.tables;
    expect(tables?.get('bioactivities_null_potency')?.rows).toBe(unranked);
    expect(tables?.get('bioactivities')?.rows).toHaveLength(3);
    // Same columns, same order, same types: a UNION ALL over the pair lines up.
    expect(tables?.get('bioactivities')?.columns).toEqual(
      tables?.get('bioactivities_null_potency')?.columns,
    );
  });
});

describe('chembl_get_bioactivities — upstream page drain', () => {
  it('stages each tied measurement once when tie groups cross page boundaries (#32)', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    // Two 20-row ties at 8.00 and 7.00, each straddling a 50-row page edge.
    const potency = (i: number): string =>
      i < 40
        ? (9.5 - i / 100).toFixed(2)
        : i < 60
          ? '8.00'
          : i < 90
            ? (7.9 - (i - 60) / 100).toFixed(2)
            : i < 110
              ? '7.00'
              : (6.9 - (i - 110) / 100).toFixed(2);
    const rows = Array.from({ length: 150 }, (_, i) => ({
      ...rawActivity(i),
      pchembl_value: potency(i),
    }));
    mockPagedUpstream({ honest: 400, rows, pageSize: 50 });
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({
        target_chembl_id: 'CHEMBL203',
        pchembl_value_min: 6,
        limit: 25,
      }),
      ctx(),
    );

    expect(result.spilled).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.staged_row_count).toBe(150);
    const staged = fake.canvases.get(result.canvas_id ?? '')?.tables.get('bioactivities')?.rows;
    const ids = (staged ?? []).map((row) => row.activity_id);
    expect(ids).toHaveLength(150);
    expect(new Set(ids).size).toBe(150);
    // The preview still leads with the most potent measurement.
    expect(result.activities[0]?.pchembl_value).toBe(9.5);
    for (const params of viewRequests(fetchMock.mock.calls)) {
      expect(params.getAll('order_by')).toEqual(['-pchembl_value', 'activity_id']);
    }
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

/**
 * 500 ranked rows in tie groups of seven, so ties straddle every 50-row page edge
 * and only the `activity_id` tie-break fixes their order across pages.
 */
const TIED_ROWS = Array.from({ length: 500 }, (_, i) => ({
  ...rawActivity(i),
  pchembl_value: (9 - Math.floor(i / 7) / 20).toFixed(2),
}));

/** The view's total order: most potent first, ascending `activity_id` within a tie. */
function viewOrder(rows: Record<string, unknown>[]): number[] {
  return [...rows]
    .sort(
      (a, b) =>
        Number(b.pchembl_value) - Number(a.pchembl_value) ||
        Number(a.activity_id) - Number(b.activity_id),
    )
    .map((row) => Number(row.activity_id));
}

/**
 * Serve `rows` as a view of 50-row pages, walked by a service whose page limiter
 * admits `concurrency` requests (CHEMBL_MAX_CONCURRENT_PAGES). Returns the
 * corpus's traffic counters.
 */
function spillCorpus(
  opts: Omit<ActivityCorpusOptions, 'traffic'> & { concurrency?: number },
): CorpusTraffic {
  const { concurrency = 4, ...corpus } = opts;
  const traffic = corpusTraffic();
  initChemblService({ ...getServerConfig(), maxPageSize: 50, maxConcurrentPages: concurrency });
  fetchMock.mockImplementation(activityCorpus({ ...corpus, traffic }));
  return traffic;
}

/**
 * Set CHEMBL_SPILL_DEADLINE_MS for the rest of the test. The tool reads it from the
 * server config on every call; at its 45 s default it equals the per-call budget an
 * unspilled call gets, so only another value shows which budget a request drew on.
 */
function useSpillDeadline(ms: number): void {
  const config = getServerConfig();
  const original = config.spillDeadlineMs;
  config.spillDeadlineMs = ms;
  onTestFinished(() => {
    config.spillDeadlineMs = original;
  });
}

/** The offsets of every view request, in the order they were sent. */
function requestedOffsets(): number[] {
  return viewRequests(fetchMock.mock.calls).map((params) => Number(params.get('offset')));
}

/** The `activity_id`s of a canvas table, in staged order. */
function stagedIds(fake: FakeDataCanvas, canvasId: string | null, table = 'bioactivities') {
  return (fake.canvases.get(canvasId ?? '')?.tables.get(table)?.rows ?? []).map((row) =>
    Number(row.activity_id),
  );
}

/**
 * Drive fake timers until `promise` settles, returning its outcome and the
 * virtual milliseconds it took. Gives up past `limitMs` of virtual time.
 */
async function settleUnderFakeTimers<T>(
  promise: Promise<T>,
  limitMs = 300_000,
): Promise<{ value?: T; error?: unknown; elapsedMs: number }> {
  const startedAt = Date.now();
  let outcome: { value?: T; error?: unknown } | undefined;
  promise.then(
    (value) => {
      outcome = { value };
    },
    (error: unknown) => {
      outcome = { error };
    },
  );
  while (!outcome && Date.now() - startedAt < limitMs) {
    await vi.advanceTimersByTimeAsync(250);
  }
  return { ...outcome, elapsedMs: Date.now() - startedAt };
}

describe('chembl_get_bioactivities — concurrent spill walk (#16)', () => {
  const run = (input: Record<string, unknown>, c = ctx()) =>
    Promise.resolve(chemblGetBioactivities.handler(chemblGetBioactivities.input.parse(input), c));

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stages a multi-page view whole, in offset order, while its pages land out of order', async () => {
    vi.useFakeTimers();
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    // Later pages answer sooner, so the window completes out of order.
    spillCorpus({ honest: 900, rows: TIED_ROWS, latencyMs: (offset) => 40 - offset / 50 });
    const corpus = fetchMock.getMockImplementation() as ReturnType<typeof activityCorpus>;
    const landed: number[] = [];
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const response = await corpus(input, init);
      const params = new URL(String(input)).searchParams;
      if (params.has('order_by')) landed.push(Number(params.get('offset')));
      return response;
    });
    const { value: result } = await settleUnderFakeTimers(
      run({ target_chembl_id: 'CHEMBL203', limit: 25 }),
    );
    if (!result) throw new Error('The spill did not settle.');

    // The precondition: some page answered before a page ahead of it in the view.
    expect(landed).not.toEqual([...landed].sort((a, b) => a - b));
    const expected = viewOrder(TIED_ROWS);
    expect(result.spilled).toBe(true);
    expect(result.staged_row_count).toBe(500);
    expect(result.truncated).toBe(false);
    expect(stagedIds(fake, result.canvas_id)).toEqual(expected);
    // The preview is the head of the same order a sequential walk returns.
    expect(result.activities.map((a) => a.activity_id)).toEqual(expected.slice(0, 25));
    // Every page once, and nothing at or past the view total.
    expect(requestedOffsets().sort((a, b) => a - b)).toEqual(
      Array.from({ length: 10 }, (_, page) => page * 50),
    );
  });

  it('reports truncated_by: null when the view stages whole', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    spillCorpus({ honest: 900, rows: TIED_ROWS });
    const result = await run({ target_chembl_id: 'CHEMBL203' });
    expect(result.truncated).toBe(false);
    expect(result.truncated_by).toBeNull();
    const text = (chemblGetBioactivities.format!(result)[0] as { text: string }).text;
    expect(text).toContain('truncated: no');
  });

  it.each([1, 4])(
    'holds two simultaneous spills to %i page requests in flight between them',
    async (concurrency) => {
      const fake = new FakeDataCanvas();
      setCanvas(fake.cast());
      const traffic = spillCorpus({ honest: 900, rows: TIED_ROWS, latencyMs: 5, concurrency });
      const [first, second] = await Promise.all([
        run({ target_chembl_id: 'CHEMBL203' }),
        run({ target_chembl_id: 'CHEMBL204' }),
      ]);
      // The shared limiter binds across both calls — and is used up to its cap.
      expect(traffic.maxInFlight).toBe(concurrency);
      expect(first.staged_row_count).toBe(500);
      expect(second.staged_row_count).toBe(500);
      expect(stagedIds(fake, first.canvas_id)).toEqual(viewOrder(TIED_ROWS));
      expect(stagedIds(fake, second.canvas_id)).toEqual(viewOrder(TIED_ROWS));
    },
  );

  it('stages the pages before a stall that outlasts the deadline, even when later pages completed', async () => {
    vi.useFakeTimers();
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    // The page at offset 150 (k = 3) never answers; the window still fetches past it.
    spillCorpus({ honest: 900, rows: TIED_ROWS, stallAt: [150] });
    const c = ctx();
    const {
      value: result,
      error,
      elapsedMs,
    } = await settleUnderFakeTimers(run({ target_chembl_id: 'CHEMBL203', limit: 25 }, c));

    expect(error).toBeUndefined();
    // Settles at the 45 s default deadline, inside a client's 60 s request timeout.
    expect(elapsedMs).toBeGreaterThanOrEqual(45_000);
    expect(elapsedMs).toBeLessThan(60_000);
    expect(result?.spilled).toBe(true);
    expect(result?.truncated).toBe(true);
    expect(result?.truncated_by).toBe('time_budget');
    expect(result?.staged_row_count).toBe(150);
    expect(stagedIds(fake, result?.canvas_id ?? null)).toEqual(viewOrder(TIED_ROWS).slice(0, 150));
    // Pages past the stall were requested and answered, and none of them staged.
    expect(requestedOffsets()).toEqual(expect.arrayContaining([200, 250, 300]));

    const notice = enrichmentOf(c).notice ?? '';
    expect(notice).toContain('CHEMBL_SPILL_DEADLINE_MS=45000');
    expect(notice).toContain('150 of the 500 rows');
    const text = (chemblGetBioactivities.format!(result!)[0] as { text: string }).text;
    expect(text).toContain('truncated: yes');
    expect(text).toContain('time_budget');
    expect(text).toContain('CHEMBL_SPILL_DEADLINE_MS');
  });

  it('carries the time-budget truncation through the output contract on both surfaces', async () => {
    vi.useFakeTimers();
    setCanvas(new FakeDataCanvas().cast());
    spillCorpus({ honest: 900, rows: TIED_ROWS, stallAt: [100] });
    const { value } = await settleUnderFakeTimers(
      runToolContract(chemblGetBioactivities, { target_chembl_id: 'CHEMBL203' }),
    );
    expect(value?.isError).toBeFalsy();
    expect(value?.structuredContent).toMatchObject({
      truncated: true,
      truncated_by: 'time_budget',
      staged_row_count: 100,
    });
    const text = (value?.content ?? []).map((block) => (block.type === 'text' ? block.text : ''));
    expect(text.join('\n')).toContain('time_budget');
    expect(text.join('\n')).toContain('CHEMBL_SPILL_DEADLINE_MS=45000');
  });

  it('ends the spill once the budget would not hold another page, naming the budget on both surfaces', async () => {
    vi.useFakeTimers();
    useSpillDeadline(10_000);
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    /**
     * Every page takes 4 s, four at a time, under a 10 s budget: page 0 lands at 4 s
     * and the four after it at 8 s, when the 2 s left would not hold another page.
     */
    const traffic = spillCorpus({ honest: 900, rows: TIED_ROWS, latencyMs: 4_000 });
    const { value, elapsedMs } = await settleUnderFakeTimers(
      runToolContract(chemblGetBioactivities, { target_chembl_id: 'CHEMBL203' }),
    );

    expect(value?.isError).toBeFalsy();
    const structured = value?.structuredContent as { canvas_id?: string; notice?: string };
    expect(structured).toMatchObject({
      spilled: true,
      truncated: true,
      truncated_by: 'time_budget',
      staged_row_count: 250,
    });
    expect(stagedIds(fake, structured.canvas_id ?? null)).toEqual(
      viewOrder(TIED_ROWS).slice(0, 250),
    );
    // Five pages sent, none abandoned, and the call settles before the budget expires.
    expect(requestedOffsets()).toEqual([0, 50, 100, 150, 200]);
    expect(traffic.aborted).toBe(0);
    expect(elapsedMs).toBeLessThan(10_000);

    const ended = 'the time budget (CHEMBL_SPILL_DEADLINE_MS=10000) ended the page walk';
    expect(structured.notice).toContain(ended);
    const text = (value?.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain(ended);
    expect(text).toContain(
      'truncated: yes (truncated_by: time_budget) — the time budget (CHEMBL_SPILL_DEADLINE_MS) ended the page walk',
    );
    // The walk stopped with budget to spare, so nothing may say the budget ran out.
    expect(`${structured.notice}\n${text}`).not.toContain('ran out');
  });

  it('stages the prefix as time_budget when the budget cuts the retries of a failing page short', async () => {
    vi.useFakeTimers();
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    /**
     * The page at offset 150 answers HTTP 500 21 s into every attempt. The second
     * attempt fails 43.1–43.9 s in, where the next backoff (2250–3750 ms) would
     * outlast the 45 s budget, so the ladder stops before the deadline expires.
     */
    spillCorpus({
      honest: 900,
      rows: TIED_ROWS,
      failAt: { offset: 150, status: 500 },
      latencyMs: (offset) => (offset === 150 ? 21_000 : 0),
    });
    const { value, elapsedMs } = await settleUnderFakeTimers(
      runToolContract(chemblGetBioactivities, { target_chembl_id: 'CHEMBL203' }),
    );

    expect(value?.isError).toBeFalsy();
    expect(value?.structuredContent).toMatchObject({
      spilled: true,
      truncated: true,
      truncated_by: 'time_budget',
      staged_row_count: 150,
    });
    const canvasId = (value?.structuredContent as { canvas_id?: string } | undefined)?.canvas_id;
    expect(stagedIds(fake, canvasId ?? null)).toEqual(viewOrder(TIED_ROWS).slice(0, 150));
    expect(elapsedMs).toBeLessThan(45_000);
    expect(requestedOffsets().filter((offset) => offset === 150)).toHaveLength(2);
    const text = (value?.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain('truncated: yes (truncated_by: time_budget)');
    expect(text).toContain('150 of the 500 rows');
    expect(text).toContain('CHEMBL_SPILL_DEADLINE_MS=45000');
  });

  it('fails as upstream_timeout, minting nothing, when the first page outlasts the deadline', async () => {
    vi.useFakeTimers();
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    spillCorpus({ honest: 900, rows: TIED_ROWS, stallAt: [0] });
    const { error, elapsedMs } = await settleUnderFakeTimers(
      run({ target_chembl_id: 'CHEMBL203' }),
    );
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'upstream_timeout' },
    });
    expect(elapsedMs).toBeLessThan(60_000);
    expect(fake.countForTenant({ tenantId: 'default' })).toBe(0);
    // Nothing past the stalled first page was requested.
    expect(new Set(requestedOffsets())).toEqual(new Set([0]));
  });

  it('holds the count to the same deadline, requesting no page after it', async () => {
    vi.useFakeTimers();
    useSpillDeadline(20_000);
    setCanvas(new FakeDataCanvas().cast());
    spillCorpus({ honest: 900, rows: TIED_ROWS, stallCount: true });
    const { error, elapsedMs } = await settleUnderFakeTimers(
      run({ target_chembl_id: 'CHEMBL203' }),
    );
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'upstream_timeout' },
    });
    // The count spends the spill's CHEMBL_SPILL_DEADLINE_MS, not a 45 s budget of its own.
    expect(elapsedMs).toBeGreaterThanOrEqual(20_000);
    expect(elapsedMs).toBeLessThan(25_000);
    expect(requestedOffsets()).toEqual([]);
  });

  it('fails the call on a page that fails after retries, cancelling the rest and starting none', async () => {
    vi.useFakeTimers();
    setCanvas(new FakeDataCanvas().cast());
    /**
     * 503 at offset 150 on every attempt, its retries spent ~10.5 s in (13.2 s at
     * most with jitter), while the walk still waits on the page at offset 50 (20 s)
     * and the page at 200 (40 s) is in flight behind it. The failure ends the walk
     * when it lands, not once the walk reaches offset 150.
     */
    const traffic = spillCorpus({
      honest: 900,
      rows: TIED_ROWS,
      failAt: { offset: 150, status: 503 },
      latencyMs: (offset) => (offset === 50 ? 20_000 : offset === 200 ? 40_000 : 0),
    });
    const { error, elapsedMs } = await settleUnderFakeTimers(
      run({ target_chembl_id: 'CHEMBL203' }),
    );

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable' },
    });
    expect(JSON.stringify((error as McpError).data)).not.toContain('upstream failure');
    expect(requestedOffsets().filter((offset) => offset === 150)).toHaveLength(4);
    // Both pages still in flight — the one ahead of the failure and the one behind it — were aborted.
    expect(elapsedMs).toBeLessThan(20_000);
    expect(traffic.aborted).toBe(2);
    expect(traffic.inFlight).toBe(0);
    // No request starts once the walk gave up, however long time runs on.
    const sentByFailure = requestedOffsets().length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(requestedOffsets()).toHaveLength(sentByFailure);
  });

  it('aborts its pages in flight when the tenant cap refuses the spill a canvas', async () => {
    vi.useFakeTimers();
    const fake = new FakeDataCanvas({ maxCanvasesPerTenant: 1 });
    setCanvas(fake.cast());
    await fake.acquire(undefined, { tenantId: 'default' });
    // The view overflows the preview within its first three pages; the pages behind them never answer.
    const traffic = spillCorpus({ honest: 900, rows: TIED_ROWS, stallAt: [150, 200, 250, 300] });
    const { error, elapsedMs } = await settleUnderFakeTimers(
      run({ target_chembl_id: 'CHEMBL203' }),
    );

    expect(error).toMatchObject({ data: { reason: 'canvas_capacity_exhausted' } });
    // The refusal ends the call at once, and the walk's stalled pages are released with it.
    expect(elapsedMs).toBeLessThan(1_000);
    expect(traffic.aborted).toBeGreaterThan(0);
    expect(traffic.inFlight).toBe(0);
    expect(fake.countForTenant({ tenantId: 'default' })).toBe(1);
  });

  it('reports a caller abort before the deadline as cancelled, never as a deadline partial', async () => {
    vi.useFakeTimers();
    setCanvas(new FakeDataCanvas().cast());
    spillCorpus({ honest: 900, rows: TIED_ROWS, stallAt: [150] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 44_000);
    const { value, elapsedMs } = await settleUnderFakeTimers(
      runToolContract(
        chemblGetBioactivities,
        { target_chembl_id: 'CHEMBL203' },
        { context: { tenantId: 'default', signal: controller.signal } },
      ),
    );
    expect(elapsedMs).toBeLessThan(45_000);
    expect(value?.isError).toBe(true);
    expect(value?.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
  });

  it('surfaces the caller abort itself from the handler, mid-request or mid-backoff', async () => {
    vi.useFakeTimers();
    setCanvas(new FakeDataCanvas().cast());
    for (const [corpus, abortAtMs] of [
      [{ stallAt: [150] }, 10_000],
      [{ failAt: { offset: 150, status: 503 } }, 1_000],
    ] as const) {
      spillCorpus({ honest: 900, rows: TIED_ROWS, ...corpus });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), abortAtMs);
      const cancelled = createMockContext({
        tenantId: 'default',
        errors: chemblGetBioactivities.errors,
        signal: controller.signal,
      });
      const { error, elapsedMs } = await settleUnderFakeTimers(
        run({ target_chembl_id: 'CHEMBL203' }, cancelled),
      );
      expect(error).toMatchObject({ name: 'AbortError' });
      expect(elapsedMs).toBeLessThan(abortAtMs + 1_000);
    }
  });

  it('drops a cancelled call from the limiter queue without sending its page', async () => {
    vi.useFakeTimers();
    setCanvas(new FakeDataCanvas().cast());
    spillCorpus({ honest: 900, rows: TIED_ROWS, latencyMs: 1_000, concurrency: 1 });
    const queued = new AbortController();
    const waiting = createMockContext({
      tenantId: 'default',
      errors: chemblGetBioactivities.errors,
      signal: queued.signal,
    });
    const first = settleUnderFakeTimers(run({ target_chembl_id: 'CHEMBL203' }));
    // The second call's first page waits behind the first call's page in the limiter.
    const second = run({ molecule_chembl_id: 'CHEMBL25' }, waiting).catch(
      (error: unknown) => error,
    );
    setTimeout(() => queued.abort(), 500);
    const { value } = await first;
    expect(await second).toMatchObject({ name: 'AbortError' });
    expect(value?.staged_row_count).toBe(500);
    // Ten pages for the first call, none for the cancelled one.
    expect(viewRequests(fetchMock.mock.calls).filter((p) => p.has('molecule_chembl_id'))).toEqual(
      [],
    );
  });

  it('notes the time budget when the deadline cuts an inline fit short', async () => {
    vi.useFakeTimers();
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    // One 50-row page arrives, then the view stalls: the fetched rows fit inline.
    spillCorpus({ honest: 900, rows: TIED_ROWS, stallAt: [50] });
    const c = ctx();
    const { value: result } = await settleUnderFakeTimers(
      run({ target_chembl_id: 'CHEMBL203', limit: 25 }, c),
    );
    expect(result?.spilled).toBe(false);
    expect(result?.canvas_id).toBeNull();
    expect(result?.truncated).toBe(false);
    expect(result?.truncated_by).toBeNull();
    expect(fake.countForTenant({ tenantId: 'default' })).toBe(0);
    const notice = enrichmentOf(c).notice ?? '';
    expect(notice).toContain('CHEMBL_SPILL_DEADLINE_MS=45000');
    expect(notice).toContain('50 of the 500 rows');
    expect(notice).not.toContain('raise limit');
    // Nothing was staged, so a cursor reaches the rows past this page (#17).
    expect(notice).toContain('pass nextCursor back as cursor');
    const nextCursor = result?.nextCursor as string;
    expect(decodeCursor(nextCursor, createMockContext({}))).toMatchObject({ offset: 25 });

    // The cursor page resumes the view where the cut-short fit's page ended.
    const { value: page } = await settleUnderFakeTimers(
      run({ target_chembl_id: 'CHEMBL203', limit: 25, cursor: nextCursor }),
    );
    expect(page?.activities.map((a) => a.activity_id)).toEqual(viewOrder(TIED_ROWS).slice(25, 50));
    expect(decodeCursor(page?.nextCursor as string, createMockContext({}))).toMatchObject({
      offset: 50,
    });
    expect(fake.countForTenant({ tenantId: 'default' })).toBe(0);
  });

  it('names the budget that ended an inline fit short on both surfaces, before it expired', async () => {
    vi.useFakeTimers();
    useSpillDeadline(10_000);
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    // Page 0 takes 6 s of a 10 s budget, and the 4 s left would not hold another page like it.
    spillCorpus({
      honest: 900,
      rows: TIED_ROWS,
      latencyMs: (offset) => (offset === 0 ? 6_000 : 0),
    });
    const { value, elapsedMs } = await settleUnderFakeTimers(
      runToolContract(chemblGetBioactivities, { target_chembl_id: 'CHEMBL203', limit: 25 }),
    );

    expect(value?.isError).toBeFalsy();
    const structured = value?.structuredContent as { notice?: string; nextCursor?: string };
    // The one fetched page fit inline with no canvas_id, so nothing was staged.
    expect(structured).toMatchObject({ spilled: false, canvas_id: null, truncated: false });
    expect(fake.countForTenant({ tenantId: 'default' })).toBe(0);
    expect(requestedOffsets()).toEqual([0]);
    expect(elapsedMs).toBeLessThan(10_000);

    const ended =
      'The time budget (CHEMBL_SPILL_DEADLINE_MS=10000) ended the page walk after 50 of the 500 rows in this view, so nothing was staged';
    expect(structured.notice).toContain(ended);
    const text = (value?.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain(ended);
    expect(`${structured.notice}\n${text}`).not.toContain('ran out');
    expect(decodeCursor(structured.nextCursor as string, createMockContext({}))).toMatchObject({
      offset: 25,
    });
  });

  it('marks a deadline-cut inline fit re-staged on a supplied canvas as truncated by the time budget', async () => {
    vi.useFakeTimers();
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const existing = await fake.acquire(undefined, { tenantId: 'default' });
    spillCorpus({ honest: 900, rows: TIED_ROWS, stallAt: [50] });
    const { value: result } = await settleUnderFakeTimers(
      run({ target_chembl_id: 'CHEMBL203', canvas_id: existing.canvasId }),
    );
    expect(result?.spilled).toBe(false);
    expect(result?.staged_row_count).toBe(50);
    expect(result?.truncated).toBe(true);
    expect(result?.truncated_by).toBe('time_budget');
    expect(stagedIds(fake, existing.canvasId)).toEqual(viewOrder(TIED_ROWS).slice(0, 50));
  });
});

describe('chembl_get_bioactivities — one budget for an inline page (#33)', () => {
  const run = (input: Record<string, unknown>) =>
    Promise.resolve(
      chemblGetBioactivities.handler(chemblGetBioactivities.input.parse(input), ctx()),
    );

  beforeEach(() => {
    vi.useFakeTimers();
    setCanvas(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails a stalled count inside the budget without requesting the page', async () => {
    spillCorpus({ honest: 900, rows: TIED_ROWS, stallCount: true });
    const { error, elapsedMs } = await settleUnderFakeTimers(
      run({ target_chembl_id: 'CHEMBL203' }),
    );
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'upstream_timeout' },
    });
    expect(elapsedMs).toBeLessThan(60_000);
    expect(requestedOffsets()).toEqual([]);
  });

  it('gives the page only what the count left of the budget', async () => {
    // The count answers after 40 s; the page then never answers.
    spillCorpus({ honest: 900, rows: TIED_ROWS, stallAt: [0] });
    const corpus = fetchMock.getMockImplementation() as ReturnType<typeof activityCorpus>;
    const pageStarts: number[] = [];
    const startedAt = Date.now();
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      if (!input.includes('order_by=')) {
        return new Promise((resolve) => setTimeout(() => resolve(corpus(input, init)), 40_000));
      }
      pageStarts.push(Date.now() - startedAt);
      return corpus(input, init);
    });
    const { error, elapsedMs } = await settleUnderFakeTimers(
      run({ target_chembl_id: 'CHEMBL203' }),
    );
    expect(error).toMatchObject({ data: { reason: 'upstream_timeout' } });
    expect(elapsedMs).toBeLessThan(60_000);
    expect(pageStarts.length).toBeGreaterThan(0);
    expect(Math.max(...pageStarts)).toBeLessThan(45_000);
  });
});

describe('chembl_get_bioactivities — inline page cursor (#17)', () => {
  /** Seven ranked rows whose 8.50 tie straddles the first 3-row page edge. */
  const TIED_VIEW = (
    [
      [1000, '9.00'],
      [1005, '8.50'],
      [1002, '8.50'],
      [1006, '8.50'],
      [1001, '8.50'],
      [1003, '8.00'],
      [1004, '7.00'],
    ] as const
  ).map(([activity_id, pchembl_value], i) => ({ ...rawActivity(i), activity_id, pchembl_value }));
  /** The view's order: most potent first, the tie ascending by activity_id. */
  const TIED_ORDER = [1000, 1001, 1002, 1005, 1006, 1003, 1004];
  /** The honest count spans both potency views, so it exceeds the ranked view. */
  const HONEST = 20;

  const serveTiedView = () =>
    fetchMock.mockImplementation(activityCorpus({ honest: HONEST, rows: TIED_VIEW }));

  const run = (input: Record<string, unknown>, c = ctx()) =>
    chemblGetBioactivities.handler(chemblGetBioactivities.input.parse(input), c);

  const ids = (result: { activities: { activity_id: number }[] }) =>
    result.activities.map((a) => a.activity_id);

  /** Both client surfaces, through the production contract boundary. */
  async function contract(input: Record<string, unknown>) {
    const result = await runToolContract(chemblGetBioactivities, input, {
      context: { tenantId: 'default' },
    });
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    return { structured: result.structuredContent as Record<string, unknown>, text };
  }

  it('adds a nextCursor to the canvas-off response when the view holds more rows', async () => {
    setCanvas(undefined);
    serveTiedView();
    const result = await run({ target_chembl_id: 'CHEMBL203', limit: 3 });
    expect(ids(result)).toEqual(TIED_ORDER.slice(0, 3));
    expect(result.totalCount).toBe(HONEST);
    expect(result.canvasDisabled).toBe(true);
    expect(chemblGetBioactivities.output.parse(result).nextCursor).toBe(result.nextCursor);
    expect(decodeCursor(result.nextCursor as string, createMockContext({}))).toMatchObject({
      offset: 3,
    });
  });

  it('carries the continuation on both surfaces', async () => {
    setCanvas(undefined);
    serveTiedView();
    const { structured, text } = await contract({ target_chembl_id: 'CHEMBL203', limit: 3 });
    expect(typeof structured.nextCursor).toBe('string');
    expect(text).toContain(`cursor="${structured.nextCursor}"`);
    expect(text).toContain('Showing rows 1–3 of the 7 rows in this view');
  });

  it('walks the view to exhaustion: every activity_id once, in potency order', async () => {
    setCanvas(undefined);
    serveTiedView();
    const walked: number[] = [];
    const pageSizes: number[] = [];
    let cursor: string | undefined;
    // Bounded so a cursor that fails to advance fails the test instead of hanging.
    for (let page = 0; page < 10; page++) {
      const result = await run({
        target_chembl_id: 'CHEMBL203',
        limit: 3,
        ...(cursor && { cursor }),
      });
      pageSizes.push(result.activities.length);
      walked.push(...ids(result));
      expect(result.totalCount).toBe(HONEST);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeUndefined();
    expect(pageSizes).toEqual([3, 3, 1]);
    expect(walked).toEqual(TIED_ORDER);
    expect(new Set(walked).size).toBe(TIED_ORDER.length);
  });

  it('omits nextCursor from both surfaces on the last page', async () => {
    setCanvas(undefined);
    serveTiedView();
    const c = ctx();
    const last = await run(
      { target_chembl_id: 'CHEMBL203', limit: 3, cursor: encodeCursor({ offset: 6, limit: 3 }) },
      c,
    );
    expect(ids(last)).toEqual([1004]);
    expect(last).not.toHaveProperty('nextCursor');
    expect(enrichmentOf(c).notice).toContain('Showing row 7 of the 7 rows in this view');
    expect(enrichmentOf(c).notice).toContain('last page');

    const { structured, text } = await contract({
      target_chembl_id: 'CHEMBL203',
      limit: 3,
      cursor: encodeCursor({ offset: 6, limit: 3 }),
    });
    expect(structured).not.toHaveProperty('nextCursor');
    expect(text).not.toContain('cursor="');
  });

  it('omits nextCursor when the first page holds the whole view', async () => {
    setCanvas(undefined);
    serveTiedView();
    const c = ctx();
    const result = await run({ target_chembl_id: 'CHEMBL203', limit: 25 }, c);
    expect(ids(result)).toEqual(TIED_ORDER);
    expect(result).not.toHaveProperty('nextCursor');
    expect(enrichmentOf(c).notice).toContain('Showing all 7 rows in this view');
  });

  it('requests one count plus min(limit, CHEMBL_MAX_PAGE_SIZE) pages from the decoded offset', async () => {
    setCanvas(undefined);
    serveTiedView();
    await run({
      target_chembl_id: 'CHEMBL203',
      limit: 3,
      cursor: encodeCursor({ offset: 3, limit: 3 }),
    });
    const counts = fetchMock.mock.calls.filter((call) => !String(call[0]).includes('order_by='));
    expect(counts).toHaveLength(1);
    expect(
      viewRequests(fetchMock.mock.calls).map((p) => [p.get('offset'), p.get('limit')]),
    ).toEqual([['3', '3']]);

    fetchMock.mockClear();
    initChemblService({ ...getServerConfig(), maxPageSize: 2 });
    const result = await run({
      target_chembl_id: 'CHEMBL203',
      limit: 3,
      cursor: encodeCursor({ offset: 3, limit: 3 }),
    });
    expect(ids(result)).toEqual(TIED_ORDER.slice(3, 6));
    expect(
      viewRequests(fetchMock.mock.calls).map((p) => [p.get('offset'), p.get('limit')]),
    ).toEqual([
      ['3', '2'],
      ['5', '2'],
    ]);
  });

  it('reports a complete walk, not a bad filter, for a cursor past the end', async () => {
    setCanvas(undefined);
    serveTiedView();
    const c = ctx();
    const result = await run(
      { target_chembl_id: 'CHEMBL203', limit: 3, cursor: encodeCursor({ offset: 900, limit: 3 }) },
      c,
    );
    expect(result.activities).toEqual([]);
    expect(result).not.toHaveProperty('nextCursor');
    expect(result.totalCount).toBe(HONEST);
    const notice = enrichmentOf(c).notice ?? '';
    expect(notice).toContain('past the end of the 7 rows in this view');
    expect(notice).toContain('walk is complete');
    expect(notice).not.toContain('No measurements matched');
  });

  it('rejects a malformed cursor with -32602 before any upstream request', async () => {
    setCanvas(undefined);
    serveTiedView();
    const err: unknown = await Promise.resolve(
      run({ target_chembl_id: 'CHEMBL203', cursor: '!!not-a-cursor!!' }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect((err as McpError).data).toMatchObject({
      reason: 'invalid_cursor',
      recovery: { hint: expect.any(String) },
    });

    const tampered = Buffer.from(JSON.stringify({ offset: -5, limit: 3 })).toString('base64url');
    await expect(
      Promise.resolve(run({ target_chembl_id: 'CHEMBL203', cursor: tampered })),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the input gates ahead of cursor decoding', async () => {
    setCanvas(undefined);
    // Malformed, so decoding it ahead of either gate would answer invalid_cursor instead.
    const cursor = '!!not-a-cursor!!';
    await expect(Promise.resolve(run({ cursor }))).rejects.toMatchObject({
      data: { reason: 'missing_filter' },
    });
    await expect(
      Promise.resolve(
        run({
          molecule_chembl_id: 'CHEMBL25',
          potency_view: 'null_potency',
          pchembl_value_min: 7,
          cursor,
        }),
      ),
    ).rejects.toMatchObject({ data: { reason: 'contradictory_potency_filter' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a blank cursor as omitted', async () => {
    setCanvas(undefined);
    serveTiedView();
    for (const cursor of ['', '   ']) {
      const result = await run({ target_chembl_id: 'CHEMBL203', limit: 3, cursor });
      expect(ids(result)).toEqual(TIED_ORDER.slice(0, 3));
    }
  });

  it('serves a canvas-on cursor page inline, as with the canvas off, acquiring no canvas', async () => {
    const cursor = encodeCursor({ offset: 3, limit: 3 });
    setCanvas(undefined);
    serveTiedView();
    const off = await run({ target_chembl_id: 'CHEMBL203', limit: 3, cursor });

    const fake = new FakeDataCanvas();
    const acquire = vi.spyOn(fake, 'acquire');
    setCanvas(fake.cast());
    const c = ctx();
    const on = await run({ target_chembl_id: 'CHEMBL203', limit: 3, cursor }, c);

    expect(acquire).not.toHaveBeenCalled();
    expect(fake.countForTenant({ tenantId: 'default' })).toBe(0);
    expect(on).toEqual({ ...off, canvasDisabled: false });
    expect(on.spilled).toBe(false);
    expect(on.canvas_id).toBeNull();
    expect(on.nextCursor).toBe(off.nextCursor);
    const notice = enrichmentOf(c).notice ?? '';
    expect(notice).toContain('not staged');
    // Without a canvas_id, dropping the cursor stages only a spill; a fit needs a canvas_id.
    expect(notice).toContain(
      'Without cursor, a view that spills stages on a new canvas, and one that fits inline stages only on a canvas_id you pass.',
    );
    expect(notice).not.toContain('omit cursor to stage');
  });

  it('says on both surfaces how a cursor page relates to staging, with and without canvas_id', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const existing = await fake.acquire(undefined, { tenantId: 'default' });
    serveTiedView();
    const cursor = encodeCursor({ offset: 3, limit: 3 });
    const bare = await contract({ target_chembl_id: 'CHEMBL203', limit: 3, cursor });
    const onCanvas = await contract({
      target_chembl_id: 'CHEMBL203',
      limit: 3,
      cursor,
      canvas_id: existing.canvasId,
    });
    const fitsOnlyOnCanvasId = 'one that fits inline stages only on a canvas_id you pass';
    const restagesOnIt = `nothing was written to canvas ${existing.canvasId}; re-call without cursor to re-stage the view on it.`;
    for (const surface of [(bare.structured as { notice: string }).notice, bare.text]) {
      expect(surface).toContain(fitsOnlyOnCanvasId);
      expect(surface).not.toContain('re-stage the view on it');
    }
    for (const surface of [(onCanvas.structured as { notice: string }).notice, onCanvas.text]) {
      expect(surface).toContain(restagesOnIt);
      expect(surface).not.toContain(fitsOnlyOnCanvasId);
    }
  });

  it('leaves a supplied canvas untouched on a cursor page', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const existing = await fake.acquire(undefined, { tenantId: 'default' });
    const stagedRows = [{ activity_id: 1, molecule_chembl_id: 'CHEMBL1' }];
    await existing.registerTable('bioactivities', stagedRows);
    const acquire = vi.spyOn(fake, 'acquire');
    serveTiedView();
    const c = ctx();
    const result = await run(
      {
        target_chembl_id: 'CHEMBL203',
        limit: 3,
        canvas_id: existing.canvasId,
        cursor: encodeCursor({ offset: 3, limit: 3 }),
      },
      c,
    );

    expect(ids(result)).toEqual(TIED_ORDER.slice(3, 6));
    expect(result.canvas_id).toBeNull();
    expect(acquire).not.toHaveBeenCalled();
    const tables = fake.canvases.get(existing.canvasId)?.tables;
    expect([...(tables?.keys() ?? [])]).toEqual(['bioactivities']);
    expect(tables?.get('bioactivities')?.rows).toEqual(stagedRows);
    const notice = enrichmentOf(c).notice ?? '';
    expect(notice).toContain('not staged');
    expect(notice).toContain(existing.canvasId);
    expect(notice).toContain('re-call without cursor to re-stage the view on it');
  });

  it('keeps a canvas-on first page spilling, minting no cursor', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    mockUpstream({
      honest: 26600,
      activities: Array.from({ length: 120 }, (_, i) => rawActivity(i)),
    });
    const spilled = await run({ target_chembl_id: 'CHEMBL203', limit: 25 });
    expect(spilled.spilled).toBe(true);
    expect(spilled).not.toHaveProperty('nextCursor');
  });

  it('mints a nextCursor when a canvas-on view fits inline past limit with nothing staged', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    serveTiedView();
    const { structured, text } = await contract({ target_chembl_id: 'CHEMBL203', limit: 3 });

    expect(structured).toMatchObject({ spilled: false, canvas_id: null, staged_row_count: null });
    expect((structured.activities as { activity_id: number }[]).map((a) => a.activity_id)).toEqual(
      TIED_ORDER.slice(0, 3),
    );
    expect(decodeCursor(structured.nextCursor as string, createMockContext({}))).toMatchObject({
      offset: 3,
    });
    const notice = (structured as { notice?: string }).notice ?? '';
    expect(notice).toContain('Showing rows 1–3 of the 7 rows in this view');
    expect(notice).toContain('pass nextCursor back as cursor');
    expect(notice).not.toContain('raise limit');
    expect(text).toContain(`cursor="${structured.nextCursor}"`);
    expect(fake.countForTenant({ tenantId: 'default' })).toBe(0);
  });

  it('walks a canvas-on inline fit to exhaustion through the cursor pages, staging nothing', async () => {
    const fake = new FakeDataCanvas();
    const acquire = vi.spyOn(fake, 'acquire');
    setCanvas(fake.cast());
    serveTiedView();
    const walked: number[] = [];
    const pageSizes: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await run({
        target_chembl_id: 'CHEMBL203',
        limit: 3,
        ...(cursor && { cursor }),
      });
      expect(result.spilled).toBe(false);
      expect(result.canvas_id).toBeNull();
      pageSizes.push(result.activities.length);
      walked.push(...ids(result));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(pageSizes).toEqual([3, 3, 1]);
    expect(walked).toEqual(TIED_ORDER);
    expect(acquire).not.toHaveBeenCalled();

    // The last page carries no continuation on either surface.
    const { structured, text } = await contract({
      target_chembl_id: 'CHEMBL203',
      limit: 3,
      cursor: encodeCursor({ offset: 6, limit: 3 }),
    });
    expect(structured).not.toHaveProperty('nextCursor');
    expect(text).not.toContain('cursor="');
  });

  it('mints no cursor for a canvas-on inline fit that returns the whole view', async () => {
    setCanvas(new FakeDataCanvas().cast());
    serveTiedView();
    const { structured, text } = await contract({ target_chembl_id: 'CHEMBL203', limit: 7 });
    expect(ids(structured as { activities: { activity_id: number }[] })).toEqual(TIED_ORDER);
    expect(structured).not.toHaveProperty('nextCursor');
    expect(text).not.toContain('cursor="');
  });

  it('mints no cursor when the inline fit is re-staged on a supplied canvas', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const existing = await fake.acquire(undefined, { tenantId: 'default' });
    serveTiedView();
    const result = await run({
      target_chembl_id: 'CHEMBL203',
      limit: 3,
      canvas_id: existing.canvasId,
    });
    expect(result.staged_row_count).toBe(7);
    expect(result).not.toHaveProperty('nextCursor');
  });

  it('mints no cursor for a canvas-on zero match', async () => {
    setCanvas(new FakeDataCanvas().cast());
    fetchMock.mockImplementation(activityCorpus({ honest: 0, rows: [] }));
    const c = ctx();
    const result = await run({ target_chembl_id: 'CHEMBL203', limit: 3 }, c);
    expect(result.activities).toEqual([]);
    expect(result).not.toHaveProperty('nextCursor');
    expect(enrichmentOf(c).notice).toContain('No measurements matched');
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
      truncated_by: null,
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
      truncated_by: 'row_cap',
      canvasDisabled: false,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('truncated: yes');
    expect(text).toContain('staged_row_count: 50000');
    expect(text).toContain('NOT the complete view');
    expect(text).not.toContain('truncated: no');
    // The line names the bound that cut the table short (#16).
    expect(text).toContain('truncated_by: row_cap');
    expect(text).toContain('CHEMBL_MAX_SPILL_ROWS');
    expect(text).not.toContain('CHEMBL_SPILL_DEADLINE_MS');
  });

  it('names the time budget when it cut the staged table short (#16)', () => {
    const blocks = chemblGetBioactivities.format!({
      activities: [],
      totalCount: 26600,
      potency_view: 'potency_ranked',
      spilled: true,
      canvas_id: 'abc1234567',
      table_name: 'bioactivities',
      staged_row_count: 12000,
      truncated: true,
      truncated_by: 'time_budget',
      canvasDisabled: false,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('truncated: yes (truncated_by: time_budget)');
    expect(text).toContain('CHEMBL_SPILL_DEADLINE_MS');
    expect(text).not.toContain('CHEMBL_MAX_SPILL_ROWS');
    expect(text).toContain('NOT the complete view');
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
      truncated_by: null,
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
      truncated_by: null,
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
      truncated_by: null,
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
      truncated_by: null,
      canvasDisabled: true,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**26600** measurements total');
    expect(text).not.toContain('preview is the full set');
    expect(text).toContain('canvas disabled');
    expect(text).toContain('capped preview');
    // No nextCursor on the output, so no continuation line either (#17).
    expect(text.toLowerCase()).not.toContain('cursor');
  });

  it('discloses the cursor continuation to a content-only client (#17)', () => {
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
          standard_value: 41,
          standard_units: 'nM',
          pchembl_value: 7.39,
          type: 'IC50',
          value: '41',
          units: 'nM',
          relation: '=',
        },
      ],
      totalCount: 26600,
      potency_view: 'potency_ranked',
      spilled: false,
      canvas_id: null,
      table_name: null,
      staged_row_count: null,
      truncated: false,
      truncated_by: null,
      canvasDisabled: true,
      nextCursor: 'OPAQUE-CURSOR-TOKEN',
    });
    const text = blocks.map((b) => (b as { text: string }).text).join('\n');
    // The whole line: the header names potency_view on every response, continuation or not.
    expect(text).toContain(
      'More rows remain in this view — re-call with cursor="OPAQUE-CURSOR-TOKEN" and the same filters and potency_view for the next page.',
    );
  });
});
