/**
 * @fileoverview Tests for the bioactivity spill row cap (#14) — the bound on the
 * upstream page drain `chembl_get_bioactivities` hands to `spillover()`. Isolated
 * in its own file because it stubs CHEMBL_MAX_SPILL_ROWS before the lazily-cached
 * server config is first parsed; Vitest runs each file in its own worker, so the
 * small cap never leaks into the other suites.
 *
 * Covered: the cap trips mid-drain (staged table holds exactly the cap, truncation
 * disclosed on `structuredContent` and in `format()` with `truncated_by: "row_cap"`),
 * the walk requests no page at or past the cap, a capped walk that fits inline
 * names the cap rather than `limit`, the same cap applies to the opt-in
 * null-potency retrieval path #9 adds, and the regression case — a spill that
 * stays under the cap reports `truncated: false` and stages every row. A walk
 * that ends on a short page before the view total `page_meta.total_count`
 * reported names no bound on any branch (spilled, re-staged, or unstaged), while
 * a cap hit exactly on a full last page still names `row_cap`.
 * @module tests/tools/chembl-bioactivities-spill-cap
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { decodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblGetBioactivities } from '@/mcp-server/tools/definitions/chembl-get-bioactivities.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { initChemblService } from '@/services/chembl/chembl-service.js';
import { activityCorpus, viewRequests } from '../_fake-activity-upstream.js';
import { FakeDataCanvas } from '../_fake-canvas.js';

/**
 * Cap for this file. A `rawActivity` row serializes to ~745 chars, so the 50,000-character
 * preview budget buffers ~67 rows before the overflow sentinel — a cap of 100
 * therefore trips in the spill tail, after a normal preview, exactly as a real
 * over-cap drain does.
 */
const TEST_CAP = 100;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

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
    pchembl_value: `${(9 - i / 500).toFixed(2)}`,
    type: 'IC50',
    value: `${(i + 1) * 0.0015}`,
    units: 'uM',
    relation: '=',
  };
}

/** Stream call carries `order_by`; the honest-count call does not. */
function mockUpstream(opts: { honest: number; viewTotal: number; rows: number }): void {
  fetchMock.mockImplementation((url: string | URL) => {
    if (!String(url).includes('order_by=')) {
      return Promise.resolve(
        jsonResponse({ activities: [], page_meta: { total_count: opts.honest, next: null } }),
      );
    }
    return Promise.resolve(
      jsonResponse({
        activities: Array.from({ length: opts.rows }, (_, i) => rawActivity(i)),
        page_meta: { total_count: opts.viewTotal, next: null },
      }),
    );
  });
}

/**
 * Multi-page variant: `pages` × `perPage` rows behind a fake `/activity` that
 * honors `offset` / `limit` as ChEMBL does, walked at `perPage` rows per page (the
 * service's CHEMBL_MAX_PAGE_SIZE). `afterEach` restores the configured page size.
 */
function mockPagedUpstream(opts: { honest: number; pages: number; perPage: number }): void {
  initChemblService({ ...getServerConfig(), maxPageSize: opts.perPage });
  fetchMock.mockImplementation(
    activityCorpus({
      honest: opts.honest,
      rows: Array.from({ length: opts.pages * opts.perPage }, (_, i) => rawActivity(i)),
    }),
  );
}

/**
 * A view whose pages run out before the total it reports: `rows` rows behind
 * `perPage`-row pages, every view page claiming `viewTotal` in
 * `page_meta.total_count` (a drifted count, or a page that came back short). The
 * walk ends on the short page holding the last row, below the cap.
 */
function mockShortPageUpstream(opts: { rows: number; viewTotal: number; perPage: number }): void {
  initChemblService({ ...getServerConfig(), maxPageSize: opts.perPage });
  fetchMock.mockImplementation(
    activityCorpus({
      honest: opts.viewTotal,
      viewTotal: opts.viewTotal,
      rows: Array.from({ length: opts.rows }, (_, i) => rawActivity(i)),
    }),
  );
}

