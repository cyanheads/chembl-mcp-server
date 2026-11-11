/**
 * @fileoverview Behavior tests for chembl_search_molecules beyond the input gate:
 * name + structure search happy paths through a stubbed upstream, exact-identifier
 * queries routed to the by-resource lookup, the empty-result notice, truncation
 * enrichment at the limit boundary, cursor pagination, ChEMBL's search ceilings
 * (#42), an unparseable SMILES as invalid_structure (#43), the limit clamp (#41),
 * each row's parent_chembl_id (#37), and the pure format() — null fields render as
 * "—"/(unnamed), the similarity line appears only on a search_type=similarity
 * result, SMILES render as code spans (#40), and upstream text renders inert (#44).
 * @module tests/tools/chembl-search-molecules.tool
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { decodeCursor, encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblGetDrugInfo } from '@/mcp-server/tools/definitions/chembl-get-drug-info.tool.js';
import { chemblSearchMolecules } from '@/mcp-server/tools/definitions/chembl-search-molecules.tool.js';
import { initChemblService } from '@/services/chembl/chembl-service.js';
import { SUBSTRUCTURE_UNPARSEABLE_BODY } from '../_chembl-error-bodies.js';
import { codeSpans, markupNodes, parseMarkdown } from '../_commonmark.js';

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

  it('rejects a malformed cursor with InvalidParams and framework recovery', async () => {
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
    expect((err as McpError).data).toMatchObject({
      reason: 'invalid_cursor',
      recovery: { hint: expect.any(String) },
    });
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

  it.each(['', '   ', '\t\n'])(
    'reads the blank cursor %j as omitted: the first page',
    async (cursor) => {
      stubMoleculeCorpus(7);
      const result = await chemblSearchMolecules.handler(
        chemblSearchMolecules.input.parse({ query: 'kinase', limit: 3, cursor }),
        ctx(),
      );
      expect(idsOf(result.molecules)).toEqual(['CHEMBL0', 'CHEMBL1', 'CHEMBL2']);
      expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('offset')).toBe('0');
    },
  );
});

/**
 * ChEMBL stops a substructure search at 30000 hits and a name search at 10000,
 * and reports the ceiling as the total (#42). The response flags the total as a
 * lower bound on both surfaces, says the rows past it are unreachable, and never
 * calls a walk stopped there complete.
 */
