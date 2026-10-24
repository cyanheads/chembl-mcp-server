/**
 * @fileoverview Tests for the inline-preview boundary of chembl_get_bioactivities —
 * `limit` bounds the rows returned inline on ALL THREE response branches, not just
 * the two that happened to enforce it. `spillover()` sizes its preview buffer by a
 * character budget (`max(50_000, limit * 800)`), so the canvas-enabled branch where
 * the view fits inline drains ~67 rows regardless of how small `limit` is; the cap
 * is applied to the returned rows, never to the budget (which is what drives the
 * fit-vs-spill decision and its overflow sentinel), and a spill's rows are the
 * walk's first `limit`, however few the buffer held.
 *
 * Covered: the boundary on each branch with `limit` above and below the row count,
 * schema bounds on `limit`, both `potency_view`s, a multi-page drain that must stay
 * untouched by the slice, and the honesty of both response surfaces — the notice
 * and `format()` must say what the caller has versus what matched, and must not
 * offer canvas guidance when nothing was staged.
 * @module tests/tools/chembl-bioactivities-preview-limit
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { decodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblGetBioactivities } from '@/mcp-server/tools/definitions/chembl-get-bioactivities.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { initChemblService } from '@/services/chembl/chembl-service.js';
import { activityCorpus, viewRequests } from '../_fake-activity-upstream.js';
import { FakeDataCanvas } from '../_fake-canvas.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A row serializing to ~745 chars, so ~67 of them fill the 50,000-character preview budget.
 * `FITS_INLINE` rows therefore exhaust the stream under budget (no spill) while
 * still being far more rows than a small `limit` asks for — the exact shape the
 * live CHEMBL941 × CHEMBL385 pair produces.
 */
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

/** The rows the null-potency view exists to reach: no derivable pchembl_value. */
function rawNullActivity(i: number): Record<string, unknown> {
  const { pchembl_value: _omitted, ...rest } = rawActivity(i);
  return { ...rest, standard_relation: '>', relation: '>' };
}

/** Rows that fit the 50,000-character preview budget whole — the branch under test. */
const FITS_INLINE = 58;
/** Rows that overflow the budget and force a spill. */
const SPILLS = 120;

/** Stream calls carry `order_by`; the honest-count call does not. */
function mockUpstream(opts: {
  honest: number;
  viewTotal?: number;
  rows: number;
  row?: (i: number) => Record<string, unknown>;
}): void {
  const viewTotal = opts.viewTotal ?? opts.honest;
  const row = opts.row ?? rawActivity;
  fetchMock.mockImplementation((url: string | URL) => {
    if (!String(url).includes('order_by=')) {
      return Promise.resolve(
        jsonResponse({ activities: [], page_meta: { total_count: opts.honest, next: null } }),
      );
    }
    return Promise.resolve(
      jsonResponse({
        activities: Array.from({ length: opts.rows }, (_, i) => row(i)),
        page_meta: { total_count: viewTotal, next: null },
      }),
    );
  });
}

/**
 * `pages` × `perPage` rows behind a fake `/activity` that honors `offset` /
 * `limit` as ChEMBL does, walked by the service at `perPage` rows per page (its
 * CHEMBL_MAX_PAGE_SIZE). `afterEach` restores the configured page size.
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

function noticeOf(c: ReturnType<typeof ctx>): string {
  return (getEnrichment(c) as { notice?: string }).notice ?? '';
}

function textOf(result: Parameters<NonNullable<typeof chemblGetBioactivities.format>>[0]): string {
  return (chemblGetBioactivities.format!(result)[0] as { text: string }).text;
}

/** Run the handler with the canvas enabled, returning the result and the fake. */
async function withCanvas(
  input: Record<string, unknown>,
  c = ctx(),
): Promise<{
  result: Awaited<ReturnType<typeof chemblGetBioactivities.handler>>;
  fake: FakeDataCanvas;
}> {
  const fake = new FakeDataCanvas();
  setCanvas(fake.cast());
  const result = await chemblGetBioactivities.handler(chemblGetBioactivities.input.parse(input), c);
  return { result, fake };
}

