/**
 * @fileoverview Tests for ChemblService normalization + flattening against
 * controlled upstream payloads — including a sparse payload with omitted fields,
 * verifying absence is preserved as null rather than fabricated — plus the
 * exact-shape routing of a name query (ChEMBL ID / InChIKey → the by-resource
 * lookup, everything else → the fuzzy endpoint), the search ceilings that flag a
 * capped total (#42), the search modes that do and do not carry a Tanimoto
 * percent, the parent every molecule record resolves to (#36, #37), and the
 * bioactivity view walks — the inline stream and the concurrent spill — over a
 * fake `/activity` corpus, with their family scope, variant filter, comment and
 * document fields, and `only=` field selection (#34, #37–#39). `fetch` is stubbed
 * so no live ChEMBL call is made.
 * @module tests/services/chembl-service
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_FIELDS,
  CallDeadline,
  ChemblService,
  normalizeActivity,
} from '@/services/chembl/chembl-service.js';
import type { GetActivitiesOptions } from '@/services/chembl/types.js';
import {
  type ActivityCorpusOptions,
  activityCorpus,
  corpusTraffic,
  viewRequests,
} from '../_fake-activity-upstream.js';

const config = {
  apiBaseUrl: 'https://www.ebi.ac.uk/chembl/api/data',
  requestTimeoutMs: 5000,
  maxPageSize: 1000,
  defaultLimit: 25,
  maxSpillRows: 50_000,
  maxConcurrentPages: 4,
  spillDeadlineMs: 45_000,
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
 * ChEMBL stops a name search at 10000 hits and a substructure search at 30000, and
 * reports the ceiling as `page_meta.total_count` (#42). The flag rides beside the
 * upstream total, which is passed through unchanged.
 */
describe('ChemblService — search ceilings flag a capped totalCount (#42)', () => {
  const ctx = () => createMockContext({ tenantId: 'default' });

  /** One page of `rows` molecules over an upstream total of `total`. */
  function answer(total: number, rows = 2) {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        molecules: Array.from({ length: rows }, (_, i) => ({ molecule_chembl_id: `CHEMBL${i}` })),
        page_meta: { total_count: total },
      }),
    );
  }

  const substructure = (svc: ChemblService, searchType: 'similarity' | 'substructure') =>
    svc.structureSearch(
      { structure: 'c1ccncc1', searchType, similarityThreshold: 40, limit: 2 },
      ctx(),
    );

  it.each([
    ['a substructure search at its 30000 ceiling', 30_000, 'substructure', true],
    ['a substructure search under it', 29_999, 'substructure', false],
    ['a similarity search, which has no ceiling', 30_000, 'similarity', false],
  ] as const)('flags %s', async (_label, total, searchType, capped) => {
    answer(total);
    const page = await substructure(new ChemblService(config), searchType);
    expect(page).toMatchObject({ totalCount: total, totalCountCapped: capped });
  });

  it.each([
    ['a name search at its 10000 ceiling', 10_000, undefined, true],
    ['a phase-filtered name search at it', 10_000, 4, true],
    ['a name search under it', 2539, undefined, false],
  ])('flags %s', async (_label, total, maxPhaseMin, capped) => {
    answer(total);
    const page = await new ChemblService(config).searchMolecules(
      { query: 'acid', maxPhaseMin, limit: 2 },
      ctx(),
    );
    expect(page).toMatchObject({ totalCount: total, totalCountCapped: capped });
  });

  it('never flags an exact structure hit or an identifier lookup', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ molecule_chembl_id: 'CHEMBL25' })),
    );
    const svc = new ChemblService(config);
    const exact = await svc.structureSearch(
      {
        structure: 'CC(=O)Oc1ccccc1C(=O)O',
        searchType: 'exact',
        similarityThreshold: 70,
        limit: 2,
      },
      ctx(),
    );
    const byId = await svc.searchMolecules({ query: 'CHEMBL25', limit: 2 }, ctx());
    expect(exact).toMatchObject({ totalCount: 1, totalCountCapped: false });
    expect(byId).toMatchObject({ totalCount: 1, totalCountCapped: false });
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
    await expect(search('CHEMBL999999999')).resolves.toEqual({
      items: [],
      totalCount: 0,
      totalCountCapped: false,
    });
  });

  it('returns the empty-result shape for a well-formed but unknown InChIKey', async () => {
    stub({ error_message: 'not found' }, 404);
    await expect(search('AAAAAAAAAAAAAA-BBBBBBBBBB-C')).resolves.toEqual({
      items: [],
      totalCount: 0,
      totalCountCapped: false,
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
    await expect(search('CHEMBL25', { offset: 3 })).resolves.toEqual({
      items: [],
      totalCount: 1,
      totalCountCapped: false,
    });
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

/**
 * One parent rule on every molecule the service normalizes (#36, #37): the
 * hierarchy's parent, or the record's own ID when ChEMBL records none — never the
 * active metabolite.
 */
describe('ChemblService — parent_chembl_id on every molecule record', () => {
  const ctx = () => createMockContext({ tenantId: 'default' });
  const hierarchy = (id: string, parent: string | null, active: string | null = parent) => ({
    molecule_chembl_id: id,
    molecule_hierarchy: {
      molecule_chembl_id: id,
      parent_chembl_id: parent,
      active_chembl_id: active,
    },
  });
  const salt = hierarchy('CHEMBL1079742', 'CHEMBL553');
  const parent = hierarchy('CHEMBL553', 'CHEMBL553');
  const unrecorded = { molecule_chembl_id: 'CHEMBL1201352', molecule_hierarchy: null };
  const prodrug = hierarchy('CHEMBL900001', 'CHEMBL900002', 'CHEMBL900003');
  const sparse = { molecule_chembl_id: 'CHEMBL7' };
  const parentless = hierarchy('CHEMBL8', null, 'CHEMBL9');
  const rows = [salt, parent, unrecorded, prodrug, sparse, parentless];
  const expected = [
    'CHEMBL553',
    'CHEMBL553',
    'CHEMBL1201352',
    'CHEMBL900002',
    'CHEMBL7',
    'CHEMBL8',
  ];
  const list = { molecules: rows, page_meta: { total_count: rows.length } };
  const service = () => new ChemblService(config);

  it('resolves the parent on each getMolecule record', async () => {
    const parents: string[] = [];
    for (const row of rows) {
      fetchMock.mockResolvedValueOnce(jsonResponse(row));
      parents.push((await service().getMolecule(row.molecule_chembl_id, ctx())).parent_chembl_id);
    }
    expect(parents).toEqual(expected);
  });

  it.each([
    ['name search', () => service().searchMolecules({ query: 'erlotinib', limit: 25 }, ctx())],
    [
      'similarity search',
      () =>
        service().structureSearch(
          { structure: 'C', searchType: 'similarity', similarityThreshold: 70, limit: 25 },
          ctx(),
        ),
    ],
    [
      'substructure search',
      () =>
        service().structureSearch(
          { structure: 'C', searchType: 'substructure', similarityThreshold: 70, limit: 25 },
          ctx(),
        ),
    ],
  ])('resolves the parent on every %s row', async (_mode, run) => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(list)));
    const page = await run();
    expect(page.items.map((m) => m.parent_chembl_id)).toEqual(expected);
  });

  it('resolves the parent on an identifier lookup and an exact structure hit', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(salt)));
    const byId = await service().searchMolecules({ query: 'CHEMBL1079742', limit: 25 }, ctx());
    const exact = await service().structureSearch(
      { structure: 'C', searchType: 'exact', similarityThreshold: 70, limit: 25 },
      ctx(),
    );
    expect(byId.items[0]?.parent_chembl_id).toBe('CHEMBL553');
    expect(exact.items[0]?.parent_chembl_id).toBe('CHEMBL553');
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
      { molecule: { scope: 'form', id: 'CHEMBL25' }, ...(potencyView && { potencyView }) },
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
        { molecule: { scope: 'form', id: 'CHEMBL25' }, potencyView },
        createMockContext({ tenantId: 'default' }),
      );
      expect(total).toBe(4087);
      expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('pchembl_value__isnull');
    }
  });
});