describe('chembl_search_molecules — ChEMBL search ceilings (#42)', () => {
  const SUBSTRUCTURE_CEILING =
    'At least 30000 compounds match substructure structure "c1ccncc1": ChEMBL stops counting and paging a substructure search at 30000, so the matches past it cannot be reached. Search a larger, more specific substructure to bring the matches under that ceiling.';
  const NAME_CEILING =
    'At least 10000 compounds match query "acid": ChEMBL stops counting and paging a name search at 10000, so the matches past it cannot be reached. Use a more specific name, or set max_phase_min, to bring the matches under that ceiling.';

  const pyridine = (extra: Record<string, unknown> = {}) => ({
    structure: 'c1ccncc1',
    search_type: 'substructure',
    limit: 2,
    ...extra,
  });

  /** Run through the full contract; hand back structuredContent and the content[] lines. */
  async function call(input: Record<string, unknown>) {
    const result = await runToolContract(chemblSearchMolecules, input, {
      context: { tenantId: 'default' },
    });
    expect(result.isError).toBeFalsy();
    const lines = result.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .split('\n');
    return { structured: result.structuredContent as Record<string, unknown>, lines };
  }

  it('flags a substructure search at its ceiling as a lower bound on both surfaces', async () => {
    stubMoleculeCorpus(30_000);
    const { structured, lines } = await call(pyridine());
    const notice = `Showing 2 of the first 30000; pass nextCursor back as cursor for the next page. ${SUBSTRUCTURE_CEILING}`;
    expect(structured).toMatchObject({
      totalCount: 30_000,
      totalCountCapped: true,
      truncated: true,
      notice,
    });
    expect(decodeCursor(structured.nextCursor as string, ctx())).toMatchObject({
      offset: 2,
      limit: 2,
    });
    expect(lines).toContain(`> ${notice}`);
    expect(lines).toContain('**30000 total**');
    expect(lines).toContain('**totalCountCapped:** true');
  });

  it('flags a name search at its ceiling, pointing at the name and max_phase_min', async () => {
    stubMoleculeCorpus(10_000);
    const { structured, lines } = await call({ query: 'acid', limit: 2 });
    const notice = `Showing 2 of the first 10000; pass nextCursor back as cursor for the next page. ${NAME_CEILING}`;
    expect(structured).toMatchObject({ totalCount: 10_000, totalCountCapped: true, notice });
    expect(lines).toContain(`> ${notice}`);
  });

  it('carries the clamp notice ahead of the ceiling on a clamped first page', async () => {
    stubMoleculeCorpus(30_000);
    const { structured } = await call(pyridine({ limit: 101 }));
    expect(structured.notice).toBe(
      `limit 101 is above the maximum of 100, so 100 was applied. Showing 100 of the first 30000; pass nextCursor back as cursor for the next page. ${SUBSTRUCTURE_CEILING}`,
    );
  });

  it('leaves an under-ceiling name search unflagged, its total exact', async () => {
    stubMoleculeCorpus(2539);
    const { structured, lines } = await call({ query: 'inhibitor', limit: 2 });
    expect(structured).toMatchObject({
      totalCount: 2539,
      totalCountCapped: false,
      truncated: true,
      notice: 'Results capped at 2; showing 2. Raise the cap or narrow with filters.',
    });
    expect(lines).toContain('**totalCountCapped:** false');
  });

  it.each([
    ['substructure', pyridine(), 29_999],
    ['name', { query: 'acid', limit: 2 }, 9_999],
  ])('leaves a %s search one below its ceiling unflagged', async (_label, input, total) => {
    stubMoleculeCorpus(total);
    const { structured, lines } = await call(input);
    expect(structured).toMatchObject({
      totalCount: total,
      totalCountCapped: false,
      truncated: true,
      notice: 'Results capped at 2; showing 2. Raise the cap or narrow with filters.',
    });
    expect(lines).toContain('**totalCountCapped:** false');
  });

  it.each([
    [
      'a similarity search',
      { structure: 'CC(=O)Oc1ccccc1C(=O)O', search_type: 'similarity', similarity_threshold: 70 },
      { molecules: [{ ...aspirinRaw, similarity: '100' }], page_meta: { total_count: 9 } },
      9,
    ],
    [
      'an exact structure hit',
      { structure: 'CC(=O)Oc1ccccc1C(=O)O', search_type: 'exact' },
      aspirinRaw,
      1,
    ],
    ['an exact identifier lookup', { query: 'CHEMBL25' }, aspirinRaw, 1],
  ])('leaves %s unflagged', async (_label, input, body, total) => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(body)));
    const { structured } = await call(input);
    expect(structured).toMatchObject({ totalCount: total, totalCountCapped: false });
  });

  it('serves the last row below the ceiling with no nextCursor and the ceiling notice', async () => {
    stubMoleculeCorpus(30_000);
    const { structured, lines } = await call(
      pyridine({ cursor: encodeCursor({ offset: 29_999, limit: 2 }) }),
    );
    expect(structured.molecules).toEqual([
      expect.objectContaining({ molecule_chembl_id: 'CHEMBL29999' }),
    ]);
    expect(structured).not.toHaveProperty('nextCursor');
    expect(structured).toMatchObject({
      totalCount: 30_000,
      totalCountCapped: true,
      truncated: false,
      notice: SUBSTRUCTURE_CEILING,
    });
    expect(lines).toContain(`> ${SUBSTRUCTURE_CEILING}`);
  });

  it.each([
    ['substructure', pyridine(), 30_000, SUBSTRUCTURE_CEILING],
    ['name', { query: 'acid', limit: 2 }, 10_000, NAME_CEILING],
  ])(
    'ends a %s walk at the ceiling without calling it complete',
    async (_label, input, total, ceiling) => {
      stubMoleculeCorpus(total);
      const { structured, lines } = await call({
        ...input,
        cursor: encodeCursor({ offset: total, limit: 2 }),
      });
      const notice = `That cursor starts at or past ChEMBL's search ceiling, so the walk ends here short of the last match. ${ceiling}`;
      expect(structured.molecules).toEqual([]);
      expect(structured).not.toHaveProperty('nextCursor');
      expect(structured).toMatchObject({ totalCount: total, totalCountCapped: true, notice });
      expect(lines).toContain(`> ${notice}`);
    },
  );

  it('keeps the complete-walk notice past the end of an uncapped search', async () => {
    stubMoleculeCorpus(7);
    const { structured } = await call({
      query: 'kinase',
      limit: 3,
      cursor: encodeCursor({ offset: 9, limit: 3 }),
    });
    expect(structured).toMatchObject({
      totalCount: 7,
      totalCountCapped: false,
      notice:
        'That cursor starts past the end of the 7 compounds matching query "kinase" — the walk is complete.',
    });
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

  it('fails a SMILES ChEMBL cannot parse as invalid_structure on both surfaces, one request (#43)', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(SUBSTRUCTURE_UNPARSEABLE_BODY, {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const result = await runToolContract(
      chemblSearchMolecules,
      { structure: 'C(C)(C)(C)(C)C', search_type: 'substructure' },
      { context: { tenantId: 'default' } },
    );
    const hint =
      'Check the SMILES for an atom over its valence (a carbon with five bonds), an unclosed ring-closure digit or parenthesis, or an aromatic ring that cannot be kekulized, then retry.';
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message: 'ChEMBL could not parse the query structure.',
        data: { reason: 'invalid_structure', recovery: { hint } },
      },
    });
    const lines = result.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .split('\n');
    expect(lines).toContain('Error: ChEMBL could not parse the query structure.');
    expect(lines).toContain(`Recovery: ${hint}`);
    expect(JSON.stringify(result)).not.toContain('SanitizeMol');
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

  it('rejects a limit above the 10000 ceiling at the schema', () => {
    expect(() => chemblSearchMolecules.input.parse({ query: 'x', limit: 10_001 })).toThrow();
  });

  it('clamps a limit above 100 to 100 with a notice, on both surfaces (#41)', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          molecules: Array.from({ length: 100 }, (_, i) => ({
            ...aspirinRaw,
            molecule_chembl_id: `CHEMBL${i}`,
          })),
          page_meta: { total_count: 400 },
        }),
      ),
    );
    const result = await runToolContract(
      chemblSearchMolecules,
      { query: 'kinase inhibitor', limit: 101 },
      { context: { tenantId: 'default' } },
    );
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('limit')).toBe('100');
    const notice =
      'limit 101 is above the maximum of 100, so 100 was applied. Showing 100 of 400; pass nextCursor back as cursor for the next page.';
    expect(result.structuredContent).toMatchObject({
      truncated: true,
      shown: 100,
      cap: 100,
      notice,
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text.split('\n')).toContain(`> ${notice}`);
  });

  it('keeps a lowercase ChEMBL ID query on the fuzzy search, untouched (#7)', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ molecules: [aspirinRaw], page_meta: { total_count: 1 } })),
    );
    await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({ query: 'chembl25' }),
      ctx(),
    );
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/chembl/api/data/molecule/search.json');
    expect(url.searchParams.get('q')).toBe('chembl25');
  });

  it('rejects max_phase_min above 4 at the schema', () => {
    expect(() => chemblSearchMolecules.input.parse({ query: 'x', max_phase_min: 5 })).toThrow();
  });
});