/** Both public surfaces of a run: `structuredContent` (enrichment included) and the `content[]` text. */
async function runBoth(input: Record<string, unknown>) {
  const run = await runToolContract(chemblGetBioactivities, input, {
    context: { tenantId: 'default' },
  });
  expect(run.isError).toBeFalsy();
  const structured = run.structuredContent as Record<string, unknown> & { notice?: string };
  const text = run.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return { structured, notice: structured.notice ?? '', text };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(() => {
  vi.stubEnv('CHEMBL_MAX_SPILL_ROWS', String(TEST_CAP));
  // First read of the lazily-cached config — pins TEST_CAP for this worker.
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

describe('CHEMBL_MAX_SPILL_ROWS', () => {
  it('is read from the environment into the server config', () => {
    expect(getServerConfig().maxSpillRows).toBe(TEST_CAP);
  });
});

describe('chembl_get_bioactivities — spill row cap (#14)', () => {
  it('caps the staged table and discloses the truncation on both surfaces', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    // 300 upstream rows against a 100-row cap: the drain must stop at the cap.
    mockUpstream({ honest: 58847, viewTotal: 21342, rows: 300 });
    const c = ctx();
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', limit: 25 }),
      c,
    );

    expect(result.spilled).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.staged_row_count).toBe(TEST_CAP);

    const instance = await fake.acquire(result.canvas_id ?? undefined, { tenantId: 'default' });
    const staged = (await instance.describe()).find((t) => t.name === 'bioactivities');
    expect(staged?.rowCount).toBe(TEST_CAP);

    // content[] surface: format() must not present the capped table as the full set.
    const text = (chemblGetBioactivities.format!(result)[0] as { text: string }).text;
    expect(text).toContain('truncated');
    expect(text).toContain(String(TEST_CAP));

    const notice = (getEnrichment(c) as { notice?: string }).notice ?? '';
    expect(notice).toContain('CHEMBL_MAX_SPILL_ROWS');
    expect(notice).toContain(String(TEST_CAP));
  });

  it('stops the upstream page walk at the cap instead of draining to exhaustion', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    // 20 pages × 50 rows = 1000 upstream rows available behind a 100-row cap.
    mockPagedUpstream({ honest: 58847, pages: 20, perPage: 50 });
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', limit: 25 }),
      ctx(),
    );

    expect(result.truncated).toBe(true);
    expect(result.truncated_by).toBe('row_cap');
    expect(result.staged_row_count).toBe(TEST_CAP);

    /**
     * The bound this test exists for: the walk must stop paging once the cap is
     * reached, not walk the view to exhaustion. The two pages below the cap hold
     * the 100 staged rows; no page is requested at or past it (#16), since the
     * view's own total, not a look-ahead row, is what makes `truncated` honest —
     * far short of the 20 pages on offer.
     */
    expect(viewRequests(fetchMock.mock.calls).map((params) => params.get('offset'))).toEqual([
      '0',
      '50',
    ]);
  });

  it('names the row cap on both surfaces when it cut the staged table short (#16)', async () => {
    setCanvas(new FakeDataCanvas().cast());
    mockPagedUpstream({ honest: 58847, pages: 20, perPage: 50 });
    const c = ctx();
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', limit: 25 }),
      c,
    );
    expect(result.truncated_by).toBe('row_cap');
    const notice = (getEnrichment(c) as { notice?: string }).notice ?? '';
    expect(notice).toContain(`CHEMBL_MAX_SPILL_ROWS=${TEST_CAP}`);
    expect(notice).not.toContain('CHEMBL_SPILL_DEADLINE_MS');
    const text = (chemblGetBioactivities.format!(result)[0] as { text: string }).text;
    expect(text).toContain('truncated: yes (truncated_by: row_cap)');
    expect(text).toContain('CHEMBL_MAX_SPILL_ROWS');
  });

  it('notes the cap, not limit, when a capped walk fits inline with nothing staged', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    // 200 rows behind 50-row pages: the walk stops at the 100-row cap, which a limit of 200 holds inline.
    mockPagedUpstream({ honest: 200, pages: 4, perPage: 50 });
    const c = ctx();
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', limit: 200 }),
      c,
    );
    expect(result.spilled).toBe(false);
    expect(result.canvas_id).toBeNull();
    expect(result.activities).toHaveLength(TEST_CAP);
    // Nothing staged, so the output reports no truncation of a table…
    expect(result.truncated).toBe(false);
    expect(result.truncated_by).toBeNull();
    // …but the notice says the cap, not limit, held the rest back.
    const notice = (getEnrichment(c) as { notice?: string }).notice ?? '';
    // The whole sentence: "rows 1–100 of the 200 rows" in the page span satisfies a fragment.
    expect(notice).toContain(
      `The page walk stopped at the row cap (CHEMBL_MAX_SPILL_ROWS=${TEST_CAP}) after ${TEST_CAP} of the 200 rows in this view, so nothing was staged.`,
    );
    expect(notice).not.toContain('raise limit');

    // Nothing was staged, so a cursor continues the view past the cap (#17).
    expect(notice).toContain('pass nextCursor back as cursor');
    const nextCursor = result.nextCursor as string;
    expect(decodeCursor(nextCursor, createMockContext({}))).toMatchObject({ offset: TEST_CAP });
    const page = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({
        target_chembl_id: 'CHEMBL203',
        limit: 200,
        cursor: nextCursor,
      }),
      ctx(),
    );
    expect(page.activities.map((a) => a.activity_id)).toEqual(
      Array.from({ length: 100 }, (_, i) => 1100 + i),
    );
    expect(page).not.toHaveProperty('nextCursor');
    expect(fake.countForTenant({ tenantId: 'default' })).toBe(0);
  });

  it('applies the same cap to the null-potency retrieval path (#9)', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    mockUpstream({ honest: 4087, viewTotal: 3929, rows: 300 });
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({
        molecule_chembl_id: 'CHEMBL25',
        potency_view: 'null_potency',
        limit: 25,
      }),
      ctx(),
    );

    expect(result.truncated).toBe(true);
    expect(result.staged_row_count).toBe(TEST_CAP);
    expect(result.table_name).toBe('bioactivities_null_potency');

    const instance = await fake.acquire(result.canvas_id ?? undefined, { tenantId: 'default' });
    const staged = (await instance.describe()).find((t) => t.name === 'bioactivities_null_potency');
    expect(staged?.rowCount).toBe(TEST_CAP);
  });

  it('stages every row and reports truncated:false when the spill fits under the cap', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    // 90 rows overflows the 50,000-character preview budget (spills) but stays under the cap.
    mockUpstream({ honest: 500, viewTotal: 90, rows: 90 });
    const c = ctx();
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', limit: 25 }),
      c,
    );

    expect(result.spilled).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.staged_row_count).toBe(90);

    const instance = await fake.acquire(result.canvas_id ?? undefined, { tenantId: 'default' });
    const staged = (await instance.describe()).find((t) => t.name === 'bioactivities');
    expect(staged?.rowCount).toBe(90);

    const notice = (getEnrichment(c) as { notice?: string }).notice ?? '';
    expect(notice).not.toContain('CHEMBL_MAX_SPILL_ROWS');
  });

  it('leaves truncated false when the result fits inline without spilling', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    mockUpstream({ honest: 3, viewTotal: 3, rows: 3 });
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', limit: 25 }),
      ctx(),
    );
    expect(result.spilled).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.staged_row_count).toBeNull();
    expect(fake.countForTenant({ tenantId: 'default' })).toBe(0);
  });

  it('holds an inline-fit re-stage on a supplied canvas to the cap too (#31)', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const existing = await fake.acquire(undefined, { tenantId: 'default' });
    // 150 rows fit the 600 KB budget a limit of 1000 buys, but exceed the 100-row cap.
    mockUpstream({ honest: 150, viewTotal: 150, rows: 150 });
    const c = ctx();
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({
        target_chembl_id: 'CHEMBL203',
        limit: 1000,
        canvas_id: existing.canvasId,
      }),
      c,
    );

    expect(result.spilled).toBe(false);
    expect(result.activities).toHaveLength(150);
    expect(result.truncated).toBe(true);
    expect(result.staged_row_count).toBe(TEST_CAP);
    expect(fake.canvases.get(existing.canvasId)?.tables.get('bioactivities')?.rows).toHaveLength(
      TEST_CAP,
    );
    const notice = (getEnrichment(c) as { notice?: string }).notice ?? '';
    expect(notice).toContain('CHEMBL_MAX_SPILL_ROWS');
    const text = (chemblGetBioactivities.format!(result)[0] as { text: string }).text;
    expect(text).toContain('truncated: yes');
    expect(text).toContain(`staged_row_count: ${TEST_CAP}`);
  });

  it('says the table holds only the capped rows when a capped re-stage is shown past limit (#31)', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const existing = await fake.acquire(undefined, { tenantId: 'default' });
    // 105 rows fit the 62.4 KB budget a limit of 104 buys; the table keeps the first 100.
    mockUpstream({ honest: 105, viewTotal: 105, rows: 105 });
    const c = ctx();
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({
        target_chembl_id: 'CHEMBL203',
        limit: 104,
        canvas_id: existing.canvasId,
      }),
      c,
    );

    expect(result.spilled).toBe(false);
    expect(result.activities).toHaveLength(104);
    expect(result.staged_row_count).toBe(TEST_CAP);
    expect(result.truncated).toBe(true);
    const notice = (getEnrichment(c) as { notice?: string }).notice ?? '';
    expect(notice).toContain(
      `Showing 104 of the 105 rows in this view inline; the table holds the first ${TEST_CAP}.`,
    );
    expect(notice).not.toContain('the rest are on the table');
  });

  it('leaves the canvas-disabled preview path bounded by limit, not the cap', async () => {
    setCanvas(undefined);
    mockUpstream({ honest: 58847, viewTotal: 21342, rows: 300 });
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', limit: 10 }),
      ctx(),
    );
    expect(result.activities).toHaveLength(10);
    expect(result.canvasDisabled).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.staged_row_count).toBeNull();
  });
});

