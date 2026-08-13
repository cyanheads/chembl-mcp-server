/**
 * @fileoverview Tests for ChemblService normalization + flattening against
 * controlled upstream payloads — including a sparse payload with omitted fields,
 * verifying absence is preserved as null rather than fabricated — plus the
 * exact-shape routing of a name query (ChEMBL ID / InChIKey → the by-resource
 * lookup, everything else → the fuzzy endpoint) and the search modes that do and
 * do not carry a Tanimoto percent. `fetch` is stubbed so no live ChEMBL call is
 * made.
 * @module tests/services/chembl-service
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChemblService } from '@/services/chembl/chembl-service.js';

const config = {
  apiBaseUrl: 'https://www.ebi.ac.uk/chembl/api/data',
  requestTimeoutMs: 5000,
  maxPageSize: 1000,
  defaultLimit: 25,
  maxSpillRows: 50_000,
  dataframeDropEnabled: false,
};

/** Build a Response-like object that fetchWithTimeout accepts (ok + json()). */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
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

describe('ChemblService — the upstream search window', () => {
  const ctx = () => createMockContext({ tenantId: 'default' });

  /** Answer one scripted empty page and hand back the URL the service built. */
  async function searchUrl(run: (svc: ChemblService) => Promise<unknown>): Promise<string> {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ molecules: [], targets: [], page_meta: { total_count: 0 } }),
    );
    await run(new ChemblService(config));
    return String(fetchMock.mock.calls[0]?.[0]);
  }

  it('starts searchMolecules at offset=0 when the caller supplies none', async () => {
    const url = await searchUrl((svc) =>
      svc.searchMolecules({ query: 'kinase', limit: 25 }, ctx()),
    );
    expect(url).toContain('offset=0');
    expect(url).toContain('limit=25');
  });

  it('starts structureSearch at offset=0 when the caller supplies none', async () => {
    const url = await searchUrl((svc) =>
      svc.structureSearch(
        { structure: 'c1ccccc1', searchType: 'substructure', similarityThreshold: 70, limit: 25 },
        ctx(),
      ),
    );
    expect(url).toContain('offset=0');
    expect(url).toContain('limit=25');
  });

  it('starts searchTargets at offset=0 when the caller supplies none', async () => {
    const url = await searchUrl((svc) => svc.searchTargets({ query: 'kinase', limit: 25 }, ctx()));
    expect(url).toContain('offset=0');
    expect(url).toContain('limit=25');
  });

  /**
   * The offset is what a redeemed cursor widens (#12). ChEMBL silently substitutes
   * 0 for an offset it dislikes and answers 200, so an offset that never reaches
   * the URL reads as a successful first page — assert on the built request.
   */
  it('forwards the caller offset on searchMolecules', async () => {
    const url = await searchUrl((svc) =>
      svc.searchMolecules({ query: 'kinase', limit: 25, offset: 50 }, ctx()),
    );
    expect(url).toContain('offset=50');
    expect(url).not.toContain('offset=0');
  });

  it('forwards the caller offset on structureSearch', async () => {
    const url = await searchUrl((svc) =>
      svc.structureSearch(
        {
          structure: 'c1ccccc1',
          searchType: 'substructure',
          similarityThreshold: 70,
          limit: 25,
          offset: 75,
        },
        ctx(),
      ),
    );
    expect(url).toContain('offset=75');
    expect(url).not.toContain('offset=0');
  });

  it('forwards the caller offset on searchTargets', async () => {
    const url = await searchUrl((svc) =>
      svc.searchTargets({ query: 'kinase', limit: 25, offset: 100 }, ctx()),
    );
    expect(url).toContain('offset=100');
    expect(url).not.toContain('offset=0');
  });
});

/**
 * Routing a `search_type=name` query by input shape (#7). A ChEMBL ID and an
 * InChIKey are unique identifiers, so each resolves through the by-resource
 * lookup instead of the fuzzy full-text endpoint, whose Elasticsearch result
 * window reports 10000 for a query that matches nothing beyond the top hit.
 *
 * ChEMBL answers 200 for a query parameter it does not recognize, so a status
 * code proves nothing about which query ran — every case asserts the URL the
 * service built alongside the rows it returned.
 */
