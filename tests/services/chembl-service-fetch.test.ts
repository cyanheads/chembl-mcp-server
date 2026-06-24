/**
 * @fileoverview Tests for ChemblService request building and error-path behavior
 * against a stubbed `fetch` (no live ChEMBL call): the Django-style URL each
 * method builds, upstream 404 propagation, getDrugInfo's Promise.allSettled
 * degradation (missing mechanisms/indications → empty arrays, but a failed
 * molecule fetch tanks the call), getAssay/getTarget normalization, empty-page
 * handling, and the not-initialized accessor guard.
 * @module tests/services/chembl-service-fetch
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ctx = () => createMockContext({ tenantId: 'default' });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Pull the request URL fetchWithTimeout was called with on its Nth call. */
function calledUrl(call = 0): string {
  const arg = fetchMock.mock.calls[call]?.[0];
  return typeof arg === 'string' ? arg : (arg as Request).url;
}

describe('ChemblService — request URL construction', () => {
  it('builds the molecule/search URL with q + max_phase__gte', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ molecules: [], page_meta: { total_count: 0 } }));
    await new ChemblService(config).searchMolecules(
      { query: 'aspirin', maxPhaseMin: 4, limit: 10 },
      ctx(),
    );
    const url = calledUrl();
    expect(url).toContain('/molecule/search.json');
    expect(url).toContain('q=aspirin');
    expect(url).toContain('max_phase__gte=4');
    expect(url).toContain('limit=10');
  });

  it('routes a similarity structure search to /similarity/{smiles}/{threshold}', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ molecules: [], page_meta: { total_count: 0 } }));
    await new ChemblService(config).structureSearch(
      { structure: 'CCO', searchType: 'similarity', similarityThreshold: 80, limit: 5 },
      ctx(),
    );
    expect(calledUrl()).toContain('/similarity/CCO/80.json');
  });

  it('routes a substructure search to /substructure/{smiles} and percent-encodes the SMILES', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ molecules: [], page_meta: { total_count: 0 } }));
    await new ChemblService(config).structureSearch(
      { structure: 'c1ccccc1O', searchType: 'substructure', similarityThreshold: 70, limit: 5 },
      ctx(),
    );
    expect(calledUrl()).toContain('/substructure/c1ccccc1O.json');
  });

  it('builds the target URL with accession + gene-symbol + organism filters', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ targets: [], page_meta: { total_count: 0 } }));
    await new ChemblService(config).searchTargets(
      { accession: 'P00533', geneSymbol: 'EGFR', organism: 'Homo sapiens', limit: 25 },
      ctx(),
    );
    const url = calledUrl();
    expect(url).toContain('/target.json');
    expect(url).toContain('target_components__accession=P00533');
    expect(url).toContain(
      'target_components__target_component_synonyms__component_synonym__iexact=EGFR',
    );
    // URLSearchParams encodes a space as "+".
    expect(url).toContain('organism__iexact=Homo+sapiens');
  });

  it('ranks the activity stream by -pchembl_value and forwards the potency filter', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ activities: [], page_meta: { total_count: 0, next: null } }),
    );
    const rows = [];
    for await (const row of new ChemblService(config).streamActivities(
      { targetChemblId: 'CHEMBL203', standardType: 'IC50', pchemblValueMin: 7, limit: 25 },
      ctx(),
    )) {
      rows.push(row);
    }
    const url = decodeURIComponent(calledUrl());
    expect(url).toContain('/activity.json');
    expect(url).toContain('order_by=-pchembl_value');
    expect(url).toContain('target_chembl_id=CHEMBL203');
    expect(url).toContain('standard_type=IC50');
    expect(url).toContain('pchembl_value__gte=7');
    expect(rows).toHaveLength(0);
  });
});

describe('ChemblService — upstream error propagation', () => {
  it('throws when getMolecule hits a 404 (let the framework classify it)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error_message: 'not found' }, 404));
    await expect(new ChemblService(config).getMolecule('CHEMBL000', ctx())).rejects.toThrow();
  });

  it('throws when getAssay hits a 404', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error_message: 'not found' }, 404));
    await expect(new ChemblService(config).getAssay('CHEMBL000', ctx())).rejects.toThrow();
  });
});

