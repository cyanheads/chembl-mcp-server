/**
 * @fileoverview Behavior tests for chembl_search_molecules beyond the input gate:
 * name + structure search happy paths through a stubbed upstream, the
 * empty-result notice, truncation enrichment at the limit boundary, and the pure
 * format() — null fields render as "—"/(unnamed) and the similarity line appears
 * only on structure results.
 * @module tests/tools/chembl-search-molecules.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblSearchMolecules } from '@/mcp-server/tools/definitions/chembl-search-molecules.tool.js';
import { initChemblService } from '@/services/chembl/chembl-service.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
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
});

const ctx = () => createMockContext({ tenantId: 'default', errors: chemblSearchMolecules.errors });

const aspirinRaw = {
  molecule_chembl_id: 'CHEMBL25',
  pref_name: 'ASPIRIN',
  max_phase: '4',
  molecule_structures: {
    canonical_smiles: 'CC(=O)Oc1ccccc1C(=O)O',
    standard_inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
  },
  molecule_properties: { full_molformula: 'C9H8O4', mw_freebase: '180.16', alogp: '1.31' },
};

describe('chembl_search_molecules — name search', () => {
  it('returns coerced molecules for a name query', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ molecules: [aspirinRaw], page_meta: { total_count: 1 } }),
    );
    const c = ctx();
    const result = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({ query: 'aspirin' }),
      c,
    );
    expect(result.molecules).toHaveLength(1);
    expect(result.molecules[0]).toMatchObject({
      molecule_chembl_id: 'CHEMBL25',
      max_phase: 4,
      mw_freebase: 180.16,
    });
    // similarity must be absent on a name search.
    expect(result.molecules[0]?.similarity).toBeUndefined();
    expect(getEnrichment(c)).toMatchObject({ totalCount: 1, truncated: false, shown: 1 });
  });

  it('emits a notice and no molecules when nothing matched', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ molecules: [], page_meta: { total_count: 0 } }));
    const c = ctx();
    const result = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({ query: 'notarealcompound' }),
      c,
    );
    expect(result.molecules).toEqual([]);
    const enrichment = getEnrichment(c) as { notice?: string };
    expect(enrichment.notice).toContain('notarealcompound');
  });

  it('flags truncation when the result fills the limit and more exist upstream', async () => {
    const molecules = Array.from({ length: 2 }, (_, i) => ({
      ...aspirinRaw,
      molecule_chembl_id: `CHEMBL${i}`,
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ molecules, page_meta: { total_count: 500 } }));
    const c = ctx();
    await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({ query: 'kinase', limit: 2 }),
      c,
    );
    expect(getEnrichment(c)).toMatchObject({ truncated: true, shown: 2, cap: 2 });
  });
});

describe('chembl_search_molecules — structure search', () => {
  it('carries the Tanimoto similarity percent on similarity results', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        molecules: [{ ...aspirinRaw, similarity: '87.5' }],
        page_meta: { total_count: 1 },
      }),
    );
    const result = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({
        structure: 'CC(=O)Oc1ccccc1C(=O)O',
        search_type: 'similarity',
        similarity_threshold: 80,
      }),
      ctx(),
    );
    expect(result.molecules[0]?.similarity).toBe(87.5);
  });
});

describe('chembl_search_molecules — input boundaries', () => {
  it('rejects similarity_threshold below the ChEMBL floor of 40 at the schema', () => {
    expect(() =>
      chemblSearchMolecules.input.parse({
        structure: 'CCO',
        search_type: 'similarity',
        similarity_threshold: 39,
      }),
    ).toThrow();
  });

  it('rejects a limit above 100 at the schema', () => {
    expect(() => chemblSearchMolecules.input.parse({ query: 'x', limit: 101 })).toThrow();
  });

  it('rejects max_phase_min above 4 at the schema', () => {
    expect(() => chemblSearchMolecules.input.parse({ query: 'x', max_phase_min: 5 })).toThrow();
  });
});

describe('chembl_search_molecules format()', () => {
  it('renders ChEMBL ID, phase, and properties, with — for null fields', () => {
    const blocks = chemblSearchMolecules.format!({
      molecules: [
        {
          molecule_chembl_id: 'CHEMBL999',
          pref_name: null,
          canonical_smiles: null,
          standard_inchi_key: null,
          full_molformula: null,
          mw_freebase: null,
          alogp: null,
          num_ro5_violations: null,
          qed_weighted: null,
          max_phase: null,
          molecule_type: null,
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**CHEMBL999**');
    expect(text).toContain('(unnamed)');
    expect(text).toContain('phase —');
    expect(text).toContain('MW: —');
    // No similarity line when the field is absent.
    expect(text).not.toContain('Similarity:');
  });

  it('renders the similarity line when present', () => {
    const blocks = chemblSearchMolecules.format!({
      molecules: [
        {
          molecule_chembl_id: 'CHEMBL25',
          pref_name: 'ASPIRIN',
          canonical_smiles: 'CC(=O)Oc1ccccc1C(=O)O',
          standard_inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
          full_molformula: 'C9H8O4',
          mw_freebase: 180.16,
          alogp: 1.31,
          num_ro5_violations: 0,
          qed_weighted: 0.55,
          max_phase: 4,
          molecule_type: 'Small molecule',
          similarity: 87.5,
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Similarity: 87.5%');
    expect(text).toContain('phase 4');
  });

  it('renders the empty marker for no molecules', () => {
    const blocks = chemblSearchMolecules.format!({ molecules: [] });
    expect((blocks[0] as { text: string }).text).toContain('No matching compounds');
  });
});