describe('ChemblService.searchMolecules — exact-shape routing', () => {
  const ctx = () => createMockContext({ tenantId: 'default' });

  /** The by-resource response: one molecule object, no `molecules` envelope. */
  const aspirinRecord = {
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
  };

  /** Answer every call — including a retry — with a fresh Response. */
  function stub(body: unknown, status = 200): void {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(body, status)));
  }
  const firstUrl = () => String(fetchMock.mock.calls[0]?.[0]);
  const search = (query: string, extra: { maxPhaseMin?: number; offset?: number } = {}) =>
    new ChemblService(config).searchMolecules({ query, limit: 25, ...extra }, ctx());

  it('resolves an InChIKey through the by-resource lookup, not the fuzzy endpoint', async () => {
    stub(aspirinRecord);
    const page = await search('BSYNRYMUTXBXSQ-UHFFFAOYSA-N');
    expect(firstUrl()).toContain('/molecule/BSYNRYMUTXBXSQ-UHFFFAOYSA-N.json');
    expect(firstUrl()).not.toContain('/molecule/search');
    // 1, not the 10000 Elasticsearch result window the fuzzy endpoint reports.
    expect(page.totalCount).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.molecule_chembl_id).toBe('CHEMBL25');
  });

  it('resolves a ChEMBL ID through the same by-resource lookup', async () => {
    stub(aspirinRecord);
    const page = await search('CHEMBL25');
    expect(firstUrl()).toContain('/molecule/CHEMBL25.json');
    expect(firstUrl()).not.toContain('/molecule/search');
    expect(page.totalCount).toBe(1);
    expect(page.items[0]?.molecule_chembl_id).toBe('CHEMBL25');
  });

  it('flattens the nested structures/properties on an exact hit, coercing numerics', async () => {
    stub(aspirinRecord);
    const page = await search('CHEMBL25');
    // The by-resource shape nests two levels deep; the exact path must flatten it
    // exactly as the fuzzy rows are flattened, not just surface the top-level id.
    expect(page.items[0]).toMatchObject({
      pref_name: 'ASPIRIN',
      max_phase: 4,
      molecule_type: 'Small molecule',
      canonical_smiles: 'CC(=O)Oc1ccccc1C(=O)O',
      standard_inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
      full_molformula: 'C9H8O4',
      mw_freebase: 180.16,
      alogp: 1.31,
      num_ro5_violations: 0,
      qed_weighted: 0.55,
    });
    // Only the similarity endpoint supplies a Tanimoto percent (#13).
    expect(page.items[0]?.similarity).toBeUndefined();
  });

  it('preserves absence as null on a sparse exact hit', async () => {
    stub({ molecule_chembl_id: 'CHEMBL999999' });
    const page = await search('CHEMBL999999');
    expect(page.totalCount).toBe(1);
    expect(page.items[0]).toMatchObject({
      molecule_chembl_id: 'CHEMBL999999',
      pref_name: null,
      mw_freebase: null,
      max_phase: null,
      canonical_smiles: null,
    });
  });

  it('leaves a plain name on the fuzzy endpoint', async () => {
    stub({ molecules: [{ molecule_chembl_id: 'CHEMBL25' }], page_meta: { total_count: 52 } });
    const page = await search('aspirin');
    expect(firstUrl()).toContain('/molecule/search.json');
    expect(firstUrl()).toContain('q=aspirin');
    expect(page.totalCount).toBe(52);
  });

  it.each([
    ['bsynrymutxbxsq-uhffffaoysa-n', 'lowercase InChIKey'],
    ['BSYNRYMUTXBXSQ-UHFFFAOYSA', 'InChIKey missing its final block'],
    ['BSYNRYMUTXBXSQ-UHFFFAOYSA-NN', 'InChIKey with an over-long final block'],
    ['CHEMBL', 'CHEMBL prefix with no number'],
    ['CHEMBL25 hydrate', 'ChEMBL ID with trailing words'],
    ['chembl25', 'lowercase ChEMBL ID'],
  ])('leaves %s on the fuzzy endpoint (%s)', async (query) => {
    stub({ molecules: [], page_meta: { total_count: 0 } });
    await search(query);
    expect(firstUrl()).toContain('/molecule/search.json');
  });

  /**
   * The by-resource lookup is a single record, so a filtered query stays on the
   * fuzzy endpoint — dropping the filter silently is the failure this guards.
   */
  it('falls back to the fuzzy endpoint when max_phase_min filters an exact-shaped query', async () => {
    stub({ molecules: [{ molecule_chembl_id: 'CHEMBL25' }], page_meta: { total_count: 3 } });
    const page = await search('CHEMBL25', { maxPhaseMin: 4 });
    expect(firstUrl()).toContain('/molecule/search.json');
    expect(firstUrl()).toContain('q=CHEMBL25');
    expect(firstUrl()).toContain('max_phase__gte=4');
    expect(page.totalCount).toBe(3);
  });

  it('keeps an InChIKey on the fuzzy endpoint under max_phase_min too', async () => {
    stub({ molecules: [], page_meta: { total_count: 0 } });
    await search('BSYNRYMUTXBXSQ-UHFFFAOYSA-N', { maxPhaseMin: 4 });
    expect(firstUrl()).toContain('/molecule/search.json');
    expect(firstUrl()).toContain('max_phase__gte=4');
  });

  /**
   * A syntactically valid identifier ChEMBL does not hold 404s, and `fetchJson`
   * raises that as a `notFound` McpError. Search answers "nothing matched" with an
   * empty page, so the miss must not tank the whole call.
   */
  it('returns the empty-result shape for a well-formed but unknown ChEMBL ID', async () => {
    stub({ error_message: 'not found' }, 404);
    await expect(search('CHEMBL999999999')).resolves.toEqual({ items: [], totalCount: 0 });
  });

  it('returns the empty-result shape for a well-formed but unknown InChIKey', async () => {
    stub({ error_message: 'not found' }, 404);
    await expect(search('AAAAAAAAAAAAAA-BBBBBBBBBB-C')).resolves.toEqual({
      items: [],
      totalCount: 0,
    });
  });

  it('still throws when the exact lookup fails for a reason other than not-found', async () => {
    // Only the miss is absorbed — a rejected request is a real failure to surface.
    stub({ error_message: 'bad request' }, 400);
    await expect(search('CHEMBL25')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
    });
  });

  /**
   * An exact hit is a one-row result set, so it never mints a cursor. A cursor
   * redeemed against it anyway (minted by a different query, per the tool's own
   * warning) reads as an exhausted walk — the one answer that cannot mislead.
   */
  it('reports an offset past the single exact hit as an exhausted walk', async () => {
    stub(aspirinRecord);
    await expect(search('CHEMBL25', { offset: 3 })).resolves.toEqual({ items: [], totalCount: 1 });
  });

  it('returns the record at offset 0', async () => {
    stub(aspirinRecord);
    const page = await search('CHEMBL25', { offset: 0 });
    expect(page.items).toHaveLength(1);
  });
});

