/**
 * @fileoverview Behavior tests for chembl_search_targets beyond the input gate:
 * the happy path through a stubbed upstream, the empty-result notice that echoes
 * the filters, truncation enrichment, input normalization (#41: uppercased codes,
 * the limit clamp), cursor pagination, and the pure format() rendering components
 * and gene symbols (with — fallbacks) and upstream text as recorded (#44).
 * @module tests/tools/chembl-search-targets.tool
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { decodeCursor, encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblSearchTargets } from '@/mcp-server/tools/definitions/chembl-search-targets.tool.js';
import { initChemblService } from '@/services/chembl/chembl-service.js';
import { markupNodes, parseMarkdown } from '../_commonmark.js';

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

describe('chembl_search_targets — input normalization (#41)', () => {
  const sentParams = () => new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams;
  const stubPage = (total: number, count = total) =>
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          targets: Array.from({ length: count }, (_, i) => ({
            ...egfrRaw,
            target_chembl_id: `CHEMBL${i}`,
          })),
          page_meta: { total_count: total },
        }),
      ),
    );

  it('sends accession and target_type uppercased and trimmed, the form every ChEMBL record holds', async () => {
    stubPage(1);
    const c = ctx();
    await chemblSearchTargets.handler(
      chemblSearchTargets.input.parse({ accession: ' p00533 ', target_type: 'single protein' }),
      c,
    );
    expect(sentParams().get('target_components__accession')).toBe('P00533');
    expect(sentParams().get('target_type')).toBe('SINGLE PROTEIN');
  });

  it('echoes the canonical accession in the zero-hit notice', async () => {
    stubPage(0);
    const c = ctx();
    await chemblSearchTargets.handler(chemblSearchTargets.input.parse({ accession: 'p99999' }), c);
    expect(getEnrichment(c)).toMatchObject({
      notice: 'No target matched accession="P99999". Verify the accession.',
    });
  });

  it('leaves gene_symbol, organism, and query as sent — those match case-insensitively upstream', async () => {
    stubPage(1);
    await chemblSearchTargets.handler(
      chemblSearchTargets.input.parse({
        gene_symbol: 'egfr',
        organism: 'homo sapiens',
        query: 'Kinase',
      }),
      ctx(),
    );
    expect(
      sentParams().get('target_components__target_component_synonyms__component_synonym__iexact'),
    ).toBe('egfr');
    expect(sentParams().get('organism__iexact')).toBe('homo sapiens');
    expect(sentParams().get('pref_name__icontains')).toBe('Kinase');
  });

  it('reads a blank target_type as unset', async () => {
    stubPage(1);
    await chemblSearchTargets.handler(
      chemblSearchTargets.input.parse({ accession: 'P00533', target_type: '  ' }),
      ctx(),
    );
    expect(sentParams().has('target_type')).toBe(false);
  });

  it('clamps a limit above 100 to 100 with a notice, cap reporting the applied value', async () => {
    stubPage(250, 100);
    const c = ctx();
    const result = await chemblSearchTargets.handler(
      chemblSearchTargets.input.parse({ query: 'kinase', limit: 500 }),
      c,
    );
    expect(sentParams().get('limit')).toBe('100');
    expect(result.targets).toHaveLength(100);
    expect(getEnrichment(c)).toMatchObject({
      truncated: true,
      shown: 100,
      cap: 100,
      notice:
        'limit 500 is above the maximum of 100, so 100 was applied. Showing 100 of 250; pass nextCursor back as cursor for the next page.',
    });
    expect(result.nextCursor && decodeCursor(result.nextCursor, c)).toMatchObject({
      offset: 100,
      limit: 100,
    });
  });

  it('discloses the clamp beside the zero-hit notice', async () => {
    stubPage(0);
    const c = ctx();
    await chemblSearchTargets.handler(
      chemblSearchTargets.input.parse({ accession: 'P99999', limit: 101 }),
      c,
    );
    expect(getEnrichment(c)).toMatchObject({
      truncated: false,
      cap: 100,
      notice:
        'limit 101 is above the maximum of 100, so 100 was applied. No target matched accession="P99999". Verify the accession.',
    });
  });

  it('rejects a limit above the 10000 ceiling at the schema', () => {
    expect(chemblSearchTargets.input.safeParse({ query: 'kinase', limit: 10_001 }).success).toBe(
      false,
    );
  });
});

/** A target row of the fake `/target.json` corpus. */
const target = (
  id: string,
  pref_name: string,
  target_type: string,
  organism: string,
  components: [accession: string, gene: string][],
) => ({
  target_chembl_id: id,
  pref_name,
  target_type,
  organism,
  target_components: components.map(([accession, gene]) => ({
    accession,
    target_component_synonyms: [{ component_synonym: gene, syn_type: 'GENE_SYMBOL' }],
  })),
});