/** One analog of the fake structure corpus: its ID and recorded max phase (null when none). */
interface Analog {
  id: string;
  phase: number | null;
}

/**
 * The imatinib analog set ChEMBL returns for a similarity search at 70 (counts as
 * of 2026-11-11): two approved drugs, four other recorded phases, 84 compounds
 * with no recorded phase.
 */
const IMATINIB_ANALOGS: Analog[] = [
  { id: 'CHEMBL941', phase: 4 },
  { id: 'CHEMBL1642', phase: 4 },
  { id: 'CHEMBL3', phase: 3 },
  { id: 'CHEMBL4', phase: 2 },
  { id: 'CHEMBL5', phase: 1 },
  { id: 'CHEMBL6', phase: 0.5 },
  ...Array.from({ length: 84 }, (_, i) => ({ id: `CHEMBL9${i}`, phase: null })),
];

const IMATINIB_SMILES = 'Cc1ccc(NC(=O)c2ccc(CN3CCN(C)CC3)cc2)cc1Nc1nccc(-c2cccnc2)n1';

/**
 * A fake ChEMBL structure-search upstream. The similarity, substructure, and name
 * routes page `corpus` by `limit`/`offset` and honor `max_phase__gte`, which a null
 * phase never passes. The substructure route stops at `ceiling` hits BEFORE it filters,
 * the way ChEMBL applies a filter to the first 30000 substructure hits only, and
 * reports at most `ceiling` as the total. The exact route answers `exact` — one
 * molecule object, whatever the query string, `limit`, or `offset`. Every request
 * URL lands in the returned list.
 */
function stubStructureUpstream(opts: {
  corpus?: Analog[];
  ceiling?: number;
  exact?: Analog;
}): URL[] {
  const requests: URL[] = [];
  fetchMock.mockImplementation((input: string | URL) => {
    const url = new URL(String(input));
    requests.push(url);
    const path = url.pathname.replace('/chembl/api/data/', '');
    // The name route lists over the corpus like the structure list routes.
    const route = path.startsWith('molecule/search') ? 'search' : path.split('/')[0];
    const row = (a: Analog) => ({
      ...aspirinRaw,
      molecule_chembl_id: a.id,
      max_phase: a.phase === null ? null : String(a.phase),
      ...(route === 'similarity' && { similarity: '80' }),
    });
    if (route === 'molecule') {
      return Promise.resolve(
        opts.exact ? jsonResponse(row(opts.exact)) : jsonResponse({ error_message: 'nf' }, 404),
      );
    }
    const params = url.searchParams;
    const min = params.get('max_phase__gte');
    const reachable =
      route === 'substructure' ? (opts.corpus ?? []).slice(0, opts.ceiling) : (opts.corpus ?? []);
    const matches =
      min === null
        ? reachable
        : reachable.filter((a) => a.phase !== null && a.phase >= Number(min));
    const offset = Number(params.get('offset') ?? 0);
    const limit = Number(params.get('limit') ?? 25);
    return Promise.resolve(
      jsonResponse({
        molecules: matches.slice(offset, offset + limit).map(row),
        page_meta: { total_count: matches.length },
      }),
    );
  });
  return requests;
}

/**
 * `max_phase_min` on every search_type (#50): ChEMBL's similarity and
 * substructure routes take it as `max_phase__gte`, and the one exact hit is
 * checked against it locally. Inputs the chosen search_type does not read are
 * named in the notice instead of dropped silently.
 */