describe('ChemblService.streamActivities — the view page walk (#32)', () => {
  /** A ranked row with the given potency; ids double as the identity under test. */
  const ranked = (activity_id: number, pchembl_value: string) => ({ activity_id, pchembl_value });

  /** Drain the stream over a small page size, returning the rows and reported total. */
  async function walk(
    opts: { potencyView?: 'potency_ranked' | 'null_potency' } = {},
    pageSize = 4,
  ): Promise<{ ids: number[]; potencies: (number | null)[]; total: number }> {
    const svc = new ChemblService({ ...config, maxPageSize: pageSize });
    const rows = [];
    let total = -1;
    for await (const row of svc.streamActivities(
      { targetChemblId: 'CHEMBL203', ...opts },
      createMockContext({ tenantId: 'default' }),
      (t) => {
        total = t;
      },
    )) {
      rows.push(row);
    }
    return {
      ids: rows.map((r) => r.activity_id),
      potencies: rows.map((r) => r.pchembl_value),
      total,
    };
  }

  it('walks a tie-free view across pages in upstream order, every row once', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ranked(100 + i, (9 - i / 10).toFixed(2)));
    fetchMock.mockImplementation(activityCorpus({ rows }));
    const { ids, total } = await walk();
    expect(ids).toEqual(rows.map((r) => r.activity_id));
    expect(total).toBe(10);
    // Ten rows at four per page: three pages, and nothing requested past the view.
    expect(viewRequests(fetchMock.mock.calls).map((p) => p.get('offset'))).toEqual(['0', '4', '8']);
  });

  it('breaks -pchembl_value ties on activity_id with a repeated order_by param', async () => {
    fetchMock.mockImplementation(activityCorpus({ rows: [ranked(1, '8.00')] }));
    await walk();
    const [params] = viewRequests(fetchMock.mock.calls);
    // Repeated, in this order — ChEMBL answers the comma form with HTTP 400.
    expect(params?.getAll('order_by')).toEqual(['-pchembl_value', 'activity_id']);
  });

  it('keeps the null-potency view on its single activity_id order', async () => {
    fetchMock.mockImplementation(activityCorpus({ rows: [{ activity_id: 1 }] }));
    await walk({ potencyView: 'null_potency' });
    const [params] = viewRequests(fetchMock.mock.calls);
    expect(params?.getAll('order_by')).toEqual(['activity_id']);
  });

  it('returns every tied measurement exactly once when ties cross page boundaries', async () => {
    // A six-row tie at 8.00 straddles the page edges at offsets 4 and 8.
    const rows = [
      ranked(901, '9.10'),
      ranked(902, '9.00'),
      ranked(903, '8.90'),
      ...[611, 604, 609, 602, 607, 605].map((id) => ranked(id, '8.00')),
      ranked(801, '7.50'),
      ranked(802, '7.40'),
      ranked(803, '7.30'),
    ];
    fetchMock.mockImplementation(activityCorpus({ rows }));
    const { ids, potencies, total } = await walk();

    expect(total).toBe(12);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect([...ids].sort()).toEqual(rows.map((r) => r.activity_id).sort());
    // Most potent first, non-increasing; inside the tie, ascending activity_id.
    expect(potencies).toEqual([...potencies].sort((a, b) => Number(b) - Number(a)));
    expect(ids.slice(3, 9)).toEqual([602, 604, 605, 607, 609, 611]);
  });

  it('carries the two-key order on every page instead of following page_meta.next', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ranked(100 + i, '8.00'));
    fetchMock.mockImplementation(activityCorpus({ rows }));
    const { ids } = await walk();
    expect(ids).toEqual(rows.map((r) => r.activity_id));
    // page_meta.next re-serializes the two keys as a Python list, which ChEMBL 400s;
    // each page is built from the offset instead, with the order intact.
    const pages = viewRequests(fetchMock.mock.calls);
    expect(pages).toHaveLength(3);
    for (const params of pages) {
      expect(params.getAll('order_by')).toEqual(['-pchembl_value', 'activity_id']);
    }
  });

  it('stops at a short page even when total_count claims more rows', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ranked(100 + i, (9 - i / 10).toFixed(2)));
    fetchMock.mockImplementation(activityCorpus({ rows, viewTotal: 100 }));
    const { ids } = await walk();
    expect(ids).toHaveLength(6);
    expect(viewRequests(fetchMock.mock.calls)).toHaveLength(2);
  });

  it('stops at total_count without requesting a page past a full last page', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ranked(100 + i, (9 - i / 10).toFixed(2)));
    fetchMock.mockImplementation(activityCorpus({ rows }));
    const { ids } = await walk();
    expect(ids).toHaveLength(8);
    expect(viewRequests(fetchMock.mock.calls).map((p) => p.get('offset'))).toEqual(['0', '4']);
  });

  it('stops after one page when page_meta is missing, rather than walking blind', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ranked(100 + i, (9 - i / 10).toFixed(2)));
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ activities: rows })));
    const svc = new ChemblService({ ...config, maxPageSize: 4 });
    const ids: number[] = [];
    // Bounded, so a walk that never stops fails here instead of hanging the run.
    for await (const row of svc.streamActivities(
      { targetChemblId: 'CHEMBL203' },
      createMockContext({ tenantId: 'default' }),
    )) {
      ids.push(row.activity_id);
      if (ids.length > 8) break;
    }
    expect(ids).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('walks the null-potency view by offset in activity_id order', async () => {
    const rows = [7, 3, 9, 1, 5, 2].map((activity_id) => ({ activity_id }));
    fetchMock.mockImplementation(activityCorpus({ rows }));
    const { ids, potencies } = await walk({ potencyView: 'null_potency' });
    expect(ids).toEqual([1, 2, 3, 5, 7, 9]);
    expect(potencies.every((p) => p === null)).toBe(true);
  });
});

