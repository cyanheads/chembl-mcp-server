/**
 * @fileoverview Behavior tests for chembl_get_assay over a fake `/assay.json`
 * `__in` list that answers the way ChEMBL does — exact-case matching, its own
 * order, duplicates collapsed, other IDs dropped with HTTP 200, a 20-row default
 * page (#55): the 0.5.0 singular call through the declared alias, request-order
 * reassembly, misses and deferred IDs with their one notice, the per-call cap and
 * the absurd-input ceiling, sparse records kept null, the 0–9 confidence score,
 * canonical ID input (#41), and format() rendering every field with upstream text
 * as recorded (#44).
 * @module tests/tools/chembl-get-assay.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblGetAssay } from '@/mcp-server/tools/definitions/chembl-get-assay.tool.js';
import { initChemblService } from '@/services/chembl/chembl-service.js';
import { markupNodes, parseMarkdown } from '../_commonmark.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A raw upstream assay record carrying every field the lookup selects. */
function rawAssay(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assay_chembl_id: id,
    description: `Assay ${id}`,
    assay_type: 'B',
    assay_type_description: 'Binding',
    target_chembl_id: 'CHEMBL203',
    assay_organism: 'Homo sapiens',
    confidence_score: 9,
    confidence_description: 'Direct single protein target assigned',
    bao_label: 'single protein format',
    assay_cell_type: null,
    assay_tissue: null,
    assay_strain: null,
    document_chembl_id: 'CHEMBL1134862',
    ...overrides,
  };
}

/** CHEMBL3877213 as ChEMBL records it (live, 2026-11-11). */
const A431_ASSAY = rawAssay('CHEMBL3877213', {
  description:
    'Inhibition of PF-06422899 binding to EGFR in human A431 cells after 1 hr by gel-based ABPP assay',
  bao_label: 'cell-based format',
  assay_cell_type: 'A-431',
  document_chembl_id: 'CHEMBL3875233',
});

/**
 * A fetch stub that answers `/assay.json?assay_chembl_id__in=…` from `records` the
 * way ChEMBL does: an exact-case match, duplicates collapsed, IDs it holds no
 * assay for dropped with HTTP 200, the rows in ascending ID order (never the
 * request's), and a 20-row page unless `limit` says otherwise.
 */
function fakeAssayList(records: readonly Record<string, unknown>[]) {
  const byId = new Map(records.map((record) => [record.assay_chembl_id as string, record]));
  return (input: string) => {
    const url = new URL(input);
    const requested = new Set(url.searchParams.get('assay_chembl_id__in')?.split(',') ?? []);
    const matched = [...requested]
      .filter((id) => byId.has(id))
      .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))
      .map((id) => byId.get(id));
    const limit = Number(url.searchParams.get('limit') ?? 20);
    return Promise.resolve(
      jsonResponse({
        assays: matched.slice(0, limit),
        page_meta: { limit, offset: 0, total_count: matched.length },
      }),
    );
  };
}

/** The `__in` IDs and `limit` of each request the stub received. */
function requests(): Array<{ path: string; ids: string[]; limit: string | null }> {
  return fetchMock.mock.calls.map(([input]) => {
    const url = new URL(String(input));
    return {
      path: url.pathname,
      ids: url.searchParams.get('assay_chembl_id__in')?.split(',') ?? [],
      limit: url.searchParams.get('limit'),
    };
  });
}

/** `n` distinct assay IDs, CHEMBL1000 upward. */
const ids = (n: number, from = 1000) => Array.from({ length: n }, (_, i) => `CHEMBL${from + i}`);

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

const ctx = () => createMockContext({ tenantId: 'default', errors: chemblGetAssay.errors });

const MISS_NOTICE_TAIL =
  '(not_found_ids) — assay IDs come from the assay_chembl_id of chembl_get_bioactivities rows; a compound, target, or document ID matches none.';