describe('chembl_search_molecules — max_phase_min on structure searches (#50)', () => {
  /** Run through the full contract; hand back structuredContent and the content[] lines. */
  async function call(input: Record<string, unknown>) {
    const result = await runToolContract(chemblSearchMolecules, input, {
      context: { tenantId: 'default' },
    });
    expect(result.isError).toBeFalsy();
    const lines = result.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .split('\n');
    return {
      structured: result.structuredContent as Record<string, unknown> & {
        molecules: { molecule_chembl_id: string; max_phase: number | null }[];
      },
      lines,
    };
  }
  const similarity = (extra: Record<string, unknown> = {}) => ({
    search_type: 'similarity',
    structure: IMATINIB_SMILES,
    limit: 100,
    ...extra,
  });
  const phases = (molecules: { max_phase: number | null }[]) => molecules.map((m) => m.max_phase);

  it('filters a similarity search upstream by max_phase__gte', async () => {
    const requests = stubStructureUpstream({ corpus: IMATINIB_ANALOGS });
    const { structured, lines } = await call(similarity({ max_phase_min: 4 }));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.searchParams.get('max_phase__gte')).toBe('4');
    expect(idsOf(structured.molecules)).toEqual(['CHEMBL941', 'CHEMBL1642']);
    expect(phases(structured.molecules)).toEqual([4, 4]);
    expect(structured).toMatchObject({ totalCount: 2, totalCountCapped: false });
    expect(structured).not.toHaveProperty('notice');
    expect(lines).toContain('**2 total**');
  });

  it('leaves an unfiltered similarity search at the full analog count', async () => {
    const requests = stubStructureUpstream({ corpus: IMATINIB_ANALOGS });
    const { structured } = await call(similarity());
    expect(requests[0]?.searchParams.has('max_phase__gte')).toBe(false);
    expect(structured).toMatchObject({ totalCount: 90 });
  });

  it('sends max_phase_min 0, which excludes every compound with no recorded phase', async () => {
    const requests = stubStructureUpstream({ corpus: IMATINIB_ANALOGS });
    const { structured } = await call(similarity({ max_phase_min: 0 }));
    expect(requests[0]?.searchParams.get('max_phase__gte')).toBe('0');
    expect(structured.totalCount).toBe(6);
    expect(phases(structured.molecules)).toEqual([4, 4, 3, 2, 1, 0.5]);
  });

  it('filters a substructure search upstream and checks the unfiltered total against the ceiling', async () => {
    const requests = stubStructureUpstream({ corpus: IMATINIB_ANALOGS.slice(0, 68) });
    const { structured } = await call({
      search_type: 'substructure',
      structure: IMATINIB_SMILES,
      max_phase_min: 4,
      limit: 50,
    });
    expect(idsOf(structured.molecules)).toEqual(['CHEMBL941', 'CHEMBL1642']);
    expect(structured).toMatchObject({ totalCount: 2, totalCountCapped: false });
    expect(structured).not.toHaveProperty('notice');
    // The page carries the filter; the count beside it asks for one unfiltered row.
    const filtered = requests.filter((u) => u.searchParams.has('max_phase__gte'));
    const unfiltered = requests.filter((u) => !u.searchParams.has('max_phase__gte'));
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.searchParams.get('limit')).toBe('50');
    expect(unfiltered).toHaveLength(1);
    expect(unfiltered[0]?.pathname).toBe(filtered[0]?.pathname);
    expect(unfiltered[0]?.searchParams.get('limit')).toBe('1');
  });

  it('sends one request for an unfiltered substructure search', async () => {
    const requests = stubStructureUpstream({ corpus: IMATINIB_ANALOGS.slice(0, 68) });
    const { structured } = await call({ search_type: 'substructure', structure: IMATINIB_SMILES });
    expect(requests).toHaveLength(1);
    expect(structured.totalCount).toBe(68);
  });

  /**
   * ChEMBL filters only the first 30000 hits of a substructure search, so a
   * filtered total under that ceiling still misses the qualifying compounds past
   * it whenever the unfiltered search reaches it.
   */
  it('flags a filtered substructure search whose unfiltered hits reach the ceiling as a lower bound', async () => {
    const corpus: Analog[] = Array.from({ length: 30_010 }, (_, i) => ({
      id: `CHEMBL${i}`,
      // Approved: three inside the first 30000 hits, two past them.
      phase: [7, 900, 29_999, 30_000, 30_009].includes(i) ? 4 : null,
    }));
    stubStructureUpstream({ corpus, ceiling: 30_000 });
    const { structured, lines } = await call({
      search_type: 'substructure',
      structure: 'c1ccncc1',
      max_phase_min: 4,
    });
    const notice =
      'ChEMBL applies max_phase_min to only the first 30000 hits of a substructure search, and substructure structure "c1ccncc1" reaches that ceiling, so the 3 matches are a lower bound: qualifying compounds past those hits are missed. Search a larger, more specific substructure to bring the matches under that ceiling.';
    expect(idsOf(structured.molecules)).toEqual(['CHEMBL7', 'CHEMBL900', 'CHEMBL29999']);
    expect(structured).toMatchObject({ totalCount: 3, totalCountCapped: true, notice });
    expect(lines).toContain(`> ${notice}`);
    expect(lines).toContain('**totalCountCapped:** true');
  });

  it('pages a capped filtered substructure search with the ceiling on every page', async () => {
    const corpus: Analog[] = Array.from({ length: 30_010 }, (_, i) => ({
      id: `CHEMBL${i}`,
      phase: i < 5 ? 4 : null,
    }));
    stubStructureUpstream({ corpus, ceiling: 30_000 });
    const first = await call({
      search_type: 'substructure',
      structure: 'c1ccncc1',
      max_phase_min: 4,
      limit: 2,
    });
    const ceiling =
      'ChEMBL applies max_phase_min to only the first 30000 hits of a substructure search, and substructure structure "c1ccncc1" reaches that ceiling, so the 5 matches are a lower bound: qualifying compounds past those hits are missed. Search a larger, more specific substructure to bring the matches under that ceiling.';
    expect(first.structured).toMatchObject({
      truncated: true,
      totalCountCapped: true,
      notice: `Showing 2 of 5; pass nextCursor back as cursor for the next page. ${ceiling}`,
    });
    const past = await call({
      search_type: 'substructure',
      structure: 'c1ccncc1',
      max_phase_min: 4,
      limit: 2,
      cursor: encodeCursor({ offset: 6, limit: 2 }),
    });
    expect(past.structured.molecules).toEqual([]);
    expect(past.structured.notice).toBe(
      `That cursor starts past the last of the 5 compounds ChEMBL returned, so the walk ends here short of the last match. ${ceiling}`,
    );
  });

  it('keeps an exact hit at or above max_phase_min, never sending the filter upstream', async () => {
    const requests = stubStructureUpstream({ exact: { id: 'CHEMBL941', phase: 4 } });
    const { structured } = await call({
      search_type: 'exact',
      structure: IMATINIB_SMILES,
      max_phase_min: 4,
    });
    expect(idsOf(structured.molecules)).toEqual(['CHEMBL941']);
    expect(structured).toMatchObject({ totalCount: 1 });
    expect(structured).not.toHaveProperty('notice');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.searchParams.has('max_phase__gte')).toBe(false);
  });

  it.each([
    ['no recorded phase', null, 4],
    ['a phase below the minimum', 3, 4],
    ['a phase unknown (−1) under max_phase_min 0', -1, 0],
  ])(
    'drops an exact hit with %s, naming max_phase_min in the notice',
    async (_label, phase, min) => {
      stubStructureUpstream({ exact: { id: 'CHEMBL205409', phase } });
      const { structured, lines } = await call({
        search_type: 'exact',
        structure: 'CCO',
        max_phase_min: min,
      });
      const notice = `No compound matched exact structure "CCO" with max_phase_min=${min}. Retry without max_phase_min first: it keeps only compounds whose recorded max clinical phase is at least ${min}, and one with no recorded phase never passes. Otherwise check the SMILES, or run a similarity or substructure search.`;
      expect(structured.molecules).toEqual([]);
      expect(structured).toMatchObject({ totalCount: 0, notice });
      expect(lines).toContain(`> ${notice}`);
    },
  );

  it('names max_phase_min in the zero-hit notice of a filtered similarity search', async () => {
    stubStructureUpstream({ corpus: IMATINIB_ANALOGS.slice(6) });
    const { structured } = await call(similarity({ structure: 'CCO', max_phase_min: 4 }));
    expect(structured.notice).toBe(
      'No compound matched similarity structure "CCO" with max_phase_min=4. Retry without max_phase_min first: it keeps only compounds whose recorded max clinical phase is at least 4, and one with no recorded phase never passes. Otherwise check the SMILES or lower the similarity threshold.',
    );
  });

  it('names max_phase_min in the zero-hit notice of a filtered name search', async () => {
    stubMoleculeCorpus(0);
    const { structured } = await call({ query: 'zzzz', max_phase_min: 2 });
    expect(structured.notice).toBe(
      'No compound matched query "zzzz" with max_phase_min=2. Retry without max_phase_min first: it keeps only compounds whose recorded max clinical phase is at least 2, and one with no recorded phase never passes. Otherwise check the spelling or try a broader name.',
    );
  });

  /** Each search_type gets only the advice it can act on: a name search has no SMILES or threshold. */
  it.each([
    [
      'name',
      { query: 'zzzz' },
      'No compound matched query "zzzz": check the spelling or try a broader name.',
    ],
    [
      'similarity',
      similarity({ structure: 'CCO' }),
      'No compound matched similarity structure "CCO": check the SMILES or lower the similarity threshold.',
    ],
    [
      'substructure',
      { search_type: 'substructure', structure: 'CCO' },
      'No compound matched substructure structure "CCO": check the SMILES or try a smaller substructure.',
    ],
  ])('fits the unfiltered %s zero-hit advice to the search type', async (_label, input, notice) => {
    // An empty corpus answers the name route and the structure routes alike.
    stubStructureUpstream({ corpus: [] });
    const { structured, lines } = await call(input);
    expect(structured.notice).toBe(notice);
    expect(lines).toContain(`> ${notice}`);
  });

  it('names a query sent with a structure search as ignored', async () => {
    const requests = stubStructureUpstream({ corpus: IMATINIB_ANALOGS });
    const { structured, lines } = await call(similarity({ query: 'imatinib' }));
    const notice = 'query was ignored: search_type=similarity searches by structure only.';
    expect(structured).toMatchObject({ totalCount: 90, notice });
    expect(lines).toContain(`> ${notice}`);
    expect(requests[0]?.searchParams.has('q')).toBe(false);
  });

  it('names a structure sent with a name search as ignored', async () => {
    stubMoleculeCorpus(5);
    const { structured, lines } = await call({ query: 'imatinib', structure: 'CCO' });
    const notice =
      'structure was ignored: search_type=name searches by query only; set search_type to exact, similarity, or substructure to search by structure.';
    expect(structured).toMatchObject({ totalCount: 5, notice });
    expect(lines).toContain(`> ${notice}`);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/molecule/search.json');
  });

  it.each(['', '   '])('reads a blank %j query on a structure search as omitted', async (query) => {
    stubStructureUpstream({ corpus: IMATINIB_ANALOGS });
    const { structured } = await call(similarity({ query }));
    expect(structured).not.toHaveProperty('notice');
  });

  it('joins the clamp, the ignored input, and the zero-hit diagnosis in one notice', async () => {
    stubStructureUpstream({ corpus: IMATINIB_ANALOGS.slice(6) });
    const { structured, lines } = await call(
      similarity({ structure: 'CCO', query: 'imatinib', max_phase_min: 4, limit: 150 }),
    );
    const notice =
      'limit 150 is above the maximum of 100, so 100 was applied. query was ignored: search_type=similarity searches by structure only. No compound matched similarity structure "CCO" with max_phase_min=4. Retry without max_phase_min first: it keeps only compounds whose recorded max clinical phase is at least 4, and one with no recorded phase never passes. Otherwise check the SMILES or lower the similarity threshold.';
    expect(structured.notice).toBe(notice);
    expect(lines).toContain(`> ${notice}`);
  });

  it('carries the ignored input beside the continuation on a capped page', async () => {
    stubStructureUpstream({ corpus: IMATINIB_ANALOGS });
    const { structured } = await call(similarity({ query: 'imatinib', limit: 10 }));
    expect(structured).toMatchObject({
      truncated: true,
      notice:
        'query was ignored: search_type=similarity searches by structure only. Showing 10 of 90; pass nextCursor back as cursor for the next page.',
    });
  });

  it('describes max_phase_min for every search_type', () => {
    const describe = chemblSearchMolecules.input.shape.max_phase_min.description ?? '';
    expect(describe).not.toContain('search_type=name');
  });

  /**
   * similarity_threshold is read only by search_type=similarity. The schema fills
   * its default (70), so only a value other than 70 shows the caller set it — that
   * one is named in the same joined notice as an ignored query or structure.
   */
  const THRESHOLD_IGNORED =
    'similarity_threshold was ignored: only search_type=similarity applies a Tanimoto threshold.';

  it('names a similarity_threshold sent with a substructure search as ignored', async () => {
    const requests = stubStructureUpstream({ corpus: IMATINIB_ANALOGS.slice(0, 68) });
    const { structured, lines } = await call({
      search_type: 'substructure',
      structure: IMATINIB_SMILES,
      similarity_threshold: 50,
      limit: 100,
    });
    expect(structured).toMatchObject({
      totalCount: 68,
      truncated: false,
      notice: THRESHOLD_IGNORED,
    });
    expect(lines).toContain(`> ${THRESHOLD_IGNORED}`);
    expect(requests[0]?.pathname).not.toContain('/50');
  });

  it('names a similarity_threshold sent with a name search as ignored', async () => {
    stubMoleculeCorpus(5);
    const { structured, lines } = await call({ query: 'imatinib', similarity_threshold: 80 });
    expect(structured).toMatchObject({ totalCount: 5, notice: THRESHOLD_IGNORED });
    expect(lines).toContain(`> ${THRESHOLD_IGNORED}`);
  });

  it('names a structure and a similarity_threshold sent with a name search in one notice', async () => {
    stubMoleculeCorpus(5);
    const { structured, lines } = await call({
      query: 'imatinib',
      structure: 'CCO',
      similarity_threshold: 85,
    });
    const notice = `structure was ignored: search_type=name searches by query only; set search_type to exact, similarity, or substructure to search by structure. ${THRESHOLD_IGNORED}`;
    expect(structured).toMatchObject({ totalCount: 5, notice });
    expect(lines).toContain(`> ${notice}`);
  });

  it('carries a query and a similarity_threshold beside the continuation on a capped page', async () => {
    stubStructureUpstream({ corpus: IMATINIB_ANALOGS.slice(0, 68) });
    const { structured } = await call({
      search_type: 'substructure',
      structure: IMATINIB_SMILES,
      query: 'imatinib',
      similarity_threshold: 50,
      limit: 10,
    });
    expect(structured).toMatchObject({
      truncated: true,
      notice: `query was ignored: search_type=substructure searches by structure only. ${THRESHOLD_IGNORED} Showing 10 of 68; pass nextCursor back as cursor for the next page.`,
    });
  });

  it.each([
    [
      'the default 70 on a substructure search',
      { search_type: 'substructure', structure: IMATINIB_SMILES, similarity_threshold: 70 },
    ],
    ['an omitted threshold on a name search', { query: 'imatinib' }],
    ['a threshold the similarity search reads', similarity({ similarity_threshold: 50 })],
  ])('says nothing about similarity_threshold for %s', async (_label, input) => {
    stubStructureUpstream({ corpus: IMATINIB_ANALOGS.slice(0, 68) });
    const { structured } = await call({ limit: 100, ...input });
    expect(structured).not.toHaveProperty('notice');
  });

  it('describes similarity_threshold as named in the notice when another search_type ignores it', () => {
    const describe = chemblSearchMolecules.input.shape.similarity_threshold.description ?? '';
    expect(describe).toContain('other than the default 70');
    expect(describe).toContain('notice');
  });
});