describe('chembl_get_bioactivities — inline preview bounded by limit', () => {
  it('caps the fit-inline preview at limit instead of the preview character budget', async () => {
    mockUpstream({ honest: FITS_INLINE, rows: FITS_INLINE });
    const c = ctx();
    const { result } = await withCanvas(
      { molecule_chembl_id: 'CHEMBL941', target_chembl_id: 'CHEMBL385', limit: 2 },
      c,
    );

    // The whole view fit under the 50,000-character budget, so nothing spilled — and the
    // rows past `limit` are reached through nextCursor, exactly as with no canvas.
    expect(result.spilled).toBe(false);
    expect(result.canvas_id).toBeNull();
    expect(result.table_name).toBeNull();
    expect(result.staged_row_count).toBeNull();
    expect(result.truncated).toBe(false);
    expect(result.canvasDisabled).toBe(false);

    expect(result.activities).toHaveLength(2);
    // The head of the stream, in upstream order — a slice, not a resample.
    expect(result.activities.map((a) => a.activity_id)).toEqual([1000, 1001]);
    // totalCount stays the honest full match count, unmoved by the preview cap.
    expect(result.totalCount).toBe(FITS_INLINE);
    expect(decodeCursor(result.nextCursor as string, createMockContext({}))).toMatchObject({
      offset: 2,
    });
    expect(result).toEqual(expect.schemaMatching(chemblGetBioactivities.output));
  });

  it('returns the whole view when limit exceeds the row count', async () => {
    mockUpstream({ honest: 3, rows: 3 });
    const c = ctx();
    const { result } = await withCanvas({ target_chembl_id: 'CHEMBL203', limit: 25 }, c);

    expect(result.spilled).toBe(false);
    expect(result.activities).toHaveLength(3);
    // Nothing was held back, so there is nothing to say and nothing to continue.
    expect(noticeOf(c)).toBe('');
    expect(result).not.toHaveProperty('nextCursor');
    expect(textOf(result)).toContain('preview is the full set');
  });

  it('bounds all three response branches identically at the same limit', async () => {
    const limit = 3;

    mockUpstream({ honest: FITS_INLINE, rows: FITS_INLINE });
    const { result: fitInline } = await withCanvas({ target_chembl_id: 'CHEMBL203', limit });

    mockUpstream({ honest: 26600, viewTotal: 19378, rows: SPILLS });
    const { result: spilled } = await withCanvas({ target_chembl_id: 'CHEMBL203', limit });

    setCanvas(undefined);
    mockUpstream({ honest: FITS_INLINE, rows: FITS_INLINE });
    const disabled = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', limit }),
      ctx(),
    );

    expect(fitInline.spilled).toBe(false);
    expect(spilled.spilled).toBe(true);
    expect(disabled.canvasDisabled).toBe(true);
    expect([
      fitInline.activities.length,
      spilled.activities.length,
      disabled.activities.length,
    ]).toEqual([limit, limit, limit]);
  });

  it('applies the server default limit when the caller omits it', async () => {
    mockUpstream({ honest: FITS_INLINE, rows: FITS_INLINE });
    const { result } = await withCanvas({ target_chembl_id: 'CHEMBL203' });
    expect(result.spilled).toBe(false);
    expect(result.activities).toHaveLength(getServerConfig().defaultLimit);
  });

  it('holds at the schema bounds of limit', async () => {
    mockUpstream({ honest: FITS_INLINE, rows: FITS_INLINE });
    const { result: one } = await withCanvas({ target_chembl_id: 'CHEMBL203', limit: 1 });
    expect(one.activities).toHaveLength(1);

    mockUpstream({ honest: FITS_INLINE, rows: FITS_INLINE });
    const { result: max } = await withCanvas({ target_chembl_id: 'CHEMBL203', limit: 1000 });
    expect(max.activities).toHaveLength(FITS_INLINE);
  });

  it('rejects a limit outside the schema bounds before the handler runs', () => {
    // 1001–10000 are served at 1000 with a notice (#41); past the 10000 ceiling is rejected.
    for (const limit of [0, -1, 10_001, 2.5]) {
      expect(() =>
        chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', limit }),
      ).toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caps both potency views, each echoing its own view with nothing staged', async () => {
    mockUpstream({ honest: 100, viewTotal: FITS_INLINE, rows: FITS_INLINE });
    const { result: ranked } = await withCanvas({ molecule_chembl_id: 'CHEMBL25', limit: 3 });
    expect(ranked.potency_view).toBe('potency_ranked');
    expect(ranked.activities).toHaveLength(3);
    expect(ranked.activities.every((a) => a.pchembl_value !== null)).toBe(true);

    mockUpstream({
      honest: 100,
      viewTotal: FITS_INLINE,
      rows: FITS_INLINE,
      row: rawNullActivity,
    });
    const { result: nullView, fake } = await withCanvas({
      molecule_chembl_id: 'CHEMBL25',
      potency_view: 'null_potency',
      limit: 3,
    });
    expect(nullView.potency_view).toBe('null_potency');
    expect(nullView.activities).toHaveLength(3);
    expect(nullView.activities.every((a) => a.pchembl_value === null)).toBe(true);
    expect(nullView.table_name).toBeNull();

    // Neither view staged anything, so neither held a canvas slot (#28).
    expect(fake.countForTenant({ tenantId: 'default' })).toBe(0);
  });

  it('stages the whole fit view on a supplied canvas while returning only limit rows (#31)', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const existing = await fake.acquire(undefined, { tenantId: 'default' });
    mockUpstream({ honest: FITS_INLINE, rows: FITS_INLINE });
    const c = ctx();
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({
        target_chembl_id: 'CHEMBL203',
        limit: 2,
        canvas_id: existing.canvasId,
      }),
      c,
    );

    expect(result.spilled).toBe(false);
    expect(result.activities).toHaveLength(2);
    expect(result.canvas_id).toBe(existing.canvasId);
    expect(result.table_name).toBe('bioactivities');
    expect(result.staged_row_count).toBe(FITS_INLINE);
    expect(fake.canvases.get(existing.canvasId)?.tables.get('bioactivities')?.rows).toHaveLength(
      FITS_INLINE,
    );
    expect(noticeOf(c)).toContain(`Showing 2 of the ${FITS_INLINE} rows`);
    const text = textOf(result);
    expect(text).toContain(`staged_row_count: ${FITS_INLINE}`);
    expect(text).not.toContain('preview is the full set');
  });

  it('slices the returned rows without shrinking the upstream drain', async () => {
    // 2 pages × 25 rows fit the budget whole, so the stream is walked to
    // exhaustion past the first page and only the OUTPUT is capped.
    mockPagedUpstream({ honest: 50, pages: 2, perPage: 25 });
    const { result } = await withCanvas({ target_chembl_id: 'CHEMBL203', limit: 1 });

    expect(result.spilled).toBe(false);
    expect(result.activities).toHaveLength(1);
    const streamFetches = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('order_by='),
    );
    expect(streamFetches).toHaveLength(2);
  });
});