describe('ChemblService.streamActivities — page size and start (#29, #17)', () => {
  /** Drain one empty page and hand back the view request's params. */
  async function firstPage(
    opts: { pageSize?: number; offset?: number },
    maxPageSize = 1000,
  ): Promise<URLSearchParams | undefined> {
    fetchMock.mockImplementation(activityCorpus({ rows: [] }));
    const svc = new ChemblService({ ...config, maxPageSize });
    for await (const _row of svc.streamActivities(
      { targetChemblId: 'CHEMBL203', ...opts },
      createMockContext({ tenantId: 'default' }),
    )) {
      // drain
    }
    return viewRequests(fetchMock.mock.calls)[0];
  }

  it('requests the caller page size', async () => {
    // Read through URLSearchParams — "limit=1000" contains "limit=100".
    expect((await firstPage({ pageSize: 25 }))?.get('limit')).toBe('25');
    fetchMock.mockClear();
    expect((await firstPage({ pageSize: 1000 }))?.get('limit')).toBe('1000');
  });

  it('defaults the page to CHEMBL_MAX_PAGE_SIZE when the caller names none', async () => {
    expect((await firstPage({}))?.get('limit')).toBe('1000');
    fetchMock.mockClear();
    expect((await firstPage({}, 200))?.get('limit')).toBe('200');
  });

  it('caps a larger page size at CHEMBL_MAX_PAGE_SIZE', async () => {
    expect((await firstPage({ pageSize: 500 }, 200))?.get('limit')).toBe('200');
  });

  it('starts at offset 0 by default and at the caller offset when given', async () => {
    expect((await firstPage({}))?.get('offset')).toBe('0');
    fetchMock.mockClear();
    expect((await firstPage({ offset: 50 }))?.get('offset')).toBe('50');
  });

  it('walks on from the caller offset by the page size', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      activity_id: 100 + i,
      pchembl_value: (9 - i / 10).toFixed(2),
    }));
    fetchMock.mockImplementation(activityCorpus({ rows }));
    const svc = new ChemblService(config);
    const ids = [];
    for await (const row of svc.streamActivities(
      { targetChemblId: 'CHEMBL203', offset: 3, pageSize: 3 },
      createMockContext({ tenantId: 'default' }),
    )) {
      ids.push(row.activity_id);
    }
    expect(ids).toEqual([103, 104, 105, 106, 107, 108, 109]);
    expect(viewRequests(fetchMock.mock.calls).map((p) => p.get('offset'))).toEqual(['3', '6', '9']);
  });

  it('throws a cancellation between pages instead of ending the stream on a partial page', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ activity_id: 100 + i }));
    fetchMock.mockImplementation(activityCorpus({ rows }));
    const controller = new AbortController();
    const svc = new ChemblService({ ...config, maxPageSize: 4 });
    const ids: number[] = [];
    const drained = (async () => {
      for await (const row of svc.streamActivities(
        { targetChemblId: 'CHEMBL203', potencyView: 'null_potency' },
        createMockContext({ tenantId: 'default', signal: controller.signal }),
      )) {
        ids.push(row.activity_id);
        if (ids.length === 4) controller.abort();
      }
    })();
    await expect(drained).rejects.toMatchObject({ name: 'AbortError' });
    expect(ids).toEqual([100, 101, 102, 103]);
  });
});