const TARGETS = [
  target('CHEMBL203', 'Epidermal growth factor receptor', 'SINGLE PROTEIN', 'Homo sapiens', [
    ['P00533', 'EGFR'],
  ]),
  target(
    'CHEMBL2363049',
    'Epidermal growth factor receptor and ErbB2',
    'PROTEIN COMPLEX',
    'Homo sapiens',
    [
      ['P00533', 'EGFR'],
      ['P04626', 'ERBB2'],
    ],
  ),
  target('CHEMBL3608', 'Epidermal growth factor receptor', 'SINGLE PROTEIN', 'Mus musculus', [
    ['Q01279', 'Egfr'],
  ]),
  target('CHEMBL1862', 'Tyrosine-protein kinase ABL', 'SINGLE PROTEIN', 'Homo sapiens', [
    ['P00519', 'ABL1'],
  ]),
];

/**
 * A fake ChEMBL `/target.json` over {@link TARGETS}, applying each filter the way
 * ChEMBL does: `target_chembl_id`, `target_type`, and the accession exactly and
 * case-sensitively, `pref_name__icontains` as a case-insensitive substring, and
 * the gene symbol and organism case-insensitively exact. Every request URL lands
 * in the returned list.
 */
function stubTargetUpstream(): URL[] {
  const requests: URL[] = [];
  fetchMock.mockImplementation((input: string | URL) => {
    const url = new URL(String(input));
    requests.push(url);
    const p = url.searchParams;
    const lower = (v: string | null) => v?.toLowerCase();
    const gene = p.get('target_components__target_component_synonyms__component_synonym__iexact');
    const matches = TARGETS.filter(
      (t) =>
        (!p.has('target_chembl_id') || t.target_chembl_id === p.get('target_chembl_id')) &&
        (!p.has('pref_name__icontains') ||
          t.pref_name.toLowerCase().includes(lower(p.get('pref_name__icontains')) ?? '')) &&
        (!p.has('target_components__accession') ||
          t.target_components.some((c) => c.accession === p.get('target_components__accession'))) &&
        (gene === null ||
          t.target_components.some((c) =>
            c.target_component_synonyms.some(
              (s) => s.component_synonym.toLowerCase() === lower(gene),
            ),
          )) &&
        (!p.has('organism__iexact') ||
          t.organism.toLowerCase() === lower(p.get('organism__iexact'))) &&
        (!p.has('target_type') || t.target_type === p.get('target_type')),
    );
    const offset = Number(p.get('offset') ?? 0);
    const limit = Number(p.get('limit') ?? 25);
    return Promise.resolve(
      jsonResponse({
        targets: matches.slice(offset, offset + limit),
        page_meta: { total_count: matches.length },
      }),
    );
  });
  return requests;
}

/**
 * A ChEMBL target ID sent as `query` reads that target through the
 * `target_chembl_id` filter on the same list route (#48), and a zero-hit or
 * past-the-end notice names every filter the call sent.
 */