describe('chembl_get_bioactivities — upstream page size (#29)', () => {
  /** A ranked view of `n` rows, most potent first in index order. */
  const corpus = (n: number) => Array.from({ length: n }, (_, i) => rawActivity(i));

  /** `[offset, limit]` of every view request, read through URLSearchParams. */
  const pages = () =>
    viewRequests(fetchMock.mock.calls).map((p) => [p.get('offset'), p.get('limit')]);

  const run = (input: Record<string, unknown>, c = ctx()) =>
    chemblGetBioactivities.handler(chemblGetBioactivities.input.parse(input), c);

  it('requests a page the size of limit when the canvas is off', async () => {
    setCanvas(undefined);
    fetchMock.mockImplementation(activityCorpus({ honest: 26600, rows: corpus(1200) }));
    const byDefault = await run({ target_chembl_id: 'CHEMBL203' });
    expect(pages()).toEqual([['0', String(getServerConfig().defaultLimit)]]);
    expect(byDefault.activities).toHaveLength(getServerConfig().defaultLimit);

    fetchMock.mockClear();
    const atMax = await run({ target_chembl_id: 'CHEMBL203', limit: 1000 });
    expect(pages()).toEqual([['0', '1000']]);
    expect(atMax.activities).toHaveLength(1000);
  });

  it('continues by offset in CHEMBL_MAX_PAGE_SIZE pages until limit rows are held', async () => {
    setCanvas(undefined);
    initChemblService({ ...getServerConfig(), maxPageSize: 200 });
    fetchMock.mockImplementation(activityCorpus({ honest: 26600, rows: corpus(1200) }));
    const result = await run({ target_chembl_id: 'CHEMBL203', limit: 500 });
    expect(pages()).toEqual([
      ['0', '200'],
      ['200', '200'],
      ['400', '200'],
    ]);
    expect(result.activities.map((a) => a.activity_id)).toEqual(
      corpus(500).map((row) => row.activity_id),
    );
  });

  it('keeps CHEMBL_MAX_PAGE_SIZE pages on the spill', async () => {
    fetchMock.mockImplementation(activityCorpus({ honest: 26600, rows: corpus(1200) }));
    const { result } = await withCanvas({ target_chembl_id: 'CHEMBL203', limit: 25 });
    expect(result.spilled).toBe(true);
    expect(result.staged_row_count).toBe(1200);
    expect(pages()).toEqual([
      ['0', '1000'],
      ['1000', '1000'],
    ]);
  });

  it('leaves the canvas-off rows, totals, and flags as they were', async () => {
    setCanvas(undefined);
    fetchMock.mockImplementation(activityCorpus({ honest: 26600, rows: corpus(1200) }));
    const c = ctx();
    const result = await run({ target_chembl_id: 'CHEMBL203', limit: 4 }, c);
    expect(result.activities.map((a) => a.activity_id)).toEqual([1000, 1001, 1002, 1003]);
    expect(result.totalCount).toBe(26600);
    expect(result.canvasDisabled).toBe(true);
    expect(result.spilled).toBe(false);
    expect(noticeOf(c)).toContain('of the 1200 rows in this view');
  });
});