describe('chembl_get_assay — batch lookup (#55)', () => {
  it('serves the 0.5.0 call { assay_chembl_id } and a padded lowercase list alike', async () => {
    fetchMock.mockImplementation(fakeAssayList([A431_ASSAY]));
    // @ts-expect-error The 0.5.0 argument key, served through the declared inputAlias.
    const singular = await runToolContract(chemblGetAssay, { assay_chembl_id: 'CHEMBL3877213' });
    const listed = await runToolContract(chemblGetAssay, {
      assay_chembl_ids: [' chembl3877213 '],
    });
    for (const result of [singular, listed]) {
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        assays: [
          {
            assay_chembl_id: 'CHEMBL3877213',
            description:
              'Inhibition of PF-06422899 binding to EGFR in human A431 cells after 1 hr by gel-based ABPP assay',
            assay_type: 'B',
            assay_type_description: 'Binding',
            bao_label: 'cell-based format',
            target_chembl_id: 'CHEMBL203',
            organism: 'Homo sapiens',
            assay_cell_type: 'A-431',
            assay_tissue: null,
            assay_strain: null,
            confidence_score: 9,
            confidence_description: 'Direct single protein target assigned',
            document_chembl_id: 'CHEMBL3875233',
          },
        ],
        not_found_ids: [],
        deferred_ids: [],
      });
    }
    expect(requests()).toEqual([
      { path: '/chembl/api/data/assay.json', ids: ['CHEMBL3877213'], limit: '1' },
      { path: '/chembl/api/data/assay.json', ids: ['CHEMBL3877213'], limit: '1' },
    ]);
  });

  it('returns assays in request order whatever order ChEMBL answers in', async () => {
    fetchMock.mockImplementation(fakeAssayList(ids(3).map((id) => rawAssay(id))));
    const result = await chemblGetAssay.handler(
      chemblGetAssay.input.parse({ assay_chembl_ids: ['CHEMBL1002', 'CHEMBL1000', 'CHEMBL1001'] }),
      ctx(),
    );
    expect(result.assays.map((assay) => assay.assay_chembl_id)).toEqual([
      'CHEMBL1002',
      'CHEMBL1000',
      'CHEMBL1001',
    ]);
  });

  it('lists an invented ID and a molecule ID in not_found_ids beside the hits, with a notice', async () => {
    fetchMock.mockImplementation(fakeAssayList([A431_ASSAY, rawAssay('CHEMBL615325')]));
    const c = ctx();
    const result = await chemblGetAssay.handler(
      chemblGetAssay.input.parse({
        assay_chembl_ids: ['CHEMBL99999999901', 'CHEMBL3877213', 'CHEMBL25', 'chembl615325'],
      }),
      c,
    );
    expect(result.assays.map((assay) => assay.assay_chembl_id)).toEqual([
      'CHEMBL3877213',
      'CHEMBL615325',
    ]);
    expect(result.not_found_ids).toEqual(['CHEMBL99999999901', 'CHEMBL25']);
    expect(result.deferred_ids).toEqual([]);
    expect(getEnrichment(c)).toEqual({
      notice: `No assay record in ChEMBL for 2 of 4 IDs looked up ${MISS_NOTICE_TAIL}`,
    });
  });

  it('succeeds with assays: [] and the notice when every ID misses, on both surfaces', async () => {
    fetchMock.mockImplementation(fakeAssayList([]));
    const result = await runToolContract(chemblGetAssay, { assay_chembl_ids: ['CHEMBL25'] });
    const notice = `No assay record in ChEMBL for 1 of 1 ID looked up ${MISS_NOTICE_TAIL}`;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      assays: [],
      not_found_ids: ['CHEMBL25'],
      deferred_ids: [],
      notice,
    });
    const text = result.content.map((block) => (block as { text: string }).text).join('');
    expect(text.split('\n')).toEqual(['Not found: CHEMBL25', 'Deferred: none', '', `> ${notice}`]);
  });

  it('counts a repeated ID once, in any case, and looks it up once', async () => {
    fetchMock.mockImplementation(fakeAssayList(ids(2).map((id) => rawAssay(id))));
    const result = await chemblGetAssay.handler(
      chemblGetAssay.input.parse({
        assay_chembl_ids: ['CHEMBL1001', 'chembl1001', ' CHEMBL1000 ', 'CHEMBL1001'],
      }),
      ctx(),
    );
    expect(requests()).toEqual([
      { path: '/chembl/api/data/assay.json', ids: ['CHEMBL1001', 'CHEMBL1000'], limit: '2' },
    ]);
    expect(result.assays.map((assay) => assay.assay_chembl_id)).toEqual([
      'CHEMBL1001',
      'CHEMBL1000',
    ]);
  });

  it('looks up 100 distinct IDs in one request carrying limit=100, deferring none', async () => {
    fetchMock.mockImplementation(fakeAssayList(ids(100).map((id) => rawAssay(id))));
    const c = ctx();
    const result = await chemblGetAssay.handler(
      chemblGetAssay.input.parse({ assay_chembl_ids: ids(100) }),
      c,
    );
    expect(requests()).toEqual([
      { path: '/chembl/api/data/assay.json', ids: ids(100), limit: '100' },
    ]);
    expect(result.assays).toHaveLength(100);
    expect(result.not_found_ids).toEqual([]);
    expect(result.deferred_ids).toEqual([]);
    expect(getEnrichment(c)).toEqual({});
  });

  it('defers the distinct IDs past the first 100, counting repeats once, and says to pass them again', async () => {
    fetchMock.mockImplementation(fakeAssayList(ids(102).map((id) => rawAssay(id))));
    const [first, ...rest] = ids(102) as [string, ...string[]];
    const sent = [first, first.toLowerCase(), ...rest, rest[100] as string, first];
    const c = ctx();
    const result = await chemblGetAssay.handler(
      chemblGetAssay.input.parse({ assay_chembl_ids: sent }),
      c,
    );
    expect(requests()).toEqual([
      { path: '/chembl/api/data/assay.json', ids: ids(100), limit: '100' },
    ]);
    expect(result.assays.map((assay) => assay.assay_chembl_id)).toEqual(ids(100));
    expect(result.deferred_ids).toEqual(['CHEMBL1100', 'CHEMBL1101']);
    expect(getEnrichment(c)).toEqual({
      notice:
        'Not looked up: 2 IDs past the first 100 distinct (deferred_ids) — call again with deferred_ids as assay_chembl_ids.',
    });
  });

  it('joins misses and deferrals into the one notice', async () => {
    fetchMock.mockImplementation(fakeAssayList(ids(99).map((id) => rawAssay(id))));
    const c = ctx();
    const result = await chemblGetAssay.handler(
      chemblGetAssay.input.parse({ assay_chembl_ids: [...ids(99), 'CHEMBL25', 'CHEMBL203'] }),
      c,
    );
    expect(result.not_found_ids).toEqual(['CHEMBL25']);
    expect(result.deferred_ids).toEqual(['CHEMBL203']);
    expect(getEnrichment(c)).toEqual({
      notice: `No assay record in ChEMBL for 1 of 100 IDs looked up ${MISS_NOTICE_TAIL} Not looked up: 1 ID past the first 100 distinct (deferred_ids) — call again with deferred_ids as assay_chembl_ids.`,
    });
  });

  it("keeps a sparse record's missing fields null and a confidence score of 0 as 0", async () => {
    fetchMock.mockImplementation(
      fakeAssayList([
        { assay_chembl_id: 'CHEMBL1' },
        rawAssay('CHEMBL615118', {
          confidence_score: 0,
          confidence_description: 'Default value - Target unknown or has yet to be assigned',
          target_chembl_id: 'CHEMBL612545',
        }),
      ]),
    );
    const result = await chemblGetAssay.handler(
      chemblGetAssay.input.parse({ assay_chembl_ids: ['CHEMBL1', 'CHEMBL615118'] }),
      ctx(),
    );
    expect(result.assays[0]).toEqual({
      assay_chembl_id: 'CHEMBL1',
      description: null,
      assay_type: null,
      assay_type_description: null,
      bao_label: null,
      target_chembl_id: null,
      organism: null,
      assay_cell_type: null,
      assay_tissue: null,
      assay_strain: null,
      confidence_score: null,
      confidence_description: null,
      document_chembl_id: null,
    });
    expect(result.assays[1]?.confidence_score).toBe(0);
  });

  it('fails the whole call on an upstream rejection rather than reporting the IDs as not found', async () => {
    fetchMock.mockResolvedValue(new Response('Bad Request', { status: 400 }));
    const result = await runToolContract(chemblGetAssay, { assay_chembl_ids: ['CHEMBL1'] });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_query' } },
    });
    expect(result.structuredContent).not.toHaveProperty('not_found_ids');
  });

  it('rejects an empty list, an ID that is no ChEMBL ID, and more than 1000 IDs at the schema (#41)', async () => {
    const message =
      'Must be a ChEMBL assay ID like CHEMBL674637 — take one from a chembl_get_bioactivities row.';
    for (const raw of ['imatinib', '   ', 'CHEMBL']) {
      const parsed = chemblGetAssay.input.safeParse({ assay_chembl_ids: ['CHEMBL1', raw] });
      expect(parsed.success, raw).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe(message);
    }
    expect(chemblGetAssay.input.safeParse({ assay_chembl_ids: [] }).success).toBe(false);
    expect(chemblGetAssay.input.safeParse({ assay_chembl_ids: ids(1000) }).success).toBe(true);
    const tooMany = await runToolContract(chemblGetAssay, { assay_chembl_ids: ids(1001) });
    expect(tooMany.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('describes the confidence score as 0–9, 0 meaning no target assigned yet, never as unscored', () => {
    const scoreDescription =
      chemblGetAssay.output.shape.assays.element.shape.confidence_score.description;
    for (const text of [chemblGetAssay.description, scoreDescription]) {
      expect(text).toContain('0–9');
      expect(text).not.toContain('1–9');
      expect(text).not.toMatch(/unscored/i);
    }
    expect(scoreDescription).toContain('0 = no target assigned yet');
  });
});

/** A fully populated normalized assay, as the handler returns it. */
const FULL_ASSAY = {
  assay_chembl_id: 'CHEMBL674637',
  description: 'Inhibition of EGFR',
  assay_type: 'B',
  assay_type_description: 'Binding',
  bao_label: 'single protein format',
  target_chembl_id: 'CHEMBL203',
  organism: 'Homo sapiens',
  assay_cell_type: null,
  assay_tissue: null,
  assay_strain: null,
  confidence_score: 9,
  confidence_description: 'Direct single protein target assigned',
  document_chembl_id: 'CHEMBL1134862',
};

/** The same assay with every nullable field absent. */
const SPARSE_ASSAY = {
  assay_chembl_id: 'CHEMBL1',
  description: null,
  assay_type: null,
  assay_type_description: null,
  bao_label: null,
  target_chembl_id: null,
  organism: null,
  assay_cell_type: null,
  assay_tissue: null,
  assay_strain: null,
  confidence_score: null,
  confidence_description: null,
  document_chembl_id: null,
};

const formatText = (result: Parameters<NonNullable<typeof chemblGetAssay.format>>[0]) =>
  (chemblGetAssay.format!(result)[0] as { text: string }).text;

describe('chembl_get_assay format()', () => {
  it('renders every field of each assay in request order, then both ID lists', () => {
    const text = formatText({
      assays: [
        FULL_ASSAY,
        {
          ...FULL_ASSAY,
          assay_chembl_id: 'CHEMBL3877213',
          description: 'Inhibition in A431 cells',
          bao_label: 'cell-based format',
          assay_cell_type: 'A-431',
          assay_tissue: 'Skin',
          assay_strain: 'BALB/c',
          confidence_score: 0,
          confidence_description: 'Default value - Target unknown or has yet to be assigned',
          document_chembl_id: 'CHEMBL3875233',
        },
      ],
      not_found_ids: ['CHEMBL25', 'CHEMBL99999999901'],
      deferred_ids: ['CHEMBL2'],
    });
    expect(text.split('\n')).toEqual([
      '**CHEMBL674637**',
      'Inhibition of EGFR',
      'Type: Binding (B) | Target: CHEMBL203 | Organism: Homo sapiens',
      'Confidence: 9 (Direct single protein target assigned)',
      'Format: single protein format | Cell type: — | Tissue: — | Strain: — | Document: CHEMBL1134862',
      '',
      '**CHEMBL3877213**',
      'Inhibition in A431 cells',
      'Type: Binding (B) | Target: CHEMBL203 | Organism: Homo sapiens',
      'Confidence: 0 (Default value - Target unknown or has yet to be assigned)',
      'Format: cell-based format | Cell type: A-431 | Tissue: Skin | Strain: BALB/c | Document: CHEMBL3875233',
      '',
      'Not found: CHEMBL25, CHEMBL99999999901',
      'Deferred: CHEMBL2',
    ]);
  });

  it('renders — for absent fields on a sparse assay, and none for empty ID lists', () => {
    const text = formatText({ assays: [SPARSE_ASSAY], not_found_ids: [], deferred_ids: [] });
    expect(text.split('\n')).toEqual([
      '**CHEMBL1**',
      'Type: — (—) | Target: — | Organism: —',
      'Confidence: — (—)',
      'Format: — | Cell type: — | Tissue: — | Strain: — | Document: —',
      '',
      'Not found: none',
      'Deferred: none',
    ]);
  });

  /**
   * #44: the description takes the line under the bold ID, so a leading `#`, `>`,
   * `-`, or `1.` would open a block there; every other field sits inside a line.
   */
  it.each([
    'Affinity in displacing [125I](R)-DOI from rat cortical homogenate 5-HT2 receptor.',
    '# Heading-like description',
    '> quoted',
    '- listed',
    '1. numbered',
    '---',
    'two *starred* and _under_ words<br>with a tag',
    String.raw`a backslash \* before punctuation`,
    'first line\n# second line',
  ])('renders the description %j as the text recorded', (description) => {
    const text = formatText({
      assays: [
        {
          assay_chembl_id: 'CHEMBL615616',
          description,
          assay_type: 'B*',
          assay_type_description: '_Binding_',
          bao_label: '*cell-based* format',
          target_chembl_id: 'CHEMBL[1](x)',
          organism: 'Rattus <b>norvegicus</b>',
          assay_cell_type: 'HEK_293_',
          assay_tissue: '`Liver`',
          assay_strain: '[Wistar](y)',
          confidence_score: 8,
          confidence_description: 'Homologous `single` protein',
          document_chembl_id: 'CHEMBL<i>1</i>',
        },
      ],
      not_found_ids: [],
      deferred_ids: [],
    });
    const parsed = parseMarkdown(text);
    expect(parsed.text).toBe(
      [
        'CHEMBL615616',
        description,
        'Type: _Binding_ (B*) | Target: CHEMBL[1](x) | Organism: Rattus <b>norvegicus</b>',
        'Confidence: 8 (Homologous `single` protein)',
        'Format: *cell-based* format | Cell type: HEK_293_ | Tissue: `Liver` | Strain: [Wistar](y) | Document: CHEMBL<i>1</i>',
        'Not found: none',
        'Deferred: none',
      ].join('\n'),
    );
    expect(markupNodes(parsed.nodes)).toEqual([]);
  });

  /**
   * The issue's repro end to end: structuredContent carries the description as
   * ChEMBL recorded it, and content[] reads back to the same text.
   */
  it('keeps structuredContent as recorded while content[] reads back the same text', async () => {
    const description =
      'Affinity in displacing [125I](R)-DOI from rat cortical homogenate 5-HT2 receptor.';
    fetchMock.mockImplementation(
      fakeAssayList([
        rawAssay('CHEMBL615616', {
          description,
          target_chembl_id: 'CHEMBL224',
          assay_organism: 'Rattus norvegicus',
          confidence_score: '8',
          confidence_description: 'Homologous single protein target assigned',
          bao_label: 'tissue-based format',
          assay_tissue: 'Cerebral cortex',
          assay_strain: 'Sprague-Dawley',
          document_chembl_id: 'CHEMBL1123456',
        }),
      ]),
    );
    const result = await runToolContract(chemblGetAssay, { assay_chembl_ids: ['CHEMBL615616'] });
    expect(result.structuredContent).toEqual({
      assays: [
        {
          assay_chembl_id: 'CHEMBL615616',
          description,
          assay_type: 'B',
          assay_type_description: 'Binding',
          bao_label: 'tissue-based format',
          target_chembl_id: 'CHEMBL224',
          organism: 'Rattus norvegicus',
          assay_cell_type: null,
          assay_tissue: 'Cerebral cortex',
          assay_strain: 'Sprague-Dawley',
          confidence_score: 8,
          confidence_description: 'Homologous single protein target assigned',
          document_chembl_id: 'CHEMBL1123456',
        },
      ],
      not_found_ids: [],
      deferred_ids: [],
    });
    const content = result.content.map((block) => (block as { text: string }).text).join('');
    const { text, nodes } = parseMarkdown(content);
    expect(text).toBe(
      [
        'CHEMBL615616',
        description,
        'Type: Binding (B) | Target: CHEMBL224 | Organism: Rattus norvegicus',
        'Confidence: 8 (Homologous single protein target assigned)',
        'Format: tissue-based format | Cell type: — | Tissue: Cerebral cortex | Strain: Sprague-Dawley | Document: CHEMBL1123456',
        'Not found: none',
        'Deferred: none',
      ].join('\n'),
    );
    expect(markupNodes(nodes)).toEqual([]);
  });
});
