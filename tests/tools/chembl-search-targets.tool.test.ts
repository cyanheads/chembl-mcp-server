/**
 * @fileoverview Behavior tests for chembl_search_targets beyond the input gate:
 * the happy path through a stubbed upstream, the empty-result notice that echoes
 * the filters, truncation enrichment, and the pure format() rendering components
 * and gene symbols (with — fallbacks).
 * @module tests/tools/chembl-search-targets.tool
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { decodeCursor, encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblSearchTargets } from '@/mcp-server/tools/definitions/chembl-search-targets.tool.js';
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

const ctx = () => createMockContext({ tenantId: 'default', errors: chemblSearchTargets.errors });

const egfrRaw = {
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
};

describe('chembl_search_targets — resolution', () => {
  it('returns a flattened target for an accession lookup', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ targets: [egfrRaw], page_meta: { total_count: 1 } }),
    );
    const c = ctx();
    const result = await chemblSearchTargets.handler(
      chemblSearchTargets.input.parse({ accession: 'P00533' }),
      c,
    );
    expect(result.targets[0]).toMatchObject({
      target_chembl_id: 'CHEMBL203',
      target_type: 'SINGLE PROTEIN',
    });
    expect(result.targets[0]?.components[0]?.gene_symbols).toEqual(['EGFR']);
    expect(getEnrichment(c)).toMatchObject({ totalCount: 1, truncated: false });
  });

  it('emits a notice echoing the filters when no target matched', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ targets: [], page_meta: { total_count: 0 } }));
    const c = ctx();
    const result = await chemblSearchTargets.handler(
      chemblSearchTargets.input.parse({ accession: 'P99999', gene_symbol: 'ZZZ9' }),
      c,
    );
    expect(result.targets).toEqual([]);
    const enrichment = getEnrichment(c) as { notice?: string };
    expect(enrichment.notice).toContain('P99999');
    expect(enrichment.notice).toContain('ZZZ9');
  });

  it('flags truncation at the limit boundary', async () => {
    const targets = Array.from({ length: 3 }, (_, i) => ({
      ...egfrRaw,
      target_chembl_id: `CHEMBL${i}`,
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ targets, page_meta: { total_count: 40 } }));
    const c = ctx();
    await chemblSearchTargets.handler(
      chemblSearchTargets.input.parse({ query: 'kinase', limit: 3 }),
      c,
    );
    expect(getEnrichment(c)).toMatchObject({ truncated: true, shown: 3, cap: 3 });
  });
});

/**
 * A fake ChEMBL that honors `offset`/`limit` over a synthetic corpus, so a cursor
 * walk is checked against real row identity instead of a scripted page sequence.
 * Builds a fresh Response per call — a Response body reads only once.
 */
function stubTargetCorpus(total: number): void {
  fetchMock.mockImplementation((url: string | URL) => {
    const params = new URL(String(url)).searchParams;
    const offset = Number(params.get('offset') ?? 0);
    const limit = Number(params.get('limit') ?? 25);
    const targets = corpusIds(total)
      .slice(offset, offset + limit)
      .map((target_chembl_id) => ({ ...egfrRaw, target_chembl_id }));
    return Promise.resolve(jsonResponse({ targets, page_meta: { total_count: total } }));
  });
}

const corpusIds = (total: number) => Array.from({ length: total }, (_, i) => `CHEMBL${i}`);
const idsOf = (targets: { target_chembl_id: string }[]) => targets.map((t) => t.target_chembl_id);