describe('chembl_get_bioactivities — preview boundary disclosure', () => {
  it('names what the caller has versus what the view holds when limit bites', async () => {
    mockUpstream({ honest: FITS_INLINE, rows: FITS_INLINE });
    const c = ctx();
    await withCanvas({ target_chembl_id: 'CHEMBL203', limit: 2 }, c);

    const notice = noticeOf(c);
    expect(notice).toContain(`Showing rows 1–2 of the ${FITS_INLINE} rows in this view`);
    // Nothing was staged, so the rows past limit continue by cursor (#17), not a wider re-call.
    expect(notice).toContain('pass nextCursor back as cursor');
    expect(notice).not.toContain('raise limit');
    // Nothing was staged, so there is no table to describe or query.
    expect(notice).not.toContain('chembl_dataframe_');
  });

  it('carries both the preview bound and the cross-view pointer together', async () => {
    mockUpstream({ honest: 100, viewTotal: FITS_INLINE, rows: FITS_INLINE });
    const c = ctx();
    await withCanvas({ target_chembl_id: 'CHEMBL203', limit: 2 }, c);

    const notice = noticeOf(c);
    // The preview bound and the cross-view pointer are separate facts; both ship.
    expect(notice).toContain('pass nextCursor back as cursor');
    expect(notice).toContain(String(FITS_INLINE));
    expect(notice).toContain('Ranked by potency');
    expect(notice).toContain('null_potency');
  });

  it('reports the rows actually shown on the canvas-disabled branch', async () => {
    setCanvas(undefined);
    mockUpstream({ honest: FITS_INLINE, rows: FITS_INLINE });
    const c = ctx();
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', limit: 4 }),
      c,
    );
    expect(result.activities).toHaveLength(4);
    const notice = noticeOf(c);
    expect(notice).toBe(
      'Canvas disabled on this server (CANVAS_PROVIDER_TYPE=none): Showing rows 1–4 of the 58 rows in this view; pass nextCursor back as cursor, with the same filters and potency_view, for the next page. Nothing spilled, so SQL over the staged set is unavailable here.',
    );
    expect(notice).toContain(`Showing rows 1–4 of the ${FITS_INLINE} rows`);
    // The canvas-off page continues by cursor (#17), not by a wider re-call.
    expect(notice).toContain('pass nextCursor back as cursor');
    expect(notice).not.toContain('raise limit');
  });

  it('does not imply rows were held back when the canvas-disabled view fits under limit', async () => {
    setCanvas(undefined);
    mockUpstream({ honest: 3, rows: 3 });
    const c = ctx();
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', limit: 25 }),
      c,
    );
    expect(result.activities).toHaveLength(3);
    const notice = noticeOf(c);
    expect(notice).toContain('Showing all 3 rows');
    expect(notice).not.toContain('raise limit');
    // The count the caller can act on is the rows shown, not the ceiling asked for.
    expect(notice).not.toContain('25');
  });

  it('keeps the no-match notice for an empty view', async () => {
    mockUpstream({ honest: 0, rows: 0 });
    const c = ctx();
    const { result } = await withCanvas({ target_chembl_id: 'CHEMBL203', limit: 2 }, c);
    expect(result.activities).toEqual([]);
    expect(noticeOf(c)).toContain('No measurements matched');
    expect(noticeOf(c)).not.toContain('raise limit');
  });

  it('does not present a limit-capped fit-inline preview as the full set in format()', async () => {
    mockUpstream({ honest: FITS_INLINE, rows: FITS_INLINE });
    const { result } = await withCanvas({ target_chembl_id: 'CHEMBL203', limit: 2 });

    const text = textOf(result);
    expect(text).toContain(`**${FITS_INLINE}** measurements total`);
    expect(text).toContain(`showing 2 of ${FITS_INLINE} matching measurements`);
    expect(text).not.toContain('preview is the full set');
    expect(text).toContain('staged_row_count: — (nothing staged)');
    expect(text).toContain('truncated: no');
    // A content[]-only client reaches the rest the same way.
    expect(text).toContain(`cursor="${result.nextCursor}"`);
  });
});

