/**
 * @fileoverview Tests for the inline-preview boundary of chembl_get_bioactivities —
 * `limit` bounds the rows returned inline on ALL THREE response branches, not just
 * the two that happened to enforce it. `spillover()` sizes its preview buffer by a
 * character budget (`max(40_000, limit * 600)`), so the canvas-enabled branch where
 * the view fits inline drains ~68 rows regardless of how small `limit` is; the cap
 * is applied to the returned slice, never to the budget (which is what drives the
 * fit-vs-spill decision and its overflow sentinel).
 *
 * Covered: the boundary on each branch with `limit` above and below the row count,
 * schema bounds on `limit`, both `potency_view`s, a multi-page drain that must stay
 * untouched by the slice, and the honesty of both response surfaces — the notice
 * and `format()` must say what the caller has versus what matched, and must not
 * offer canvas guidance when nothing was staged.
 * @module tests/tools/chembl-bioactivities-preview-limit
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblGetBioactivities } from '@/mcp-server/tools/definitions/chembl-get-bioactivities.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { initChemblService } from '@/services/chembl/chembl-service.js';
import { FakeDataCanvas } from '../_fake-canvas.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A row serializing to ~585 chars, so ~68 of them fill the 40 KB preview budget.
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

/** Rows that fit the 40 KB preview budget whole — the branch under test. */
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

/** `pages` pages of `perPage` rows chained via `page_meta.next`, as ChEMBL does. */
function mockPagedUpstream(opts: { honest: number; pages: number; perPage: number }): void {
  fetchMock.mockImplementation((url: string | URL) => {
    const href = String(url);
    if (!href.includes('order_by=')) {
      return Promise.resolve(
        jsonResponse({ activities: [], page_meta: { total_count: opts.honest, next: null } }),
      );
    }
    const offset = Number(new URL(href).searchParams.get('offset') ?? 0);
    const page = Math.floor(offset / opts.perPage);
    const next =
      page + 1 < opts.pages
        ? `/chembl/api/data/activity.json?offset=${offset + opts.perPage}&order_by=x`
        : null;
    return Promise.resolve(
      jsonResponse({
        activities: Array.from({ length: opts.perPage }, (_, i) =>
          rawActivity(page * opts.perPage + i),
        ),
        page_meta: { total_count: opts.pages * opts.perPage, next },
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

    // The whole view fit under the 40 KB budget, so nothing spilled — and the
    // rows past `limit` are simply not returned, exactly as with no canvas.
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
    expect(result).toEqual(expect.schemaMatching(chemblGetBioactivities.output));
  });

  it('returns the whole view when limit exceeds the row count', async () => {
    mockUpstream({ honest: 3, rows: 3 });
    const c = ctx();
    const { result } = await withCanvas({ target_chembl_id: 'CHEMBL203', limit: 25 }, c);

    expect(result.spilled).toBe(false);
    expect(result.activities).toHaveLength(3);
    // Nothing was held back, so there is nothing to say.
    expect(noticeOf(c)).toBe('');
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
    for (const limit of [0, -1, 1001, 2.5]) {
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

    // Neither view staged anything — a fit-inline result is not a canvas result.
    const instance = await fake.acquire(undefined, { tenantId: 'default' });
    expect(await instance.describe()).toEqual([]);
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

describe('chembl_get_bioactivities — preview boundary disclosure', () => {
  it('names what the caller has versus what the view holds when limit bites', async () => {
    mockUpstream({ honest: FITS_INLINE, rows: FITS_INLINE });
    const c = ctx();
    await withCanvas({ target_chembl_id: 'CHEMBL203', limit: 2 }, c);

    const notice = noticeOf(c);
    expect(notice).toContain(`Showing 2 of the ${FITS_INLINE} rows in this view`);
    expect(notice).toContain('raise limit');
    // Nothing was staged, so there is no table to describe or query.
    expect(notice).not.toContain('chembl_dataframe_');
  });

  it('carries both the preview bound and the cross-view pointer together', async () => {
    mockUpstream({ honest: 100, viewTotal: FITS_INLINE, rows: FITS_INLINE });
    const c = ctx();
    await withCanvas({ target_chembl_id: 'CHEMBL203', limit: 2 }, c);

    const notice = noticeOf(c);
    // The preview bound and the cross-view pointer are separate facts; both ship.
    expect(notice).toContain('raise limit');
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
    expect(notice).toContain('Canvas disabled');
    expect(notice).toContain(`Showing 4 of the ${FITS_INLINE} rows`);
    expect(notice).toContain('raise limit');
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
  });
});