describe('ChemblService.spillActivities — the concurrent spill walk (#16)', () => {
  /** 23 ranked rows in tie groups of three, so ties straddle the 4-row page edges. */
  const ROWS = Array.from({ length: 23 }, (_, i) => ({
    activity_id: 100 + i,
    pchembl_value: (9 - Math.floor(i / 3) / 10).toFixed(2),
  }));

  /**
   * Walk `rows` (default ROWS) in 4-row pages, collecting what the walk yields and
   * reports. `abortAfter` cancels the call once that many rows have been yielded,
   * and the walk is pulled on.
   */
  async function spill(
    opts: {
      abortAfter?: number;
      concurrency?: number;
      corpus?: Omit<ActivityCorpusOptions, 'rows' | 'traffic'>;
      deadline?: CallDeadline;
      maxRows?: number;
      rows?: ActivityCorpusOptions['rows'];
      stopAfter?: number;
    } = {},
  ) {
    const traffic = corpusTraffic();
    fetchMock.mockImplementation(
      activityCorpus({ rows: opts.rows ?? ROWS, traffic, ...opts.corpus }),
    );
    const svc = new ChemblService({
      ...config,
      maxPageSize: 4,
      maxConcurrentPages: opts.concurrency ?? 2,
    });
    let total = -1;
    let deadlineHit = false;
    /** What the budget had left when the walk reported it ended the walk. */
    let leftAtDeadlineMs: number | undefined;
    const deadline = opts.deadline ?? new CallDeadline(45_000);
    const caller = new AbortController();
    const walk = svc.spillActivities(
      { targetChemblId: 'CHEMBL203' },
      createMockContext({ tenantId: 'default', signal: caller.signal }),
      {
        deadline,
        maxRows: opts.maxRows ?? 50_000,
        onTotal: (t) => {
          total = t;
        },
        onDeadline: () => {
          deadlineHit = true;
          leftAtDeadlineMs = deadline.remainingMs;
        },
      },
    );
    const ids: number[] = [];
    for await (const row of walk) {
      ids.push(row.activity_id);
      if (ids.length === opts.abortAfter) caller.abort();
      if (ids.length === opts.stopAfter) break;
    }
    const offsets = viewRequests(fetchMock.mock.calls).map((p) => Number(p.get('offset')));
    return {
      ids,
      total,
      deadlineHit,
      leftAtDeadlineMs,
      traffic,
      offsets: offsets.sort((a, b) => a - b),
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('yields the whole view once, in its total order, while pages land out of order', async () => {
    vi.useFakeTimers();
    // Later pages answer sooner, so the window completes out of order.
    const walked = spill({ corpus: { latencyMs: (offset) => 30 - offset } });
    await vi.advanceTimersByTimeAsync(1_000);
    const { ids, total, offsets, deadlineHit, traffic } = await walked;
    // The precondition: some page answered before a page ahead of it in the view.
    expect(traffic.answered).not.toEqual([...traffic.answered].sort((a, b) => a - b));
    expect(ids).toEqual(ROWS.map((r) => r.activity_id));
    expect(total).toBe(23);
    expect(deadlineHit).toBe(false);
    expect(offsets).toEqual([0, 4, 8, 12, 16, 20]);
  });

  it('holds concurrent spills on one service to CHEMBL_MAX_CONCURRENT_PAGES page requests in flight', async () => {
    vi.useFakeTimers();
    const traffic = corpusTraffic();
    fetchMock.mockImplementation(activityCorpus({ rows: ROWS, traffic, latencyMs: 5 }));
    // A walk's own window is the same size, so only a second walk can overrun the limiter.
    const svc = new ChemblService({ ...config, maxPageSize: 4, maxConcurrentPages: 2 });
    const drain = async () => {
      const ids: number[] = [];
      for await (const row of svc.spillActivities(
        { targetChemblId: 'CHEMBL203' },
        createMockContext({ tenantId: 'default' }),
        {
          deadline: new CallDeadline(45_000),
          maxRows: 50_000,
          onTotal: () => {},
          onDeadline: () => {},
        },
      )) {
        ids.push(row.activity_id);
      }
      return ids;
    };
    const both = Promise.all([drain(), drain()]);
    await vi.advanceTimersByTimeAsync(1_000);
    const [first, second] = await both;
    expect(first).toEqual(ROWS.map((r) => r.activity_id));
    expect(second).toEqual(ROWS.map((r) => r.activity_id));
    // The service-wide limiter binds across both walks, and is used up to its cap.
    expect(traffic.maxInFlight).toBe(2);
    expect(traffic.answered).toHaveLength(12);
  });

  it('requests no page at or past a row cap that splits one, yielding that page whole', async () => {
    const { ids, offsets } = await spill({ maxRows: 10 });
    // Offset 8 starts below the cap; 12 would start past it.
    expect(offsets).toEqual([0, 4, 8]);
    // The consumer's own cap is the staging bound, so the split page yields whole.
    expect(ids).toEqual(ROWS.slice(0, 12).map((r) => r.activity_id));
  });

  it('requests no page past the view total, nor past the first page when it is short', async () => {
    // Eight rows fill two pages exactly; a third request would start at the total.
    const full = await spill({ rows: ROWS.slice(0, 8) });
    expect(full.offsets).toEqual([0, 4]);
    expect(full.ids).toEqual(ROWS.slice(0, 8).map((r) => r.activity_id));
    fetchMock.mockClear();
    // A stale total_count claims more, but a short first page is the whole view.
    const short = await spill({ rows: ROWS.slice(0, 3), corpus: { viewTotal: 100 } });
    expect(short.offsets).toEqual([0]);
    expect(short.ids).toEqual(ROWS.slice(0, 3).map((r) => r.activity_id));
  });

  it('ends at a short page even when total_count claims more rows', async () => {
    const { ids, traffic } = await spill({ corpus: { viewTotal: 100 } });
    expect(ids).toEqual(ROWS.map((r) => r.activity_id));
    expect(traffic.inFlight).toBe(0);
  });

  it('ends after the contiguous prefix when the deadline cuts the walk, and says so', async () => {
    vi.useFakeTimers();
    const deadline = new CallDeadline(10_000);
    const walked = spill({ deadline, corpus: { stallAt: [8], latencyMs: (o) => (o > 8 ? 1 : 0) } });
    await vi.advanceTimersByTimeAsync(11_000);
    const { ids, deadlineHit, offsets } = await walked;
    expect(deadlineHit).toBe(true);
    // Pages 0 and 4 staged; the stalled page and the one fetched past it did not.
    expect(ids).toEqual(ROWS.slice(0, 8).map((r) => r.activity_id));
    expect(offsets).toContain(12);
  });

  /**
   * The page at `offset` answers HTTP 500 four seconds into every attempt, under a
   * 10 s budget. Attempt one fails at 4 s and its backoff (1125–1875 ms with
   * jitter) fits; attempt two fails 9.1–9.9 s in, where the next backoff
   * (2250–3750 ms) would outlast the budget, so `withRetry` stops the ladder
   * before the deadline expires — whatever the jitter draws.
   */
  const failsWithinOneBackoffOfExpiry = (offset: number) => ({
    deadline: new CallDeadline(10_000),
    corpus: {
      failAt: { offset, status: 500 },
      latencyMs: (o: number) => (o === offset ? 4_000 : 0),
    },
  });

  it('ends after the contiguous prefix when the budget cuts the retries of a failing page short', async () => {
    vi.useFakeTimers();
    const walked = spill(failsWithinOneBackoffOfExpiry(8)).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(11_000);
    const outcome = await walked;
    // The walk ended at the budget instead of failing as upstream_timeout.
    expect(outcome).not.toHaveProperty('error');
    const { ids, deadlineHit, leftAtDeadlineMs, offsets } = (
      outcome as { value: Awaited<ReturnType<typeof spill>> }
    ).value;
    // Pages 0 and 4 staged.
    expect(ids).toEqual(ROWS.slice(0, 8).map((r) => r.activity_id));
    expect(deadlineHit).toBe(true);
    // The ladder stopped before the deadline itself expired, after two attempts.
    expect(leftAtDeadlineMs).toBeGreaterThan(0);
    expect(offsets.filter((o) => o === 8)).toHaveLength(2);
  });

  it('still fails as upstream_timeout when the budget cuts the retries of the first page short', async () => {
    vi.useFakeTimers();
    const walked = spill(failsWithinOneBackoffOfExpiry(0)).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(11_000);
    const error = await walked;
    // Nothing was fetched, so there is no prefix to stage.
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'upstream_timeout' },
    });
    // The sanitized error carries withRetry's budget stop on cause, never on the wire.
    expect((error as Error).cause).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', retryAttempts: 2 },
    });
    expect((error as { data: object }).data).not.toHaveProperty('retryAttempts');
    expect(viewRequests(fetchMock.mock.calls).map((p) => p.get('offset'))).toEqual(['0', '0']);
  });

  it('releases its in-flight pages when the consumer stops pulling early', async () => {
    vi.useFakeTimers();
    const walked = spill({ stopAfter: 2, corpus: { latencyMs: (o) => (o === 0 ? 0 : 60_000) } });
    await vi.advanceTimersByTimeAsync(0);
    const { traffic } = await walked;
    expect(traffic.aborted).toBe(2);
    expect(traffic.inFlight).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  /** `n` ranked rows tied on potency, so the view's total order is ascending activity_id. */
  const tiedRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ activity_id: 100 + i, pchembl_value: '8.00' }));
  const idsOf = (rows: readonly { activity_id: number }[]) => rows.map((r) => r.activity_id);

  /**
   * Every page takes 4 s, four at a time, under a 10 s budget: page 0 lands at 4 s
   * and the four after it at 8 s, when a page started would need until 12 s.
   */
  const slowPages = { concurrency: 4, corpus: { latencyMs: 4_000 } };

  it('starts no page the budget would not hold, ending after the pages in flight', async () => {
    vi.useFakeTimers();
    const rows = tiedRows(48);
    const walked = spill({ ...slowPages, rows, deadline: new CallDeadline(10_000) });
    await vi.advanceTimersByTimeAsync(12_000);
    const { ids, deadlineHit, leftAtDeadlineMs, offsets, traffic } = await walked;
    // Five pages sent, and none abandoned at the deadline.
    expect(offsets).toEqual([0, 4, 8, 12, 16]);
    expect(traffic.aborted).toBe(0);
    expect(ids).toEqual(idsOf(rows.slice(0, 20)));
    // The budget ended the walk 8 s in, with 2 s left that would not hold a 4 s page.
    expect(deadlineHit).toBe(true);
    expect(leftAtDeadlineMs).toBe(2_000);
  });

  it('still walks the whole view when its pages are fast against the budget', async () => {
    vi.useFakeTimers();
    const rows = tiedRows(48);
    const walked = spill({
      rows,
      concurrency: 4,
      deadline: new CallDeadline(10_000),
      corpus: { latencyMs: 100 },
    });
    await vi.advanceTimersByTimeAsync(12_000);
    const { ids, deadlineHit, offsets, traffic } = await walked;
    expect(ids).toEqual(idsOf(rows));
    expect(deadlineHit).toBe(false);
    expect(offsets).toEqual(Array.from({ length: 12 }, (_, page) => page * 4));
    expect(traffic.aborted).toBe(0);
  });

  /**
   * The estimate is the latest page's time, so the first page's time is the only
   * one the first dispatch has. Pages landing after it replace it.
   */
  it('re-estimates from each page that lands, so fast pages after a slow first page walk on', async () => {
    vi.useFakeTimers();
    // Page 0 takes 4 s of a 10 s budget; the 49 pages after it take 100 ms, two at a time, ending ~6.5 s in.
    const rows = tiedRows(200);
    const walked = spill({
      rows,
      deadline: new CallDeadline(10_000),
      corpus: { latencyMs: (offset) => (offset === 0 ? 4_000 : 100) },
    });
    await vi.advanceTimersByTimeAsync(12_000);
    const { ids, deadlineHit } = await walked;
    // Holding the estimate at the slowest page so far would stop dispatch 6 s in.
    expect(ids).toEqual(idsOf(rows));
    expect(deadlineHit).toBe(false);
  });

  it('ends after a first page that took longer than the budget it left', async () => {
    vi.useFakeTimers();
    // Page 0 takes 4 s of a 7 s budget; the 3 s left would not hold another page like it.
    const rows = tiedRows(48);
    const walked = spill({
      rows,
      deadline: new CallDeadline(7_000),
      corpus: { latencyMs: (offset) => (offset === 0 ? 4_000 : 100) },
    });
    await vi.advanceTimersByTimeAsync(8_000);
    const { ids, deadlineHit, leftAtDeadlineMs, offsets } = await walked;
    // The estimate's pessimistic case: the fast pages behind a slow first page are never requested.
    expect(offsets).toEqual([0]);
    expect(ids).toEqual(idsOf(rows.slice(0, 4)));
    expect(deadlineHit).toBe(true);
    expect(leftAtDeadlineMs).toBe(3_000);
  });

  /**
   * Pages take 1 s, two at a time, under a 10 s budget. The page at offset 36 is
   * sent 5 s in, answers HTTP 500 at 6 s, and lands on its retry 8.1–8.9 s in,
   * 3.1–3.9 s after it was first sent but 1 s after its final attempt began.
   */
  it('times a page that landed after a retry by its final attempt, not its backoff', async () => {
    vi.useFakeTimers();
    const rows = tiedRows(80);
    const walked = spill({
      rows,
      deadline: new CallDeadline(10_000),
      corpus: { latencyMs: 1_000, failAt: { offset: 36, status: 500, times: 1 } },
    });
    await vi.advanceTimersByTimeAsync(12_000);
    const { ids, deadlineHit, leftAtDeadlineMs, offsets, traffic } = await walked;
    // The 1.1–1.9 s left when it landed held two more 1 s pages; the ones after them were never sent.
    const pages = Array.from({ length: 13 }, (_, page) => page * 4);
    expect(offsets).toEqual([...pages, 36].sort((a, b) => a - b));
    expect(ids).toEqual(idsOf(rows.slice(0, 52)));
    expect(traffic.aborted).toBe(0);
    expect(deadlineHit).toBe(true);
    expect(leftAtDeadlineMs).toBeGreaterThan(0);
    expect(leftAtDeadlineMs).toBeLessThan(1_000);
  });

  it.each([
    [4, 'with the window in flight'],
    [20, 'as the budget stops dispatch with the window drained'],
  ])('throws a cancellation after %i rows (%s), never ending at the budget', async (abortAfter) => {
    vi.useFakeTimers();
    const walked = spill({
      ...slowPages,
      rows: tiedRows(48),
      deadline: new CallDeadline(10_000),
      abortAfter,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await walked).toMatchObject({ name: 'AbortError' });
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
        molecule: { scope: 'form', id: 'CHEMBL941' },
        targetChemblId: 'CHEMBL385',
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
      { molecule: { scope: 'form', id: 'CHEMBL941' }, targetChemblId: 'CHEMBL385' },
      createMockContext({ tenantId: 'default' }),
    );
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('molecule_chembl_id=CHEMBL941');
    expect(url).toContain('target_chembl_id=CHEMBL385');
    expect(total).toBe(116);
  });

  it('swaps the molecule filter for the parent filter on a family scope, on every request (#37)', async () => {
    const svc = new ChemblService(config);
    const c = createMockContext({ tenantId: 'default' });
    const opts = {
      molecule: { scope: 'family', id: 'CHEMBL941' },
      targetChemblId: 'CHEMBL385',
    } as const;
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ activities: [], page_meta: { total_count: 0, next: null } })),
    );
    await svc.countActivities(opts, c);
    for (const potencyView of ['potency_ranked', 'null_potency'] as const) {
      for await (const _row of svc.streamActivities({ ...opts, potencyView }, c)) {
        // drain
      }
    }
    for await (const _row of svc.spillActivities(opts, c, {
      deadline: new CallDeadline(10_000),
      maxRows: 1000,
      onTotal: () => {},
      onDeadline: () => {},
    })) {
      // drain
    }
    const sent = fetchMock.mock.calls.map((call) => new URL(String(call[0])).searchParams);
    expect(sent).toHaveLength(4);
    for (const params of sent) {
      expect(params.get('parent_molecule_chembl_id')).toBe('CHEMBL941');
      expect(params.has('molecule_chembl_id')).toBe(false);
      expect(params.get('target_chembl_id')).toBe('CHEMBL385');
    }
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
      { targetChemblId: 'CHEMBL203', standardType: 'IC50' },
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