describe('chembl_get_bioactivities — truncated_by names only the bound that cut the walk', () => {
  /**
   * 90 rows behind 50-row pages while every page reports 1000: the walk ends on
   * the 40-row page at offset 50, holding 90 rows — under the 100-row cap, with
   * the time budget untouched. Neither bound cut it, so neither is named.
   */
  it('names no bound when a spill walk ends on a short page before the view total', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    mockShortPageUpstream({ rows: 90, viewTotal: 1000, perPage: 50 });
    const { structured, notice, text } = await runBoth({
      target_chembl_id: 'CHEMBL203',
      limit: 25,
    });

    // Premise: the spilled branch, holding every row the walk got.
    expect(structured).toMatchObject({ spilled: true, staged_row_count: 90 });
    expect(
      fake.canvases.get(structured.canvas_id as string)?.tables.get('bioactivities')?.rows,
    ).toHaveLength(90);

    expect(structured.truncated).toBe(false);
    expect(structured.truncated_by).toBeNull();
    expect(notice).toContain('90 measurements staged as table "bioactivities"');
    expect(notice).not.toContain('CHEMBL_MAX_SPILL_ROWS');
    expect(notice).not.toContain('CHEMBL_SPILL_DEADLINE_MS');
    expect(notice).not.toContain('Capped');
    expect(text).toContain('staged_row_count: 90 | truncated: no');
    expect(text).not.toContain('truncated: yes');
    expect(text).not.toContain('row cap');
  });

  /**
   * 60 rows behind 50-row pages while every page reports 1000: the walk fits the
   * 50,000-character budget a limit of 25 buys and is re-staged on the supplied canvas whole.
   */
  it('names no bound when an inline-fit re-stage walk ends on a short page', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const existing = await fake.acquire(undefined, { tenantId: 'default' });
    mockShortPageUpstream({ rows: 60, viewTotal: 1000, perPage: 50 });
    const { structured, notice, text } = await runBoth({
      target_chembl_id: 'CHEMBL203',
      limit: 25,
      canvas_id: existing.canvasId,
    });

    // Premise: an inline fit re-staged on the supplied canvas, holding every row the walk got.
    expect(structured).toMatchObject({
      spilled: false,
      canvas_id: existing.canvasId,
      staged_row_count: 60,
    });
    expect(fake.canvases.get(existing.canvasId)?.tables.get('bioactivities')?.rows).toHaveLength(
      60,
    );

    expect(structured.truncated).toBe(false);
    expect(structured.truncated_by).toBeNull();
    // The table holds 60 of the 1000 rows the view reported — never "the rest".
    expect(notice).toContain(
      'Showing 25 of the 1000 rows in this view inline; the table holds the first 60.',
    );
    expect(notice).not.toContain('the rest are on the table');
    expect(notice).not.toContain('CHEMBL_MAX_SPILL_ROWS');
    expect(notice).not.toContain('Capped');
    expect(text).toContain('staged_row_count: 60 | truncated: no');
    expect(text).not.toContain('truncated: yes');
  });

  it('names no bound when an unstaged inline fit ends on a short page, and continues by cursor', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    mockShortPageUpstream({ rows: 60, viewTotal: 1000, perPage: 50 });
    const { structured, notice, text } = await runBoth({
      target_chembl_id: 'CHEMBL203',
      limit: 25,
    });

    expect(structured).toMatchObject({
      spilled: false,
      canvas_id: null,
      staged_row_count: null,
      truncated: false,
      truncated_by: null,
    });
    expect(notice).toBe(
      'Showing rows 1–25 of the 1000 rows in this view; pass nextCursor back as cursor, with the same filters and potency_view, for the next page.',
    );
    expect(decodeCursor(structured.nextCursor as string, createMockContext({}))).toMatchObject({
      offset: 25,
    });
    expect(text).toContain('truncated: no');
    expect(fake.countForTenant({ tenantId: 'default' })).toBe(0);
  });

  /**
   * The cap hit exactly on a full last page: 50-row pages at offsets 0 and 50 end
   * the walk at the 100-row cap, so `spillover()` sees its source end at the cap
   * and reports nothing cut. The view's 101st row is still cut by the cap.
   */
  it('names the row cap when a spill reaches it exactly on a full last page', async () => {
    setCanvas(new FakeDataCanvas().cast());
    mockShortPageUpstream({ rows: 101, viewTotal: 101, perPage: 50 });
    const { structured, notice, text } = await runBoth({
      target_chembl_id: 'CHEMBL203',
      limit: 25,
    });

    expect(viewRequests(fetchMock.mock.calls).map((params) => params.get('offset'))).toEqual([
      '0',
      '50',
    ]);
    expect(structured).toMatchObject({
      spilled: true,
      staged_row_count: TEST_CAP,
      truncated: true,
      truncated_by: 'row_cap',
    });
    expect(notice).toContain(
      `Capped: the staged table holds ${TEST_CAP} rows of a larger upstream set (CHEMBL_MAX_SPILL_ROWS=${TEST_CAP})`,
    );
    expect(text).toContain('truncated: yes (truncated_by: row_cap)');
  });

  it('names no bound when the view holds exactly the cap', async () => {
    setCanvas(new FakeDataCanvas().cast());
    mockShortPageUpstream({ rows: TEST_CAP, viewTotal: TEST_CAP, perPage: 50 });
    const { structured, notice, text } = await runBoth({
      target_chembl_id: 'CHEMBL203',
      limit: 25,
    });

    expect(structured).toMatchObject({
      spilled: true,
      staged_row_count: TEST_CAP,
      truncated: false,
      truncated_by: null,
    });
    expect(notice).not.toContain('CHEMBL_MAX_SPILL_ROWS');
    expect(text).toContain(`staged_row_count: ${TEST_CAP} | truncated: no`);
  });

  it('names the row cap when an inline-fit re-stage reaches it exactly on a full last page', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const existing = await fake.acquire(undefined, { tenantId: 'default' });
    // 100 rows fit the 60 KB budget a limit of 100 buys; the view holds one more past the cap.
    mockShortPageUpstream({ rows: 101, viewTotal: 101, perPage: 50 });
    const { structured, notice, text } = await runBoth({
      target_chembl_id: 'CHEMBL203',
      limit: 100,
      canvas_id: existing.canvasId,
    });

    expect(structured).toMatchObject({
      spilled: false,
      staged_row_count: TEST_CAP,
      truncated: true,
      truncated_by: 'row_cap',
    });
    expect(notice).toContain(
      `Showing ${TEST_CAP} of the 101 rows in this view inline; the table holds the first ${TEST_CAP}.`,
    );
    expect(notice).toContain(`(CHEMBL_MAX_SPILL_ROWS=${TEST_CAP})`);
    expect(text).toContain('truncated: yes (truncated_by: row_cap)');
  });
});