/**
 * ChEMBL keeps max_phase 4 on a drug withdrawn from a market, so 4 says the drug
 * reached approval, not that it is sold today. chembl_get_drug_info carries the
 * withdrawal record; the phase descriptions point there by its field names.
 */
describe('chembl_search_molecules — max_phase 4 and withdrawal', () => {
  const maxPhase =
    chemblSearchMolecules.output.shape.molecules.element.shape.max_phase.description ?? '';

  it('describes max_phase 4 as reaching approval, pointing at chembl_get_drug_info for withdrawal', () => {
    expect(maxPhase).toContain('4 = reached approval');
    expect(maxPhase).toContain('not that it is on the market now');
    expect(maxPhase).toContain("chembl_get_drug_info's withdrawn and warnings");
  });

  it('names fields chembl_get_drug_info really returns', () => {
    expect(Object.keys(chemblGetDrugInfo.output.shape)).toEqual(
      expect.arrayContaining(['withdrawn', 'warnings']),
    );
  });

  it('never calls max_phase_min 4 a filter for marketed drugs', () => {
    const describe = chemblSearchMolecules.input.shape.max_phase_min.description ?? '';
    expect(describe).not.toMatch(/marketed/i);
    expect(describe).toContain('reached approval');
    expect(chemblSearchMolecules.description).not.toMatch(/marketed|4 = approved/i);
  });
});

