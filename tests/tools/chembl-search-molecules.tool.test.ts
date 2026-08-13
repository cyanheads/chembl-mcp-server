/**
 * @fileoverview Behavior tests for chembl_search_molecules beyond the input gate:
 * name + structure search happy paths through a stubbed upstream, exact-identifier
 * queries routed to the by-resource lookup, the empty-result notice, truncation
 * enrichment at the limit boundary, cursor pagination, and the pure format() —
 * null fields render as "—"/(unnamed) and the similarity line appears only on a
 * search_type=similarity result.
 * @module tests/tools/chembl-search-molecules.tool
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { decodeCursor, encodeCursor } from '@cyanheads/mcp-ts-core/utils';
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

/**
 * A fake ChEMBL that honors `offset`/`limit` over a synthetic corpus, so a cursor
 * walk is checked against real row identity instead of a scripted page sequence.
 * Builds a fresh Response per call — a Response body reads only once.
 */
function stubMoleculeCorpus(total: number): void {
  fetchMock.mockImplementation((url: string | URL) => {
    const params = new URL(String(url)).searchParams;
    const offset = Number(params.get('offset') ?? 0);
    const limit = Number(params.get('limit') ?? 25);
    const molecules = corpusIds(total)
      .slice(offset, offset + limit)
      .map((molecule_chembl_id) => ({ ...aspirinRaw, molecule_chembl_id }));
    return Promise.resolve(jsonResponse({ molecules, page_meta: { total_count: total } }));
  });
}

const corpusIds = (total: number) => Array.from({ length: total }, (_, i) => `CHEMBL${i}`);
const idsOf = (molecules: { molecule_chembl_id: string }[]) =>
  molecules.map((m) => m.molecule_chembl_id);