describe('chembl_get_bioactivities — a spill shows limit rows of real width', () => {
  /**
   * A row as wide as a real EGFR binding measurement with its comment, variant, and
   * source document: ~1,320 serialized characters, past the budget's 800 per row, so
   * once `limit` lifts the budget above its 50,000 floor the drain buffer holds fewer
   * rows than `limit`, and the preview still shows `limit`.
   */
  function wideActivity(i: number): Record<string, unknown> {
    return {
      ...rawActivity(i),
      assay_description:
        `Inhibition of recombinant human EGFR L858R/T790M double mutant kinase domain expressed in baculovirus-infected Sf9 cells, using poly(Glu,Tyr) 4:1 as substrate after 60 mins by ELISA, replicate ${i}; `.repeat(
          3,
        ),
      activity_comment: 'Not Active',
      data_validity_comment: 'Outside typical range',
      assay_variant_mutation: 'L858R,T790M',
      assay_variant_accession: 'P00533',
      document_chembl_id: `CHEMBL${1_100_000 + i}`,
      document_year: 2012,
    };
  }

  /**
   * A row far wider than any per-row factor the budget could carry (an assay
   * description of ~2,700 characters, as the longest real EGFR functional assays
   * run): a spill must still show `limit` of them, so the preview cannot depend on
   * how many rows the drain buffer held.
   */
  function veryWideActivity(i: number): Record<string, unknown> {
    return {
      ...wideActivity(i),
      assay_description:
        `Inhibition of EGFR L858R/T790M/C797S triple mutant autophosphorylation in Ba/F3 cells, replicate ${i}; `.repeat(
          27,
        ),
    };
  }

  /** Each row shape at the serialized width its doc names, with a limit and a view size that spills. */
  it.each([
    { width: '~1,320', build: wideActivity, min: 1250, max: 1400, limit: 1000, rows: 1500 },
    { width: '~1,320', build: wideActivity, min: 1250, max: 1400, limit: 200, rows: 1500 },
    { width: '~1,320', build: wideActivity, min: 1250, max: 1400, limit: 25, rows: 1500 },
    { width: '~3,500', build: veryWideActivity, min: 3300, max: 3700, limit: 100, rows: 300 },
    { width: '~3,500', build: veryWideActivity, min: 3300, max: 3700, limit: 1000, rows: 1100 },
  ])(
    'shows the first $limit of $rows $width-character rows inline when the view spills',
    async ({ build, min, max, limit, rows }) => {
      fetchMock.mockImplementation(
        activityCorpus({ honest: rows, rows: Array.from({ length: rows }, (_, i) => build(i)) }),
      );
      const { result } = await withCanvas({ target_chembl_id: 'CHEMBL203', limit });
      const width = JSON.stringify(result.activities[0]).length;
      expect(width).toBeGreaterThan(min);
      expect(width).toBeLessThan(max);
      expect(result.spilled).toBe(true);
      expect(result.staged_row_count).toBe(rows);
      // The preview is the view's first `limit` rows, in view order.
      expect(result.activities.map((a) => a.activity_id)).toEqual(
        Array.from({ length: limit }, (_, i) => 1000 + i),
      );
    },
  );
});