/**
 * The exact structure route ignores `offset` upstream, so the one hit is windowed
 * locally the way the exact-identifier route windows its record: on the first
 * page, and nothing past it.
 */
describe('chembl_search_molecules — exact structure search and the cursor offset (#50)', () => {
  it('returns the exact hit on the first page', async () => {
    stubStructureUpstream({ exact: { id: 'CHEMBL941', phase: 4 } });
    const c = ctx();
    const result = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({ search_type: 'exact', structure: IMATINIB_SMILES }),
      c,
    );
    expect(idsOf(result.molecules)).toEqual(['CHEMBL941']);
    expect(result).not.toHaveProperty('nextCursor');
  });

  it('reports a cursor past the exact hit as an exhausted walk', async () => {
    stubStructureUpstream({ exact: { id: 'CHEMBL941', phase: 4 } });
    const c = ctx();
    const result = await chemblSearchMolecules.handler(
      chemblSearchMolecules.input.parse({
        search_type: 'exact',
        structure: IMATINIB_SMILES,
        limit: 3,
        cursor: encodeCursor({ offset: 3, limit: 3 }),
      }),
      c,
    );
    expect(result.molecules).toEqual([]);
    expect(result).not.toHaveProperty('nextCursor');
    expect(getEnrichment(c)).toMatchObject({
      totalCount: 1,
      notice: `That cursor starts past the end of the 1 compounds matching exact structure "${IMATINIB_SMILES}" — the walk is complete.`,
    });
  });
});

