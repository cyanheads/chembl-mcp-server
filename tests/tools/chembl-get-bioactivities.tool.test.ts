/**
 * @fileoverview Behavior tests for the chembl_get_bioactivities flagship beyond
 * the XOR gate: the canvas-disabled path (preview capped at limit, no spill,
 * canvasDisabled enrichment), the empty-result notice, the DataCanvas spill path
 * (full set staged → canvas_id + spilled:true + table_name "bioactivities" with
 * the staged rows queryable), canvas reuse via canvas_id, the no-spill canvas
 * path, and the pure format() (spill note + "not reported" for null potency).
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
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ activities, page_meta: { total_count: 26600, next: null } }),
    );
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
    expect(result.totalFound).toBe(26600);
    const enrichment = getEnrichment(c) as { canvasDisabled?: boolean; notice?: string };
    expect(enrichment.canvasDisabled).toBe(true);
    expect(enrichment.notice).toContain('Canvas disabled');
  });

  it('emits a no-match notice for an empty result', async () => {
    setCanvas(undefined);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ activities: [], page_meta: { total_count: 0, next: null } }),
    );
    const c = ctx();
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ molecule_chembl_id: 'CHEMBL25', standard_type: 'IC50' }),
      c,
    );
    expect(result.activities).toEqual([]);
    expect(result.totalFound).toBe(0);
    expect((getEnrichment(c) as { notice?: string }).notice).toContain('No measurements matched');
  });
});

describe('chembl_get_bioactivities — DataCanvas spill', () => {
  it('stages the full set to the bioactivities table and returns canvas_id + spilled:true', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    // ~120 fat rows overflow the 40KB preview budget, forcing a spill.
    const activities = Array.from({ length: 120 }, (_, i) => rawActivity(i));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ activities, page_meta: { total_count: 26600, next: null } }),
    );
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
    // The inline preview is capped at the requested limit, not the whole set.
    expect(result.activities.length).toBeLessThanOrEqual(25);
    expect(result.totalFound).toBe(26600);

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
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ activities, page_meta: { total_count: 999, next: null } }),
    );
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
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ activities, page_meta: { total_count: 3, next: null } }),
    );
    const result = await chemblGetBioactivities.handler(
      chemblGetBioactivities.input.parse({ target_chembl_id: 'CHEMBL203', limit: 25 }),
      ctx(),
    );
    expect(result.spilled).toBe(false);
    expect(result.canvas_id).toBeNull();
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
      totalFound: 26600,
      spilled: true,
      canvas_id: 'abc1234567',
      table_name: 'bioactivities',
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
      totalFound: 1,
      spilled: false,
      canvas_id: null,
      table_name: null,
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
      totalFound: 0,
      spilled: false,
      canvas_id: null,
      table_name: null,
    });
    expect((blocks[0] as { text: string }).text).toContain('No rows in preview');
  });
});