/**
 * The Tanimoto percent rides only `search_type=similarity` (#13) — ChEMBL's exact
 * and substructure endpoints omit the key entirely rather than sending null.
 */
describe('ChemblService.structureSearch — similarity rides only the similarity mode', () => {
  const ctx = () => createMockContext({ tenantId: 'default' });
  const structureSearch = (searchType: 'exact' | 'similarity' | 'substructure', body: unknown) => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(body)));
    return new ChemblService(config).structureSearch(
      { structure: 'CC(=O)Oc1ccccc1C(=O)O', searchType, similarityThreshold: 70, limit: 25 },
      ctx(),
    );
  };

  it('omits similarity on an exact structure hit', async () => {
    const page = await structureSearch('exact', {
      molecule_chembl_id: 'CHEMBL25',
      pref_name: 'ASPIRIN',
    });
    expect(page.items).toHaveLength(1);
    // Absent, not a falsy 0 or an explicit null.
    expect(page.items[0]).not.toHaveProperty('similarity');
    expect(page.items[0]?.similarity).toBeUndefined();
  });

  it('omits similarity on every substructure row', async () => {
    const page = await structureSearch('substructure', {
      molecules: Array.from({ length: 5 }, (_, i) => ({
        molecule_chembl_id: `CHEMBL${i}`,
        molecule_structures: { canonical_smiles: 'c1ccccc1' },
      })),
      page_meta: { total_count: 5 },
    });
    expect(page.items).toHaveLength(5);
    for (const molecule of page.items) {
      expect(molecule).not.toHaveProperty('similarity');
    }
  });

  it('carries similarity on every similarity row, coerced from the upstream string', async () => {
    const page = await structureSearch('similarity', {
      molecules: [
        { molecule_chembl_id: 'CHEMBL25', similarity: '100' },
        { molecule_chembl_id: 'CHEMBL1697753', similarity: '88.88888888888889' },
      ],
      page_meta: { total_count: 2 },
    });
    expect(page.items[0]?.similarity).toBe(100);
    expect(page.items[1]?.similarity).toBeCloseTo(88.8889, 4);
  });
});