describe('ChemblService activities — comments, variant, and source document (#38, #39)', () => {
  const FIELDS = [
    'activity_comment',
    'data_validity_comment',
    'assay_variant_mutation',
    'assay_variant_accession',
    'document_chembl_id',
    'document_year',
  ] as const;

  async function normalized(raw: Record<string, unknown>) {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ activities: [raw], page_meta: { total_count: 1, next: null } }),
    );
    const svc = new ChemblService(config);
    for await (const row of svc.streamActivities(
      { targetChemblId: 'CHEMBL203' },
      createMockContext({ tenantId: 'default' }),
    )) {
      return Object.fromEntries(FIELDS.map((key) => [key, row[key]]));
    }
    throw new Error('the stream yielded no row');
  }

  it.each([
    [
      'a commented, flagged mutant row',
      {
        activity_comment: 'Not Active',
        data_validity_comment: 'Outside typical range',
        assay_variant_mutation: 'T315I',
        assay_variant_accession: 'P00519',
        document_chembl_id: 'CHEMBL1145828',
        document_year: 2003,
      },
      {
        activity_comment: 'Not Active',
        data_validity_comment: 'Outside typical range',
        assay_variant_mutation: 'T315I',
        assay_variant_accession: 'P00519',
        document_chembl_id: 'CHEMBL1145828',
        document_year: 2003,
      },
    ],
    [
      'a year shipped as a string',
      { document_chembl_id: 'CHEMBL1124610', document_year: '1989' },
      {
        activity_comment: null,
        data_validity_comment: null,
        assay_variant_mutation: null,
        assay_variant_accession: null,
        document_chembl_id: 'CHEMBL1124610',
        document_year: 1989,
      },
    ],
    [
      'an unspecified mutant from a deposited dataset',
      {
        assay_variant_mutation: 'UNDEFINED MUTATION',
        assay_variant_accession: null,
        document_chembl_id: 'CHEMBL4507235',
        document_year: null,
      },
      {
        activity_comment: null,
        data_validity_comment: null,
        assay_variant_mutation: 'UNDEFINED MUTATION',
        assay_variant_accession: null,
        document_chembl_id: 'CHEMBL4507235',
        document_year: null,
      },
    ],
    [
      'blank strings',
      {
        activity_comment: '  ',
        data_validity_comment: '',
        assay_variant_mutation: ' ',
        assay_variant_accession: '',
        document_chembl_id: '',
        document_year: '',
      },
      {
        activity_comment: null,
        data_validity_comment: null,
        assay_variant_mutation: null,
        assay_variant_accession: null,
        document_chembl_id: null,
        document_year: null,
      },
    ],
    [
      'fields absent from the payload',
      {},
      {
        activity_comment: null,
        data_validity_comment: null,
        assay_variant_mutation: null,
        assay_variant_accession: null,
        document_chembl_id: null,
        document_year: null,
      },
    ],
  ])('normalizes %s', async (_name, fields, expected) => {
    const row = await normalized({
      activity_id: 676633,
      molecule_chembl_id: 'CHEMBL1',
      target_chembl_id: 'CHEMBL203',
      assay_chembl_id: 'CHEMBL2',
      ...fields,
    });
    expect(row).toEqual(expected);
  });

  /**
   * Every request one call can make — the honest count, a page of either view, and
   * every page of the spill walk — under one set of filters, as its query params.
   */
  async function requestsUnder(variant: GetActivitiesOptions['variant']) {
    fetchMock.mockImplementation(
      activityCorpus({
        rows: Array.from({ length: 10 }, (_, i) => ({
          activity_id: 1 + i,
          pchembl_value: '7.00',
        })),
      }),
    );
    const svc = new ChemblService({ ...config, maxPageSize: 4 });
    const ctx = createMockContext({ tenantId: 'default' });
    const filters: GetActivitiesOptions = { targetChemblId: 'CHEMBL203', variant };
    await svc.countActivities(filters, ctx);
    for (const potencyView of ['potency_ranked', 'null_potency'] as const) {
      for await (const _row of svc.streamActivities({ ...filters, potencyView, offset: 4 }, ctx)) {
        // drain
      }
    }
    for await (const _row of svc.spillActivities(filters, ctx, {
      deadline: new CallDeadline(45_000),
      maxRows: 50_000,
      onTotal: () => {},
      onDeadline: () => {},
    })) {
      // drain
    }
    return fetchMock.mock.calls.map((call) => new URL(String(call[0])).searchParams);
  }

  it.each([
    ['omitted', undefined, null, null],
    ['wild type', { kind: 'wild_type' } as const, 'true', null],
    [
      'one recorded variant',
      { kind: 'mutation', mutation: 'l858r,T790M' } as const,
      null,
      'l858r,T790M',
    ],
  ])(
    'sends the %s variant filter on the count and every page of both walks',
    async (_name, variant, isnull, iexact) => {
      const requests = await requestsUnder(variant);
      // 1 count + 2 pages per view (offsets 4, 8) + the 3-page spill (0, 4, 8).
      expect(requests).toHaveLength(8);
      for (const params of requests) {
        expect(params.get('assay_variant_mutation__isnull')).toBe(isnull);
        expect(params.get('assay_variant_mutation__iexact')).toBe(iexact);
        expect(params.get('target_chembl_id')).toBe('CHEMBL203');
      }
    },
  );
});