describe('chembl_search_molecules — cursor pagination', () => {
  it('returns a nextCursor whenever more matches remain', async () => {
    stubMoleculeCorpus(618);
    const result = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({ query: 'kinase', limit: 3 }),
      ctx(),
    );
    expect(idsOf(result.molecules)).toEqual(['CHEMBL0', 'CHEMBL1', 'CHEMBL2']);
    // Opaque to the caller, but it must resume exactly where this page ended.
    expect(decodeCursor(result.nextCursor as string, createMockContext({}))).toMatchObject({
      offset: 3,
    });
  });

  it('redeems a cursor into a disjoint, contiguous next page', async () => {
    stubMoleculeCorpus(618);
    const first = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({ query: 'kinase', limit: 3 }),
      ctx(),
    );
    const second = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({
        query: 'kinase',
        limit: 3,
        cursor: first.nextCursor as string,
      }),
      ctx(),
    );
    const firstIds = idsOf(first.molecules);
    const secondIds = idsOf(second.molecules);
    // No overlap: the two ChEMBL ID sets are disjoint.
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    // No gap: concatenated, they are the corpus prefix in order.
    expect([...firstIds, ...secondIds]).toEqual(corpusIds(6));
  });

  it('walks the whole result set and omits nextCursor on the last page', async () => {
    stubMoleculeCorpus(7);
    const walked: string[] = [];
    const pageSizes: number[] = [];
    let cursor: string | undefined;
    // Bounded so a cursor that fails to advance fails the test instead of hanging.
    for (let page = 0; page < 10; page++) {
      const result = await chemblSearchMolecules.handler(
        chemblSearchMolecules.input.parse({ query: 'kinase', limit: 3, ...(cursor && { cursor }) }),
        ctx(),
      );
      pageSizes.push(result.molecules.length);
      walked.push(...idsOf(result.molecules));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeUndefined();
    expect(pageSizes).toEqual([3, 3, 1]);
    expect(walked).toEqual(corpusIds(7));
    expect(new Set(walked).size).toBe(7);
  });

  it('omits nextCursor when the first page already holds every match', async () => {
    stubMoleculeCorpus(2);
    const result = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({ query: 'kinase', limit: 25 }),
      ctx(),
    );
    expect(result.molecules).toHaveLength(2);
    // Omitted, not null and not '' — per the MCP pagination contract.
    expect(result).not.toHaveProperty('nextCursor');
  });

  it('stops flagging truncation on a full last page, matching the absent cursor', async () => {
    stubMoleculeCorpus(6);
    const mid = ctx();
    await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({ query: 'kinase', limit: 3 }),
      mid,
    );
    expect(getEnrichment(mid)).toMatchObject({ truncated: true, shown: 3, cap: 3 });

    // Same page size, exactly fills the last page — the cap withholds nothing now.
    const last = ctx();
    const result = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({
        query: 'kinase',
        limit: 3,
        cursor: encodeCursor({ offset: 3, limit: 3 }),
      }),
      last,
    );
    expect(result.molecules).toHaveLength(3);
    expect(result).not.toHaveProperty('nextCursor');
    expect(getEnrichment(last)).toMatchObject({ truncated: false, shown: 3, cap: 3 });
  });

  it('takes the page size from limit on the follow-up call, not from the cursor', async () => {
    stubMoleculeCorpus(618);
    const first = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({ query: 'kinase', limit: 3 }),
      ctx(),
    );
    const second = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({
        query: 'kinase',
        limit: 2,
        cursor: first.nextCursor as string,
      }),
      ctx(),
    );
    expect(idsOf(second.molecules)).toEqual(['CHEMBL3', 'CHEMBL4']);
  });

  it('paginates a substructure search on the structure endpoint', async () => {
    stubMoleculeCorpus(30_000);
    const first = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({
        structure: 'c1ccccc1',
        search_type: 'substructure',
        limit: 3,
      }),
      ctx(),
    );
    const second = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({
        structure: 'c1ccccc1',
        search_type: 'substructure',
        limit: 3,
        cursor: first.nextCursor as string,
      }),
      ctx(),
    );
    expect(idsOf(second.molecules)).toEqual(['CHEMBL3', 'CHEMBL4', 'CHEMBL5']);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('substructure');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('offset=3');
  });

  it('paginates a similarity search, carrying the Tanimoto percent onto later pages', async () => {
    fetchMock.mockImplementation((url: string | URL) => {
      const offset = Number(new URL(String(url)).searchParams.get('offset') ?? 0);
      return Promise.resolve(
        jsonResponse({
          molecules: [{ ...aspirinRaw, molecule_chembl_id: `CHEMBL${offset}`, similarity: '87.5' }],
          page_meta: { total_count: 595 },
        }),
      );
    });
    const first = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({
        structure: 'CC(=O)Oc1ccccc1C(=O)O',
        search_type: 'similarity',
        similarity_threshold: 40,
        limit: 1,
      }),
      ctx(),
    );
    const second = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({
        structure: 'CC(=O)Oc1ccccc1C(=O)O',
        search_type: 'similarity',
        similarity_threshold: 40,
        limit: 1,
        cursor: first.nextCursor as string,
      }),
      ctx(),
    );
    expect(idsOf(second.molecules)).toEqual(['CHEMBL1']);
    expect(second.molecules[0]?.similarity).toBe(87.5);
  });

  it('reports an exhausted walk instead of a spelling problem past the end', async () => {
    stubMoleculeCorpus(7);
    const c = ctx();
    const result = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({
        query: 'kinase',
        limit: 3,
        cursor: encodeCursor({ offset: 900, limit: 3 }),
      }),
      c,
    );
    expect(result.molecules).toEqual([]);
    expect(result).not.toHaveProperty('nextCursor');
    const enrichment = getEnrichment(c) as { notice?: string; totalCount?: number };
    expect(enrichment.totalCount).toBe(7);
    expect(enrichment.notice).toContain('7');
    expect(enrichment.notice).not.toContain('spelling');
  });

  it('rejects a malformed cursor with InvalidParams, unwrapped by a declared reason', async () => {
    // `handler` is typed to allow a sync return, so normalize before catching.
    const err: unknown = await Promise.resolve(
      chemblSearchMolecules.handler(
        chemblSearchMolecules.input.parse({ query: 'kinase', cursor: 'not-a-real-cursor' }),
        ctx(),
      ),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
    // Straight from the framework's decodeCursor — never re-declared locally,
    // which would risk drifting off the -32602 the MCP pagination spec mandates.
    expect((err as McpError).data).not.toHaveProperty('reason');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a tampered cursor before anything reaches ChEMBL', async () => {
    // ChEMBL answers 200 with page 1 for a negative offset, so this must be
    // caught at this server's boundary, not upstream.
    const tampered = Buffer.from(JSON.stringify({ offset: -1, limit: 3 })).toString('base64url');
    await expect(
      chemblSearchMolecules.handler(
        chemblSearchMolecules.input.parse({ query: 'kinase', cursor: tampered }),
        ctx(),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * A `query` that is itself a unique identifier resolves through the by-resource
 * lookup (#7), so the count the agent reasons over is 1 rather than the fuzzy
 * endpoint's 10000 result window — and the page it gets back is complete, so it
 * carries no continuation.
 */
describe('chembl_search_molecules — exact-identifier queries', () => {
  /** Answer every call with one body; a fresh Response per call. */
  function stub(body: unknown, status = 200): void {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(body, status)));
  }
  const firstUrl = () => String(fetchMock.mock.calls[0]?.[0]);

  it('answers an InChIKey with the one matching compound and a total of 1', async () => {
    stub(aspirinRaw);
    const c = ctx();
    const result = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({ query: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N' }),
      c,
    );
    expect(firstUrl()).toContain('/molecule/BSYNRYMUTXBXSQ-UHFFFAOYSA-N.json');
    expect(idsOf(result.molecules)).toEqual(['CHEMBL25']);
    expect(result).not.toHaveProperty('nextCursor');
    expect(getEnrichment(c)).toMatchObject({ totalCount: 1, truncated: false, shown: 1 });
    // The content surface carries the same row for content-only clients.
    const text = (chemblSearchMolecules.format!(result)[0] as { text: string }).text;
    expect(text).toContain('**CHEMBL25**');
    expect(text).toContain('ASPIRIN');
    expect(text.toLowerCase()).not.toContain('cursor');
  });

  it('answers a ChEMBL ID the same way', async () => {
    stub(aspirinRaw);
    const c = ctx();
    const result = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({ query: 'CHEMBL25' }),
      c,
    );
    expect(firstUrl()).toContain('/molecule/CHEMBL25.json');
    expect(idsOf(result.molecules)).toEqual(['CHEMBL25']);
    expect(result).not.toHaveProperty('nextCursor');
    expect(getEnrichment(c)).toMatchObject({ totalCount: 1, truncated: false, shown: 1 });
  });

  it('does not flag truncation when a limit of 1 exactly fits the single hit', async () => {
    stub(aspirinRaw);
    const c = ctx();
    const result = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({ query: 'CHEMBL25', limit: 1 }),
      c,
    );
    // items.length === limit, but nothing is withheld — the cap disclosure must
    // agree with the absent cursor.
    expect(result).not.toHaveProperty('nextCursor');
    expect(getEnrichment(c)).toMatchObject({ truncated: false, shown: 1, cap: 1 });
  });

  it('keeps a filtered identifier query on the fuzzy path, never dropping the filter', async () => {
    stub({
      molecules: [aspirinRaw, { ...aspirinRaw, molecule_chembl_id: 'CHEMBL1697753' }],
      page_meta: { total_count: 2 },
    });
    const c = ctx();
    const result = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({ query: 'CHEMBL25', max_phase_min: 4 }),
      c,
    );
    expect(firstUrl()).toContain('/molecule/search.json');
    expect(firstUrl()).toContain('max_phase__gte=4');
    expect(idsOf(result.molecules)).toEqual(['CHEMBL25', 'CHEMBL1697753']);
    expect(getEnrichment(c)).toMatchObject({ totalCount: 2 });
  });

  it('returns the empty-result notice for a well-formed identifier ChEMBL does not hold', async () => {
    stub({ error_message: 'not found' }, 404);
    const c = ctx();
    const result = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({ query: 'CHEMBL999999999' }),
      c,
    );
    // The miss is an empty page, not a failed call.
    expect(result.molecules).toEqual([]);
    const enrichment = getEnrichment(c) as { notice?: string; totalCount?: number };
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toContain('CHEMBL999999999');
    expect(enrichment.notice).toContain('No compound matched');
  });

  it('reports a cursor redeemed against an identifier query as an exhausted walk', async () => {
    stub(aspirinRaw);
    const c = ctx();
    const result = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({
        query: 'CHEMBL25',
        limit: 3,
        cursor: encodeCursor({ offset: 3, limit: 3 }),
      }),
      c,
    );
    expect(result.molecules).toEqual([]);
    expect(result).not.toHaveProperty('nextCursor');
    const enrichment = getEnrichment(c) as { notice?: string; totalCount?: number };
    expect(enrichment.totalCount).toBe(1);
    // Not a spelling problem — the identifier resolved, the window ran past it.
    expect(enrichment.notice).toContain('walk is complete');
    expect(enrichment.notice).not.toContain('spelling');
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

  /**
   * Only `search_type=similarity` carries the percent (#13) — ChEMBL's exact and
   * substructure endpoints omit the key rather than sending null, so neither
   * response surface may imply a score.
   */
  it('omits similarity on an exact structure hit, on both response surfaces', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(aspirinRaw));
    const result = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({
        structure: 'CC(=O)Oc1ccccc1C(=O)O',
        search_type: 'exact',
      }),
      ctx(),
    );
    expect(result.molecules).toHaveLength(1);
    expect(result.molecules[0]?.similarity).toBeUndefined();
    expect(result.molecules[0]).not.toHaveProperty('similarity');
    expect((chemblSearchMolecules.format!(result)[0] as { text: string }).text).not.toContain(
      'Similarity:',
    );
  });

  it('omits similarity on every substructure row, on both response surfaces', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        molecules: Array.from({ length: 5 }, (_, i) => ({
          ...aspirinRaw,
          molecule_chembl_id: `CHEMBL${i}`,
        })),
        page_meta: { total_count: 5 },
      }),
    );
    const result = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({ structure: 'c1ccccc1', search_type: 'substructure' }),
      ctx(),
    );
    expect(result.molecules).toHaveLength(5);
    for (const molecule of result.molecules) {
      expect(molecule).not.toHaveProperty('similarity');
    }
    expect((chemblSearchMolecules.format!(result)[0] as { text: string }).text).not.toContain(
      'Similarity:',
    );
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

  it('discloses the continuation to a content-only client when a cursor is present', () => {
    const blocks = chemblSearchMolecules.format!({
      molecules: [
        {
          molecule_chembl_id: 'CHEMBL25',
          pref_name: 'ASPIRIN',
          canonical_smiles: null,
          standard_inchi_key: null,
          full_molformula: null,
          mw_freebase: null,
          alogp: null,
          num_ro5_violations: null,
          qed_weighted: null,
          max_phase: 4,
          molecule_type: null,
        },
      ],
      nextCursor: 'OPAQUE-CURSOR-TOKEN',
    });
    const text = blocks.map((b) => (b as { text: string }).text).join('\n');
    expect(text).toContain('OPAQUE-CURSOR-TOKEN');
    expect(text.toLowerCase()).toContain('cursor');
  });

  it('says nothing about continuing when the page is the last one', () => {
    const blocks = chemblSearchMolecules.format!({
      molecules: [
        {
          molecule_chembl_id: 'CHEMBL25',
          pref_name: 'ASPIRIN',
          canonical_smiles: null,
          standard_inchi_key: null,
          full_molformula: null,
          mw_freebase: null,
          alogp: null,
          num_ro5_violations: null,
          qed_weighted: null,
          max_phase: 4,
          molecule_type: null,
        },
      ],
    });
    const text = blocks.map((b) => (b as { text: string }).text).join('\n');
    expect(text.toLowerCase()).not.toContain('cursor');
  });
});
