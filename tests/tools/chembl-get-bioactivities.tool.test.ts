/**
 * @fileoverview Behavior tests for the chembl_get_bioactivities flagship beyond
 * the XOR gate: the canvas-disabled path (preview capped at limit, no spill,
 * canvasDisabled output flag), the empty-result notice, the two-phase honest
 * totalCount + potency-ranked preview (#3: isnull=false on the stream, not the
 * count), the DataCanvas spill path (staged set → canvas_id + spilled:true +
 * table_name "bioactivities" with the staged rows queryable), canvas reuse via
 * canvas_id, the no-spill canvas path, and the pure format() (spill note,
 * "not reported" for null potency, and the canvas-disabled cap notice for #4).
 *
 * The DataCanvas is a structural fake wired via setCanvas — the handler runs its
 * real spillover()/acquire() paths against it; `fetch` is stubbed so no live
 * ChEMBL call is made.
 * @module tests/tools/chembl-get-bioactivities.tool
 */

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
 * Script the two-phase upstream (#3): the honest count call (no isnull filter) returns
 * `honest`; the potency-filtered stream call (URL carries `pchembl_value__isnull=false`)
 * returns `activities` with `potent` as its page total. URL-aware so call order is
 * irrelevant. `potent` defaults to `honest` (no null-potency rows excluded).
 */
function mockUpstream(opts: {
  honest: number;
  potent?: number;
  activities: Record<string, unknown>[];
}): void {
  const potent = opts.potent ?? opts.honest;
  fetchMock.mockImplementation((url: string | URL) => {
    const isStream = String(url).includes('pchembl_value__isnull=false');
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
      spilled: true,
      canvas_id: 'abc1234567',
      table_name: 'bioactivities',
      canvasDisabled: false,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**26600** measurements total');
    expect(text).toContain('spilled: yes');
    expect(text).toContain('`bioactivities`');
    expect(text).toContain('**CHEMBL68920**');
    expect(text).toContain('IC50: =41 nM');
    expect(text).toContain('pChEMBL: 7.39');
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
      spilled: false,
      canvas_id: null,
      table_name: null,
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
      spilled: false,
      canvas_id: null,
      table_name: null,
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
      spilled: false,
      canvas_id: null,
      table_name: null,
      canvasDisabled: true,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**26600** measurements total');
    expect(text).not.toContain('preview is the full set');
    expect(text).toContain('canvas disabled');
    expect(text).toContain('capped preview');
  });
});
