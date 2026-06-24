/**
 * @fileoverview Tests for ChemblService normalization + flattening against
 * controlled upstream payloads — including a sparse payload with omitted fields,
 * verifying absence is preserved as null rather than fabricated. `fetch` is
 * stubbed so no live ChEMBL call is made.
 * @module tests/services/chembl-service
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChemblService } from '@/services/chembl/chembl-service.js';

const config = {
  apiBaseUrl: 'https://www.ebi.ac.uk/chembl/api/data',
  requestTimeoutMs: 5000,
  maxPageSize: 1000,
  defaultLimit: 25,
  dataframeDropEnabled: false,
};

/** Build a Response-like object that fetchWithTimeout accepts (ok + json()). */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ChemblService.getMolecule — full + sparse payloads', () => {
  it('flattens nested structures/properties and coerces string numerics', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        molecule_chembl_id: 'CHEMBL25',
        pref_name: 'ASPIRIN',
        max_phase: '4.0',
        molecule_type: 'Small molecule',
        molecule_structures: {
          canonical_smiles: 'CC(=O)Oc1ccccc1C(=O)O',
          standard_inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
        },
        molecule_properties: {
          full_molformula: 'C9H8O4',
          mw_freebase: '180.16',
          alogp: '1.31',
          num_ro5_violations: 0,
          qed_weighted: '0.55',
        },
      }),
    );
    const svc = new ChemblService(config);
    const mol = await svc.getMolecule('CHEMBL25', createMockContext({ tenantId: 'default' }));
    expect(mol).toMatchObject({
      molecule_chembl_id: 'CHEMBL25',
      pref_name: 'ASPIRIN',
      max_phase: 4,
      mw_freebase: 180.16,
      alogp: 1.31,
      num_ro5_violations: 0,
      qed_weighted: 0.55,
      full_molformula: 'C9H8O4',
      canonical_smiles: 'CC(=O)Oc1ccccc1C(=O)O',
      standard_inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
      molecule_type: 'Small molecule',
    });
  });

  it('preserves absence as null on a sparse payload (omitted fields)', async () => {
    // A research compound with no name, no properties block, no structures.
    fetchMock.mockResolvedValueOnce(jsonResponse({ molecule_chembl_id: 'CHEMBL999999' }));
    const svc = new ChemblService(config);
    const mol = await svc.getMolecule('CHEMBL999999', createMockContext({ tenantId: 'default' }));
    expect(mol.molecule_chembl_id).toBe('CHEMBL999999');
    expect(mol.pref_name).toBeNull();
    expect(mol.mw_freebase).toBeNull();
    expect(mol.alogp).toBeNull();
    expect(mol.max_phase).toBeNull();
    expect(mol.canonical_smiles).toBeNull();
    expect(mol.full_molformula).toBeNull();
    // similarity must be absent (not null) on a plain fetch — it's only on structure search.
    expect(mol.similarity).toBeUndefined();
  });
});

describe('ChemblService.searchTargets — gene-symbol flattening', () => {
  it('flattens GENE_SYMBOL/GENE_SYMBOL_OTHER synonyms per component', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        targets: [
          {
            target_chembl_id: 'CHEMBL203',
            pref_name: 'Epidermal growth factor receptor',
            target_type: 'SINGLE PROTEIN',
            organism: 'Homo sapiens',
            target_components: [
              {
                accession: 'P00533',
                target_component_synonyms: [
                  { component_synonym: '2.7.10.1', syn_type: 'EC_NUMBER' },
                  { component_synonym: 'EGFR', syn_type: 'GENE_SYMBOL' },
                  { component_synonym: 'ERBB1', syn_type: 'GENE_SYMBOL_OTHER' },
                  {
                    component_synonym: 'Receptor tyrosine-protein kinase erbB-1',
                    syn_type: 'UNIPROT',
                  },
                ],
              },
            ],
          },
        ],
        page_meta: { total_count: 1 },
      }),
    );
    const svc = new ChemblService(config);
    const page = await svc.searchTargets(
      { accession: 'P00533', limit: 25 },
      createMockContext({ tenantId: 'default' }),
    );
    expect(page.totalCount).toBe(1);
    expect(page.items[0]?.components[0]?.accession).toBe('P00533');
    // Only GENE_SYMBOL* synonyms — not EC_NUMBER / UNIPROT.
    expect(page.items[0]?.components[0]?.gene_symbols).toEqual(['EGFR', 'ERBB1']);
  });
});

describe('ChemblService.streamActivities — coercion + raw passthrough', () => {
  it('coerces standard_value/pchembl to numbers and carries raw fields, reporting total', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        activities: [
          {
            activity_id: 32260,
            molecule_chembl_id: 'CHEMBL68920',
            target_chembl_id: 'CHEMBL203',
            assay_chembl_id: 'CHEMBL674637',
            standard_type: 'IC50',
            standard_relation: '=',
            standard_value: '41.0',
            standard_units: 'nM',
            pchembl_value: '7.39',
            type: 'IC50',
            value: '0.041',
            units: 'uM',
            relation: '=',
          },
          {
            // Sparse row: missing standard_value must be null, never 0.
            activity_id: 99,
            molecule_chembl_id: 'CHEMBL1',
            target_chembl_id: 'CHEMBL203',
            assay_chembl_id: 'CHEMBL2',
            standard_type: 'IC50',
          },
        ],
        page_meta: { total_count: 26600, next: null },
      }),
    );
    const svc = new ChemblService(config);
    let total = -1;
    const rows = [];
    for await (const row of svc.streamActivities(
      { targetChemblId: 'CHEMBL203', standardType: 'IC50', limit: 25 },
      createMockContext({ tenantId: 'default' }),
      (t) => {
        total = t;
      },
    )) {
      rows.push(row);
    }
    expect(total).toBe(26600);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      standard_value: 41,
      pchembl_value: 7.39,
      value: '0.041', // raw carried alongside, not coerced
      units: 'uM',
    });
    // Sparse row: missing potency is null, not 0.
    expect(rows[1]?.standard_value).toBeNull();
    expect(rows[1]?.pchembl_value).toBeNull();
  });
});