describe('chembl_search_targets — cursor pagination', () => {
  it('returns a nextCursor whenever more matches remain', async () => {
    stubTargetCorpus(873);
    const result = await chemblSearchTargets.handler(
      chemblSearchTargets.input.parse({ query: 'kinase', organism: 'Homo sapiens', limit: 3 }),
      ctx(),
    );
    expect(idsOf(result.targets)).toEqual(['CHEMBL0', 'CHEMBL1', 'CHEMBL2']);
    expect(decodeCursor(result.nextCursor as string, createMockContext({}))).toMatchObject({
      offset: 3,
    });
  });

  it('redeems a cursor into a disjoint, contiguous next page', async () => {
    stubTargetCorpus(873);
    const first = await chemblSearchTargets.handler(
      chemblSearchTargets.input.parse({ query: 'kinase', limit: 3 }),
      ctx(),
    );
    const second = await chemblSearchTargets.handler(
      chemblSearchTargets.input.parse({
        query: 'kinase',
        limit: 3,
        cursor: first.nextCursor as string,
      }),
      ctx(),
    );
    const firstIds = idsOf(first.targets);
    const secondIds = idsOf(second.targets);
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    expect([...firstIds, ...secondIds]).toEqual(corpusIds(6));
    // Nested components are flattened on a paged row exactly as on the first page.
    expect(second.targets[0]?.components[0]).toMatchObject({
      accession: 'P00533',
      gene_symbols: ['EGFR'],
    });
  });

  it('walks the whole result set and omits nextCursor on the last page', async () => {
    stubTargetCorpus(7);
    const walked: string[] = [];
    const pageSizes: number[] = [];
    let cursor: string | undefined;
    // Bounded so a cursor that fails to advance fails the test instead of hanging.
    for (let page = 0; page < 10; page++) {
      const result = await chemblSearchTargets.handler(
        chemblSearchTargets.input.parse({ query: 'kinase', limit: 3, ...(cursor && { cursor }) }),
        ctx(),
      );
      pageSizes.push(result.targets.length);
      walked.push(...idsOf(result.targets));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeUndefined();
    expect(pageSizes).toEqual([3, 3, 1]);
    expect(walked).toEqual(corpusIds(7));
    expect(new Set(walked).size).toBe(7);
  });

  it('omits nextCursor when the first page already holds every match', async () => {
    stubTargetCorpus(2);
    const result = await chemblSearchTargets.handler(
      chemblSearchTargets.input.parse({ query: 'kinase', limit: 25 }),
      ctx(),
    );
    expect(result.targets).toHaveLength(2);
    expect(result).not.toHaveProperty('nextCursor');
  });

  it('stops flagging truncation on a full last page, matching the absent cursor', async () => {
    stubTargetCorpus(6);
    const mid = ctx();
    await chemblSearchTargets.handler(
      chemblSearchTargets.input.parse({ query: 'kinase', limit: 3 }),
      mid,
    );
    expect(getEnrichment(mid)).toMatchObject({ truncated: true, shown: 3, cap: 3 });

    // Same page size, exactly fills the last page — the cap withholds nothing now.
    const last = ctx();
    const result = await chemblSearchTargets.handler(
      chemblSearchTargets.input.parse({
        query: 'kinase',
        limit: 3,
        cursor: encodeCursor({ offset: 3, limit: 3 }),
      }),
      last,
    );
    expect(result.targets).toHaveLength(3);
    expect(result).not.toHaveProperty('nextCursor');
    expect(getEnrichment(last)).toMatchObject({ truncated: false, shown: 3, cap: 3 });
  });

  it('reports an exhausted walk instead of a bad accession past the end', async () => {
    stubTargetCorpus(7);
    const c = ctx();
    const result = await chemblSearchTargets.handler(
      chemblSearchTargets.input.parse({
        query: 'kinase',
        limit: 3,
        cursor: encodeCursor({ offset: 900, limit: 3 }),
      }),
      c,
    );
    expect(result.targets).toEqual([]);
    expect(result).not.toHaveProperty('nextCursor');
    const enrichment = getEnrichment(c) as { notice?: string; totalCount?: number };
    expect(enrichment.totalCount).toBe(7);
    expect(enrichment.notice).toContain('7');
    expect(enrichment.notice).not.toContain('Verify');
  });

  it('rejects a malformed cursor with InvalidParams, unwrapped by a declared reason', async () => {
    // `handler` is typed to allow a sync return, so normalize before catching.
    const err: unknown = await Promise.resolve(
      chemblSearchTargets.handler(
        chemblSearchTargets.input.parse({ query: 'kinase', cursor: '!!not-a-cursor!!' }),
        ctx(),
      ),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect((err as McpError).data).not.toHaveProperty('reason');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a tampered cursor before anything reaches ChEMBL', async () => {
    const tampered = Buffer.from(JSON.stringify({ offset: 5, limit: 0 })).toString('base64url');
    await expect(
      chemblSearchTargets.handler(
        chemblSearchTargets.input.parse({ query: 'kinase', cursor: tampered }),
        ctx(),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the missing-input gate ahead of cursor decoding', async () => {
    // A cursor is a resume position, not a query — it must not satisfy the gate.
    await expect(
      chemblSearchTargets.handler(
        chemblSearchTargets.input.parse({ cursor: encodeCursor({ offset: 3, limit: 3 }) }),
        ctx(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'missing_input' } });
  });
});

describe('chembl_search_targets format()', () => {
  it('renders target id, type, organism, and per-component gene symbols', () => {
    const blocks = chemblSearchTargets.format!({
      targets: [
        {
          target_chembl_id: 'CHEMBL203',
          pref_name: 'Epidermal growth factor receptor',
          target_type: 'SINGLE PROTEIN',
          organism: 'Homo sapiens',
          components: [{ accession: 'P00533', gene_symbols: ['EGFR', 'ERBB1'] }],
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**CHEMBL203**');
    expect(text).toContain('Type: SINGLE PROTEIN');
    expect(text).toContain('accession P00533');
    expect(text).toContain('genes: EGFR, ERBB1');
  });

  it('renders — for a component with no gene symbols and a null accession', () => {
    const blocks = chemblSearchTargets.format!({
      targets: [
        {
          target_chembl_id: 'CHEMBL999',
          pref_name: null,
          target_type: null,
          organism: null,
          components: [{ accession: null, gene_symbols: [] }],
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('(unnamed)');
    expect(text).toContain('accession —');
    expect(text).toContain('genes: —');
  });

  it('renders the empty marker for no targets', () => {
    const blocks = chemblSearchTargets.format!({ targets: [] });
    expect((blocks[0] as { text: string }).text).toContain('No matching targets');
  });

  it('discloses the continuation to a content-only client when a cursor is present', () => {
    const blocks = chemblSearchTargets.format!({
      targets: [
        {
          target_chembl_id: 'CHEMBL203',
          pref_name: 'Epidermal growth factor receptor',
          target_type: 'SINGLE PROTEIN',
          organism: 'Homo sapiens',
          components: [{ accession: 'P00533', gene_symbols: ['EGFR'] }],
        },
      ],
      nextCursor: 'OPAQUE-CURSOR-TOKEN',
    });
    const text = blocks.map((b) => (b as { text: string }).text).join('\n');
    expect(text).toContain('OPAQUE-CURSOR-TOKEN');
    expect(text.toLowerCase()).toContain('cursor');
  });

  it('says nothing about continuing when the page is the last one', () => {
    const blocks = chemblSearchTargets.format!({
      targets: [
        {
          target_chembl_id: 'CHEMBL203',
          pref_name: 'Epidermal growth factor receptor',
          target_type: 'SINGLE PROTEIN',
          organism: 'Homo sapiens',
          components: [{ accession: 'P00533', gene_symbols: ['EGFR'] }],
        },
      ],
    });
    const text = blocks.map((b) => (b as { text: string }).text).join('\n');
    expect(text.toLowerCase()).not.toContain('cursor');
  });
});