describe('ChemblService activities — only= field selection (#34)', () => {
  /** The raw activity fields the server reads, written out independently of the service. */
  const READ_FIELDS = [
    'activity_comment',
    'activity_id',
    'assay_chembl_id',
    'assay_description',
    'assay_type',
    'assay_variant_accession',
    'assay_variant_mutation',
    'data_validity_comment',
    'document_chembl_id',
    'document_year',
    'molecule_chembl_id',
    'molecule_pref_name',
    'pchembl_value',
    'relation',
    'standard_relation',
    'standard_type',
    'standard_units',
    'standard_value',
    'target_chembl_id',
    'target_organism',
    'target_pref_name',
    'type',
    'units',
    'value',
  ];

  /** A full ChEMBL activity row: every field `/activity.json` returns, the unread ones included. */
  const fullRow = (activity_id: number, pchembl_value: string | null) => ({
    action_type: null,
    activity_comment: 'Not Active',
    activity_id,
    activity_properties: [],
    activity_supplementary_data: null,
    assay_chembl_id: 'CHEMBL674637',
    assay_description: 'Inhibition of EGFR',
    assay_type: 'B',
    assay_variant_accession: 'P00533',
    assay_variant_mutation: 'L858R',
    bao_endpoint: 'BAO_0000190',
    bao_format: 'BAO_0000357',
    bao_label: 'single protein format',
    canonical_smiles: 'CCO',
    data_validity_comment: 'Outside typical range',
    data_validity_description: 'Values for this activity type are unusually large/small',
    document_chembl_id: 'CHEMBL1145828',
    document_journal: 'J Med Chem',
    document_year: 2003,
    ligand_efficiency: { bei: '20.1', le: '0.4', lle: '3.2', sei: '9.9' },
    molecule_chembl_id: 'CHEMBL68920',
    molecule_pref_name: 'GEFITINIB',
    parent_molecule_chembl_id: 'CHEMBL68920',
    pchembl_value,
    potential_duplicate: 0,
    qudt_units: 'http://www.openphacts.org/units/Nanomolar',
    record_id: 1,
    relation: '=',
    src_id: 1,
    standard_flag: 1,
    standard_relation: '=',
    standard_text_value: null,
    standard_type: 'IC50',
    standard_units: 'nM',
    standard_upper_value: null,
    standard_value: '41.0',
    target_chembl_id: 'CHEMBL203',
    target_organism: 'Homo sapiens',
    target_pref_name: 'Epidermal growth factor receptor erbB1',
    target_tax_id: '9606',
    text_value: null,
    toid: null,
    type: 'IC50',
    units: 'uM',
    upper_value: null,
    uo_units: 'UO_0000065',
    value: '0.041',
  });

  it('names exactly the read fields on every view page — inline, cursor, and spill — and none on the count', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => fullRow(1 + i, '7.00'));
    fetchMock.mockImplementation(activityCorpus({ rows }));
    const svc = new ChemblService({ ...config, maxPageSize: 4 });
    const ctx = createMockContext({ tenantId: 'default' });
    const filters: GetActivitiesOptions = { targetChemblId: 'CHEMBL203' };
    expect(await svc.countActivities(filters, ctx)).toBe(10);
    const inline = [];
    for await (const row of svc.streamActivities({ ...filters, pageSize: 4 }, ctx)) {
      inline.push(row);
      if (inline.length === 4) break;
    }
    for await (const _row of svc.streamActivities(
      { ...filters, potencyView: 'null_potency', offset: 4 },
      ctx,
    )) {
      // drain the cursor page walk
    }
    const spilled = [];
    for await (const row of svc.spillActivities(filters, ctx, {
      deadline: new CallDeadline(45_000),
      maxRows: 50_000,
      onTotal: () => {},
      onDeadline: () => {},
    })) {
      spilled.push(row);
    }

    const requests = fetchMock.mock.calls.map((call) => new URL(String(call[0])).searchParams);
    const [count, ...pages] = requests;
    expect(count?.has('order_by')).toBe(false);
    expect(count?.has('only')).toBe(false);
    // 1 inline page + 2 cursor pages (offsets 4, 8) + the 3-page spill (0, 4, 8).
    expect(pages).toHaveLength(6);
    for (const params of pages) {
      expect(params.getAll('only')).toHaveLength(1);
      expect(params.get('only')?.split(',').sort()).toEqual(READ_FIELDS);
    }
    // Rows arrive trimmed to the selection and still normalize whole.
    expect(spilled).toHaveLength(10);
    expect(spilled[0]).toEqual({
      activity_comment: 'Not Active',
      activity_id: 1,
      assay_chembl_id: 'CHEMBL674637',
      assay_description: 'Inhibition of EGFR',
      assay_type: 'B',
      assay_variant_accession: 'P00533',
      assay_variant_mutation: 'L858R',
      data_validity_comment: 'Outside typical range',
      document_chembl_id: 'CHEMBL1145828',
      document_year: 2003,
      molecule_chembl_id: 'CHEMBL68920',
      molecule_pref_name: 'GEFITINIB',
      pchembl_value: 7,
      relation: '=',
      standard_relation: '=',
      standard_type: 'IC50',
      standard_units: 'nM',
      standard_value: 41,
      target_chembl_id: 'CHEMBL203',
      target_organism: 'Homo sapiens',
      target_pref_name: 'Epidermal growth factor receptor erbB1',
      type: 'IC50',
      units: 'uM',
      value: '0.041',
    });
    expect(inline).toEqual(spilled.slice(0, 4));
  });

  it('lists exactly the raw fields normalizeActivity reads, no more and no fewer', () => {
    const read = new Set<string>();
    /** A raw row that records every key read from it, answering each with `value`. */
    const recording = (value: unknown) =>
      new Proxy(
        {},
        {
          get(_target, key) {
            if (typeof key === 'string') read.add(key);
            return value;
          },
        },
      );
    // Absent fields and present ones, in case a read is ever conditional on a value.
    normalizeActivity(recording(undefined));
    normalizeActivity(recording('7.5'));
    expect([...read].sort()).toEqual([...ACTIVITY_FIELDS].sort());
    expect([...ACTIVITY_FIELDS].sort()).toEqual(READ_FIELDS);
  });
});