describe('chembl_search_molecules — parent_chembl_id (#37)', () => {
  it('names each row’s parent on structuredContent and content[]', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          molecules: [
            {
              molecule_chembl_id: 'CHEMBL1079742',
              pref_name: 'ERLOTINIB HYDROCHLORIDE',
              molecule_hierarchy: {
                active_chembl_id: 'CHEMBL553',
                molecule_chembl_id: 'CHEMBL1079742',
                parent_chembl_id: 'CHEMBL553',
              },
            },
            {
              molecule_chembl_id: 'CHEMBL1201352',
              pref_name: 'RAPACURONIUM',
              molecule_hierarchy: null,
            },
          ],
          page_meta: { total_count: 2 },
        }),
      ),
    );
    const result = await runToolContract(
      chemblSearchMolecules,
      { query: 'erlotinib' },
      { context: { tenantId: 'default' } },
    );
    expect(result.isError).toBeFalsy();
    const structured = chemblSearchMolecules.output.parse(result.structuredContent);
    expect(structured.molecules.map((m) => [m.molecule_chembl_id, m.parent_chembl_id])).toEqual([
      ['CHEMBL1079742', 'CHEMBL553'],
      ['CHEMBL1201352', 'CHEMBL1201352'],
    ]);
    const lines = result.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .split('\n');
    expect(lines).toContain('Formula: — | Type: — | Parent: CHEMBL553');
    expect(lines).toContain('Formula: — | Type: — | Parent: CHEMBL1201352');
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
          parent_chembl_id: 'CHEMBL999',
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
          parent_chembl_id: 'CHEMBL25',
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
          parent_chembl_id: 'CHEMBL25',
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
          parent_chembl_id: 'CHEMBL25',
        },
      ],
    });
    const text = blocks.map((b) => (b as { text: string }).text).join('\n');
    expect(text.toLowerCase()).not.toContain('cursor');
  });

  /** One molecule row with the structure fields under test and markup-free properties. */
  const structureRow = (canonical_smiles: string | null, standard_inchi_key: string | null) => ({
    molecule_chembl_id: 'CHEMBL25',
    pref_name: 'ASPIRIN',
    canonical_smiles,
    standard_inchi_key,
    full_molformula: 'C9H8O4',
    mw_freebase: 180.16,
    alogp: 1.31,
    num_ro5_violations: 0,
    qed_weighted: 0.55,
    max_phase: 4,
    molecule_type: 'Small molecule',
    parent_chembl_id: 'CHEMBL25',
    similarity: 87.5,
  });

  const formatText = (molecules: ReturnType<typeof structureRow>[]) =>
    (chemblSearchMolecules.format!({ molecules })[0] as { text: string }).text;

  /**
   * #40: SMILES syntax is Markdown syntax — `[atom](branch)` is a link and `\[`
   * an escaped bracket — so a structure renders as a code span whose literal is
   * the field byte for byte. The backtick case needs a two-backtick fence.
   */
  it.each([
    'C[C@H](N)C(=O)O',
    'CC(C)C[C@H](NC(=O)[C@H](Cc1ccccc1)NC(=O)c1cnccn1)B(O)O',
    String.raw`CN(C)/C=C\[N+](=O)[O-]`,
    '*CC(*)C*',
    'C<br>C',
    'C|C|C',
    'C_C_C',
    String.raw`C\\C`,
    'C`C',
  ])('renders SMILES %s as one code span that reads back exactly', (smiles) => {
    const text = formatText([structureRow(smiles, 'QNAYBMKLOCPYGJ-REOHCLBHSA-N')]);
    const smilesLine = text.split('\n').find((line) => line.startsWith('SMILES: ')) ?? '';
    expect(codeSpans(smilesLine)).toEqual([smiles, 'QNAYBMKLOCPYGJ-REOHCLBHSA-N']);
    const { text: shown, nodes } = parseMarkdown(smilesLine);
    expect(shown).toBe(`SMILES: ${smiles} | InChIKey: QNAYBMKLOCPYGJ-REOHCLBHSA-N`);
    expect(markupNodes(nodes)).toEqual([]);
  });

  it('fences a SMILES that holds a backtick with two backticks', () => {
    const text = formatText([structureRow('C`C', 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N')]);
    expect(text.split('\n')).toContain('SMILES: ``C`C`` | InChIKey: `BSYNRYMUTXBXSQ-UHFFFAOYSA-N`');
  });

  it('renders a null SMILES or InChIKey as —, never an empty span', () => {
    expect(formatText([structureRow(null, null)]).split('\n')).toContain('SMILES: — | InChIKey: —');
    expect(formatText([structureRow('CCO', null)]).split('\n')).toContain(
      'SMILES: `CCO` | InChIKey: —',
    );
    expect(formatText([structureRow(null, 'LFQSCWFLJHTTHZ-UHFFFAOYSA-N')]).split('\n')).toContain(
      'SMILES: — | InChIKey: `LFQSCWFLJHTTHZ-UHFFFAOYSA-N`',
    );
  });

  it('renders the name, property, formula, structure, similarity, and continuation lines whole', () => {
    const blocks = chemblSearchMolecules.format!({
      molecules: [structureRow('CC(=O)Oc1ccccc1C(=O)O', 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N')],
      nextCursor: 'OPAQUE',
    });
    expect((blocks[0] as { text: string }).text.split('\n')).toEqual([
      '**CHEMBL25** — ASPIRIN',
      'phase 4 | MW: 180.16 | AlogP: 1.31 | RO5 violations: 0 | QED: 0.55',
      'Formula: C9H8O4 | Type: Small molecule | Parent: CHEMBL25',
      'SMILES: `CC(=O)Oc1ccccc1C(=O)O` | InChIKey: `BSYNRYMUTXBXSQ-UHFFFAOYSA-N`',
      'Similarity: 87.5%',
      '',
      'More compounds remain — re-call with cursor="OPAQUE" and the same filters for the next page.',
    ]);
  });

  /** #44: names and other upstream strings render inert around the server's own markup. */
  it('renders upstream names, formula, type, and IDs as the text recorded', () => {
    const row = {
      ...structureRow(null, null),
      molecule_chembl_id: 'CHEMBL_X*',
      pref_name: '[125I](R)-DOI *tagged*',
      full_molformula: 'C9H8O4.<br>',
      molecule_type: '_Small_ molecule',
      parent_chembl_id: '# P\n- Q',
    };
    const { text, nodes } = parseMarkdown(formatText([row]));
    expect(text).toBe(
      [
        'CHEMBL_X* — [125I](R)-DOI *tagged*',
        'phase 4 | MW: 180.16 | AlogP: 1.31 | RO5 violations: 0 | QED: 0.55',
        'Formula: C9H8O4.<br> | Type: _Small_ molecule | Parent: # P\n- Q',
        'SMILES: — | InChIKey: —',
        'Similarity: 87.5%',
      ].join('\n'),
    );
    expect(markupNodes(nodes)).toEqual([]);
  });
});