describe('chembl_search_targets — a target ID as query, and the zero-hit notice (#48)', () => {
  /** Run through the full contract; hand back structuredContent and the content[] lines. */
  async function call(input: Record<string, unknown>) {
    const result = await runToolContract(chemblSearchTargets, input, {
      context: { tenantId: 'default' },
    });
    expect(result.isError).toBeFalsy();
    const lines = result.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .split('\n');
    return {
      structured: result.structuredContent as Record<string, unknown> & {
        targets: { target_chembl_id: string }[];
      },
      lines,
    };
  }

  it.each(['CHEMBL203', ' chembl203 '])(
    'reads the query %j as the target ID through target_chembl_id',
    async (query) => {
      const requests = stubTargetUpstream();
      const { structured, lines } = await call({ query });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.pathname).toBe('/chembl/api/data/target.json');
      expect(requests[0]?.searchParams.get('target_chembl_id')).toBe('CHEMBL203');
      expect(requests[0]?.searchParams.has('pref_name__icontains')).toBe(false);
      expect(idsOf(structured.targets)).toEqual(['CHEMBL203']);
      expect(structured).toMatchObject({ totalCount: 1 });
      expect(structured).not.toHaveProperty('notice');
      expect(lines).toContain('**CHEMBL203** — Epidermal growth factor receptor');
    },
  );

  it('ANDs a target ID with target_type upstream, naming both filters when they exclude it', async () => {
    const requests = stubTargetUpstream();
    const { structured, lines } = await call({
      query: 'CHEMBL203',
      target_type: 'PROTEIN COMPLEX',
    });
    const notice =
      'No target matched query="CHEMBL203" (a ChEMBL target ID), target_type="PROTEIN COMPLEX". Retry without target_type first: it matches one full target class exactly, e.g. "SINGLE PROTEIN". Otherwise verify the target ID.';
    expect(requests[0]?.searchParams.get('target_type')).toBe('PROTEIN COMPLEX');
    expect(structured.targets).toEqual([]);
    expect(structured).toMatchObject({ totalCount: 0, notice });
    expect(lines).toContain(`> ${notice}`);

    const kept = await call({ query: 'CHEMBL203', target_type: 'single protein' });
    expect(idsOf(kept.structured.targets)).toEqual(['CHEMBL203']);
  });

  it('answers an ID no target carries with an empty page and a notice, not an error', async () => {
    stubTargetUpstream();
    const { structured } = await call({ query: 'CHEMBL999999991' });
    expect(structured.targets).toEqual([]);
    expect(structured.notice).toBe(
      'No target matched query="CHEMBL999999991" (a ChEMBL target ID). Verify the target ID.',
    );
  });

  it.each(['kinase', 'CHEMBL', 'CHEMBL203 kinase', 'chembl-203'])(
    'keeps the query %j on the preferred-name match',
    async (query) => {
      const requests = stubTargetUpstream();
      await call({ query });
      expect(requests[0]?.searchParams.get('pref_name__icontains')).toBe(query);
      expect(requests[0]?.searchParams.has('target_chembl_id')).toBe(false);
    },
  );

  it('steers a common-name organism to the scientific name ChEMBL records', async () => {
    stubTargetUpstream();
    const { structured, lines } = await call({ gene_symbol: 'EGFR', organism: 'human' });
    const notice =
      'No target matched gene_symbol="EGFR", organism="human". Retry without organism first: it matches the scientific name ChEMBL records, e.g. "Homo sapiens", not a common name. Otherwise verify the gene symbol.';
    expect(structured).toMatchObject({ totalCount: 0, notice });
    expect(lines).toContain(`> ${notice}`);
    const fixed = await call({ gene_symbol: 'EGFR', organism: 'homo sapiens' });
    expect(idsOf(fixed.structured.targets)).toEqual(['CHEMBL203', 'CHEMBL2363049']);
  });

  it('steers a partial target_type to the full class ChEMBL records', async () => {
    stubTargetUpstream();
    const { structured } = await call({ accession: 'P00533', target_type: 'protein' });
    expect(structured.notice).toBe(
      'No target matched accession="P00533", target_type="PROTEIN". Retry without target_type first: it matches one full target class exactly, e.g. "SINGLE PROTEIN". Otherwise verify the accession.',
    );
  });

  it('names both narrowing filters when both were sent', async () => {
    stubTargetUpstream();
    const { structured } = await call({
      gene_symbol: 'EGFR',
      organism: 'human',
      target_type: 'protein',
    });
    expect(structured.notice).toBe(
      'No target matched gene_symbol="EGFR", organism="human", target_type="PROTEIN". Retry without organism and target_type first: organism matches the scientific name ChEMBL records, e.g. "Homo sapiens", not a common name, and target_type matches one full target class exactly, e.g. "SINGLE PROTEIN". Otherwise verify the gene symbol.',
    );
  });

  it('never asks a name-only search to verify an identifier it did not send', async () => {
    stubTargetUpstream();
    const { structured } = await call({ query: 'kinase', organism: 'human' });
    expect(structured.notice).toBe(
      'No target matched query="kinase", organism="human". Retry without organism first: it matches the scientific name ChEMBL records, e.g. "Homo sapiens", not a common name. Otherwise check the spelling or broaden the name query.',
    );
    expect(structured.notice).not.toMatch(/accession|gene/);
  });

  it.each([
    [
      { query: 'zzz' },
      'No target matched query="zzz". Check the spelling or broaden the name query.',
    ],
    [{ gene_symbol: 'ZZZ9' }, 'No target matched gene_symbol="ZZZ9". Verify the gene symbol.'],
    [
      { accession: 'P99999', gene_symbol: 'ZZZ9' },
      'No target matched accession="P99999", gene_symbol="ZZZ9". Verify the accession and the gene symbol.',
    ],
    [
      { accession: 'P99999', query: 'zzz' },
      'No target matched accession="P99999", query="zzz". Verify the accession, or check the spelling or broaden the name query.',
    ],
  ])('advises on exactly the identifiers sent: %j', async (input, notice) => {
    stubTargetUpstream();
    const { structured } = await call(input);
    expect(structured.notice).toBe(notice);
  });

  it('names every filter in the past-the-end notice', async () => {
    stubTargetUpstream();
    const { structured } = await call({
      gene_symbol: 'EGFR',
      organism: 'Homo sapiens',
      target_type: 'single protein',
      limit: 3,
      cursor: encodeCursor({ offset: 900, limit: 3 }),
    });
    expect(structured.targets).toEqual([]);
    expect(structured.notice).toBe(
      'That cursor starts past the end of the 1 targets matching gene_symbol="EGFR", organism="Homo sapiens", target_type="SINGLE PROTEIN" — the walk is complete.',
    );
  });

  it('leads with the clamp disclosure before the zero-hit diagnosis', async () => {
    stubTargetUpstream();
    const { structured, lines } = await call({
      gene_symbol: 'EGFR',
      organism: 'human',
      limit: 150,
    });
    const notice =
      'limit 150 is above the maximum of 100, so 100 was applied. No target matched gene_symbol="EGFR", organism="human". Retry without organism first: it matches the scientific name ChEMBL records, e.g. "Homo sapiens", not a common name. Otherwise verify the gene symbol.';
    expect(structured).toMatchObject({ cap: 100, notice });
    expect(lines).toContain(`> ${notice}`);
  });

  it('describes the target-ID query and the forms organism and target_type match', () => {
    const shape = chemblSearchTargets.input.shape;
    expect(shape.query.description).toContain('CHEMBL203');
    expect(shape.organism.description).toContain('scientific name');
    expect(shape.target_type.description).toContain('full');
    expect(chemblSearchTargets.description).toContain('ChEMBL target ID');
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

  it('rejects a malformed cursor with InvalidParams and framework recovery', async () => {
    // `handler` is typed to allow a sync return, so normalize before catching.
    const err: unknown = await Promise.resolve(
      chemblSearchTargets.handler(
        chemblSearchTargets.input.parse({ query: 'kinase', cursor: '!!not-a-cursor!!' }),
        ctx(),
      ),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect((err as McpError).data).toMatchObject({
      reason: 'invalid_cursor',
      recovery: { hint: expect.any(String) },
    });
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

  it.each(['', '   ', '\t\n'])(
    'reads the blank cursor %j as omitted: the first page',
    async (cursor) => {
      stubTargetCorpus(7);
      const result = await chemblSearchTargets.handler(
        chemblSearchTargets.input.parse({ query: 'kinase', limit: 3, cursor }),
        ctx(),
      );
      expect(idsOf(result.targets)).toEqual(['CHEMBL0', 'CHEMBL1', 'CHEMBL2']);
      expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('offset')).toBe('0');
    },
  );

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

  it('renders every row line of markup-free values unescaped', () => {
    const blocks = chemblSearchTargets.format!({
      targets: [
        {
          target_chembl_id: 'CHEMBL203',
          pref_name: 'Epidermal growth factor receptor',
          target_type: 'SINGLE PROTEIN',
          organism: 'Homo sapiens',
          components: [
            { accession: 'P00533', gene_symbols: ['EGFR', 'ERBB1'] },
            { accession: null, gene_symbols: [] },
          ],
        },
      ],
    });
    expect((blocks[0] as { text: string }).text.split('\n')).toEqual([
      '**CHEMBL203** — Epidermal growth factor receptor',
      'Type: SINGLE PROTEIN | Organism: Homo sapiens',
      '  • accession P00533 | genes: EGFR, ERBB1',
      '  • accession — | genes: —',
    ]);
  });

  /** #44: every upstream string reads back as recorded, around the server's bold ID and bullets. */
  it('renders upstream names, types, organisms, accessions, and genes as the text recorded', () => {
    const blocks = chemblSearchTargets.format!({
      targets: [
        {
          target_chembl_id: 'CHEMBL_1*',
          pref_name: 'Receptor [125I](R) *mutant*',
          target_type: '_SINGLE_ PROTEIN',
          organism: 'Homo <i>sapiens</i>',
          components: [{ accession: 'P0\\*', gene_symbols: ['HLA-A*02', 'GENE\n# H'] }],
        },
      ],
    });
    const { text, nodes } = parseMarkdown((blocks[0] as { text: string }).text);
    expect(text).toBe(
      [
        'CHEMBL_1* — Receptor [125I](R) *mutant*',
        'Type: _SINGLE_ PROTEIN | Organism: Homo <i>sapiens</i>',
        '• accession P0\\* | genes: HLA-A*02, GENE\n# H',
      ].join('\n'),
    );
    expect(markupNodes(nodes)).toEqual([]);
  });
});