describe('ChemblService.streamActivities — potency view selects the isnull filter', () => {
  /** Drain one scripted page and hand back the stream URL the service built. */
  async function streamUrlFor(potencyView?: 'potency_ranked' | 'null_potency'): Promise<string> {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ activities: [], page_meta: { total_count: 0, next: null } }),
    );
    const svc = new ChemblService(config);
    for await (const _row of svc.streamActivities(
      { moleculeChemblId: 'CHEMBL25', limit: 25, ...(potencyView && { potencyView }) },
      createMockContext({ tenantId: 'default' }),
    )) {
      // drain
    }
    return String(fetchMock.mock.calls[0]?.[0]);
  }

  it('sends pchembl_value__isnull=false ranked on -pchembl_value by default (#3)', async () => {
    const url = await streamUrlFor();
    expect(url).toContain('pchembl_value__isnull=false');
    expect(url).toContain('order_by=-pchembl_value');
  });

  it('sends pchembl_value__isnull=true on the null-potency view (#9)', async () => {
    const url = await streamUrlFor('null_potency');
    expect(url).toContain('pchembl_value__isnull=true');
    // Ranking on a column that is null for every row is meaningless; the null view
    // walks pages on the stable primary key instead so pagination cannot skip rows.
    expect(url).toContain('order_by=activity_id');
    expect(url).not.toContain('order_by=-pchembl_value');
  });

  it('keeps the isnull filter off the honest count call in either view', async () => {
    for (const potencyView of ['potency_ranked', 'null_potency'] as const) {
      fetchMock.mockClear();
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ activities: [], page_meta: { total_count: 4087 } }),
      );
      const svc = new ChemblService(config);
      const total = await svc.countActivities(
        { moleculeChemblId: 'CHEMBL25', limit: 25, potencyView },
        createMockContext({ tenantId: 'default' }),
      );
      expect(total).toBe(4087);
      expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('pchembl_value__isnull');
    }
  });
});

describe('ChemblService — molecule × target pair filters', () => {
  /** Answer one scripted page and hand back the URL the service built. */
  async function urlForStream(opts: {
    potencyView?: 'potency_ranked' | 'null_potency';
  }): Promise<string> {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ activities: [], page_meta: { total_count: 116, next: null } }),
    );
    const svc = new ChemblService(config);
    for await (const _row of svc.streamActivities(
      {
        moleculeChemblId: 'CHEMBL941',
        targetChemblId: 'CHEMBL385',
        limit: 25,
        ...(opts.potencyView && { potencyView: opts.potencyView }),
      },
      createMockContext({ tenantId: 'default' }),
    )) {
      // drain
    }
    return String(fetchMock.mock.calls[0]?.[0]);
  }

  it('ANDs both ids onto the stream URL', async () => {
    const url = await urlForStream({});
    expect(url).toContain('molecule_chembl_id=CHEMBL941');
    expect(url).toContain('target_chembl_id=CHEMBL385');
    expect(url).toContain('pchembl_value__isnull=false');
  });

  it('ANDs both ids onto the null-potency stream URL too', async () => {
    const url = await urlForStream({ potencyView: 'null_potency' });
    expect(url).toContain('molecule_chembl_id=CHEMBL941');
    expect(url).toContain('target_chembl_id=CHEMBL385');
    expect(url).toContain('pchembl_value__isnull=true');
  });

  it('ANDs both ids onto the honest count URL', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ page_meta: { total_count: 116 } }));
    const svc = new ChemblService(config);
    const total = await svc.countActivities(
      { moleculeChemblId: 'CHEMBL941', targetChemblId: 'CHEMBL385', limit: 25 },
      createMockContext({ tenantId: 'default' }),
    );
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('molecule_chembl_id=CHEMBL941');
    expect(url).toContain('target_chembl_id=CHEMBL385');
    expect(total).toBe(116);
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
