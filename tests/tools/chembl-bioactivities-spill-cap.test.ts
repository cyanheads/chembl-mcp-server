/**
 * @fileoverview Tests for the bioactivity spill row cap (#14) — the bound on the
 * upstream page drain `chembl_get_bioactivities` hands to `spillover()`. Isolated
 * in its own file because it stubs CHEMBL_MAX_SPILL_ROWS before the lazily-cached
 * server config is first parsed; Vitest runs each file in its own worker, so the
 * small cap never leaks into the other suites.
 *
 * Covered: the cap trips mid-drain (staged table holds exactly the cap, truncation
 * disclosed on `structuredContent` and in `format()`), the same cap applies to the
 * opt-in null-potency retrieval path #9 adds, and the regression case — a spill
 * that stays under the cap reports `truncated: false` and stages every row.
 * @module tests/tools/chembl-bioactivities-spill-cap
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblGetBioactivities } from '@/mcp-server/tools/definitions/chembl-get-bioactivities.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { initChemblService } from '@/services/chembl/chembl-service.js';
import { FakeDataCanvas } from '../_fake-canvas.js';

/**
 * Cap for this file. A `rawActivity` row serializes to ~585 chars, so the 40 KB
 * preview budget buffers ~68 rows before the overflow sentinel — a cap of 100
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

/** Multi-page variant: `pages` pages of `perPage` rows chained via `page_meta.next`. */
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
    expect(result.staged_row_count).toBe(TEST_CAP);

    /**
     * The bound this test exists for: the drain must stop paging once the cap is
     * reached, not follow page_meta.next to exhaustion. Three pages cover the 100
     * staged rows plus the one look-ahead row that proves upstream had more (what
     * makes `truncated` honest) — far short of the 20 pages on offer.
     */
    const streamFetches = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('order_by='),
    );
    expect(streamFetches).toHaveLength(3);
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
    // 90 rows overflows the 40 KB preview budget (spills) but stays under the cap.
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