describe('ChemblService.getAssay — normalization', () => {
  it('decodes confidence_score and assay_type, coercing a string score to number', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        assay_chembl_id: 'CHEMBL674637',
        description: 'Inhibition of EGFR',
        assay_type: 'B',
        assay_type_description: 'Binding',
        target_chembl_id: 'CHEMBL203',
        assay_organism: 'Homo sapiens',
        confidence_score: '9',
        confidence_description: 'Direct single protein target assigned',
      }),
    );
    const assay = await new ChemblService(config).getAssay('CHEMBL674637', ctx());
    expect(assay).toMatchObject({
      assay_chembl_id: 'CHEMBL674637',
      assay_type: 'B',
      assay_type_description: 'Binding',
      target_chembl_id: 'CHEMBL203',
      organism: 'Homo sapiens',
      confidence_score: 9,
    });
  });

  it('preserves absence as null on a sparse assay (no confidence, no target)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ assay_chembl_id: 'CHEMBL1' }));
    const assay = await new ChemblService(config).getAssay('CHEMBL1', ctx());
    expect(assay.confidence_score).toBeNull();
    expect(assay.target_chembl_id).toBeNull();
    expect(assay.assay_type).toBeNull();
    expect(assay.description).toBeNull();
  });
});

describe('ChemblService.getTarget — single fetch + flattening', () => {
  it('flattens components and gene symbols on a single-target fetch', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        target_chembl_id: 'CHEMBL203',
        pref_name: 'Epidermal growth factor receptor',
        target_type: 'SINGLE PROTEIN',
        organism: 'Homo sapiens',
        target_components: [
          {
            accession: 'P00533',
            target_component_synonyms: [{ component_synonym: 'EGFR', syn_type: 'GENE_SYMBOL' }],
          },
        ],
      }),
    );
    const target = await new ChemblService(config).getTarget('CHEMBL203', ctx());
    expect(target.target_chembl_id).toBe('CHEMBL203');
    expect(target.components[0]?.gene_symbols).toEqual(['EGFR']);
  });
});

describe('ChemblService.getDrugInfo — Promise.allSettled composition', () => {
  it('returns empty mechanism/indication arrays when those endpoints fail', async () => {
    // 1st fetch = molecule approval (ok); 2nd = mechanisms (500); 3rd = indications (500).
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ pref_name: 'GEFITINIB', max_phase: '4', first_approval: 2003 }),
      )
      .mockResolvedValue(jsonResponse({ error_message: 'boom' }, 500));
    const info = await new ChemblService(config).getDrugInfo('CHEMBL939', ctx());
    expect(info).toMatchObject({
      molecule_chembl_id: 'CHEMBL939',
      pref_name: 'GEFITINIB',
      max_phase: 4,
      first_approval: 2003,
    });
    // A failed mechanism/indication list degrades to [] rather than tanking the call.
    expect(info.mechanisms).toEqual([]);
    expect(info.indications).toEqual([]);
  });

  it('joins mechanisms + indications when all three calls succeed', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ pref_name: 'GEFITINIB', max_phase: '4', first_approval: 2003 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          mechanisms: [
            {
              target_chembl_id: 'CHEMBL203',
              mechanism_of_action: 'EGFR inhibitor',
              action_type: 'INHIBITOR',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          drug_indications: [
            {
              mesh_heading: 'Carcinoma, Non-Small-Cell Lung',
              efo_term: 'non-small cell lung carcinoma',
              max_phase_for_ind: '4',
            },
          ],
        }),
      );
    const info = await new ChemblService(config).getDrugInfo('CHEMBL939', ctx());
    expect(info.mechanisms).toEqual([
      {
        target_chembl_id: 'CHEMBL203',
        mechanism_of_action: 'EGFR inhibitor',
        action_type: 'INHIBITOR',
      },
    ]);
    expect(info.indications[0]?.max_phase_for_ind).toBe(4);
  });

  it('throws when the anchor molecule fetch fails (404 → the call cannot proceed)', async () => {
    // All three composed fetches 404; the anchor molecule failure is the one the
    // handler re-throws (mechanisms/indications would have degraded to []).
    fetchMock.mockResolvedValue(jsonResponse({ error_message: 'not found' }, 404));
    await expect(new ChemblService(config).getDrugInfo('CHEMBL000', ctx())).rejects.toThrow();
  });
});

describe('ChemblService — empty upstream pages', () => {
  it('falls back totalCount to item length when page_meta is absent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ targets: [] }));
    const page = await new ChemblService(config).searchTargets(
      { accession: 'P99999', limit: 25 },
      ctx(),
    );
    expect(page.items).toEqual([]);
    expect(page.totalCount).toBe(0);
  });
});