describe('chembl_get_bioactivities — fit-vs-spill line sits at about limit average rows', () => {
  /**
   * `rawActivity` serializes to ~745 characters, inside the 690–870 average of real
   * rows. A view of 1.5 × `limit` such rows has to spill, so the whole view is
   * SQL-queryable from the canvas_id it returns; returning `limit` rows plus a
   * cursor with nothing staged would leave the caller no way to query the view.
   */
  it('builds its rows at an average real width', async () => {
    fetchMock.mockImplementation(
      activityCorpus({
        honest: 1500,
        rows: Array.from({ length: 1500 }, (_, i) => rawActivity(i)),
      }),
    );
    const { result } = await withCanvas({ target_chembl_id: 'CHEMBL203', limit: 1000 });
    const widths = result.activities.map((a) => JSON.stringify(a).length);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(690);
    expect(Math.max(...widths)).toBeLessThanOrEqual(870);
  });

  it.each([
    [1000, 1500],
    [100, 150],
  ])('at limit %i, spills a view of %i average-width rows', async (limit, rows) => {
    fetchMock.mockImplementation(
      activityCorpus({
        honest: rows,
        rows: Array.from({ length: rows }, (_, i) => rawActivity(i)),
      }),
    );
    const { result, fake } = await withCanvas({ target_chembl_id: 'CHEMBL203', limit });
    expect(result.spilled).toBe(true);
    expect(result.canvas_id).not.toBeNull();
    expect(result.table_name).toBe('bioactivities');
    expect(result.staged_row_count).toBe(rows);
    expect(result.activities).toHaveLength(limit);
    expect(result.nextCursor).toBeUndefined();
    expect(fake.canvases.size).toBe(1);
  });

  it.each([1000, 100])(
    'keeps a view of exactly limit (%i) average-width rows inline, nothing staged',
    async (limit) => {
      fetchMock.mockImplementation(
        activityCorpus({
          honest: limit,
          rows: Array.from({ length: limit }, (_, i) => rawActivity(i)),
        }),
      );
      const { result, fake } = await withCanvas({ target_chembl_id: 'CHEMBL203', limit });
      expect(result.spilled).toBe(false);
      expect(result.canvas_id).toBeNull();
      expect(result.activities).toHaveLength(limit);
      expect(result.nextCursor).toBeUndefined();
      expect(fake.canvases.size).toBe(0);
    },
  );
});
