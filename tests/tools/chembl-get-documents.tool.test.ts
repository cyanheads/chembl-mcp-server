/**
 * @fileoverview Behavior tests for chembl_get_documents over a fake
 * `/document.json` `__in` list that answers the way ChEMBL does — exact-case
 * matching, its own order, duplicates collapsed, other IDs dropped with HTTP 200,
 * a 20-row default page (#54): the singular call through the declared alias,
 * request-order reassembly, misses and deferred IDs with their one notice, the
 * per-call cap and the absurd-input ceiling, sparse patent and dataset records
 * kept null, the PubMed ID as a digit string, the pointers on the bioactivity
 * and assay records, and format() rendering every field with upstream text as
 * recorded.
 * @module tests/tools/chembl-get-documents.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblGetAssay } from '@/mcp-server/tools/definitions/chembl-get-assay.tool.js';
import { chemblGetBioactivities } from '@/mcp-server/tools/definitions/chembl-get-bioactivities.tool.js';
import { chemblGetDocuments } from '@/mcp-server/tools/definitions/chembl-get-documents.tool.js';
import { initChemblService } from '@/services/chembl/chembl-service.js';
import { markupNodes, parseMarkdown } from '../_commonmark.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A raw upstream publication carrying every field the lookup selects. */
function rawDocument(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    document_chembl_id: id,
    doc_type: 'PUBLICATION',
    title: `Paper ${id}`,
    authors: 'Doe J, Roe R.',
    journal: 'J Med Chem',
    year: 2014,
    volume: '57',
    issue: '23',
    first_page: '1',
    last_page: '9',
    pubmed_id: 12345,
    doi: `10.1021/${id.toLowerCase()}`,
    patent_id: null,
    ...overrides,
  };
}

/** The three documents of #54's acceptance criteria, as ChEMBL records them (live, 2026-11-11). */
const HANAN_2014 = rawDocument('CHEMBL3351701', {
  title:
    'Discovery of selective and noncovalent diaminopyrimidine-based inhibitors of epidermal growth factor receptor containing the T790M resistance mutation.',
  authors:
    'Hanan EJ, Eigenbrot C, Bryan MC, Burdick DJ, Chan BK, Chen Y, Dotson J, Heald RA, Jackson PS, La H, Lainchbury MD, Malek S, Purkey HE, Schaefer G, Schmidt S, Seward EM, Sideris S, Tam C, Wang S, Yeap SK, Yen I, Yin J, Yu C, Zilberleyb I, Heffron TP.',
  first_page: '10176',
  last_page: '10191',
  pubmed_id: 25383627,
  doi: '10.1021/jm501578n',
});
const KNIGHT_2005 = rawDocument('CHEMBL1240298', {
  title: 'Features of selective kinase inhibitors.',
  authors: 'Knight ZA, Shokat KM.',
  journal: 'Chem Biol',
  year: 2005,
  volume: '12',
  issue: '6',
  first_page: '621',
  last_page: '637',
  pubmed_id: 15975507,
  doi: '10.1016/j.chembiol.2005.04.011',
});
const PUBCHEM_DATASET = {
  document_chembl_id: 'CHEMBL1201862',
  doc_type: 'DATASET',
  title: 'PubChem BioAssay data set',
  authors: null,
  journal: null,
  year: null,
  volume: null,
  issue: null,
  first_page: null,
  last_page: null,
  pubmed_id: null,
  doi: null,
  patent_id: null,
};
const ATR_PATENT = {
  ...PUBCHEM_DATASET,
  document_chembl_id: 'CHEMBL3638439',
  doc_type: 'PATENT',
  title: 'Compounds Useful as Inhibitors of ATR Kinase',
  year: 2013,
  patent_id: 'US-20130089624-A1',
};

/**
 * A fetch stub that answers `/document.json?document_chembl_id__in=…` from
 * `records` the way ChEMBL does: an exact-case match, duplicates collapsed, IDs
 * it holds no document for dropped with HTTP 200, the rows in ascending ID order
 * (never the request's), and a 20-row page unless `limit` says otherwise.
 */
function fakeDocumentList(records: readonly Record<string, unknown>[]) {
  const byId = new Map(records.map((record) => [record.document_chembl_id as string, record]));
  return (input: string) => {
    const url = new URL(input);
    const requested = new Set(url.searchParams.get('document_chembl_id__in')?.split(',') ?? []);
    const matched = [...requested]
      .filter((id) => byId.has(id))
      .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))
      .map((id) => byId.get(id));
    const limit = Number(url.searchParams.get('limit') ?? 20);
    return Promise.resolve(
      jsonResponse({
        documents: matched.slice(0, limit),
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
      ids: url.searchParams.get('document_chembl_id__in')?.split(',') ?? [],
      limit: url.searchParams.get('limit'),
    };
  });
}

/** `n` distinct document IDs, CHEMBL1000 upward. */
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

const ctx = () => createMockContext({ tenantId: 'default', errors: chemblGetDocuments.errors });

const MISS_NOTICE_TAIL =
  '(not_found_ids) — document IDs come from the document_chembl_id of chembl_get_bioactivities rows and chembl_get_assay records; a compound, target, or assay ID matches none.';

const DEFER_NOTICE = (n: number) =>
  `Not looked up: ${n} ID${n === 1 ? '' : 's'} past the first 100 distinct (deferred_ids) — call again with deferred_ids as document_chembl_ids.`;

/** CHEMBL3351701 as the tool returns it. */
const HANAN_2014_OUT = {
  document_chembl_id: 'CHEMBL3351701',
  doc_type: 'PUBLICATION',
  title:
    'Discovery of selective and noncovalent diaminopyrimidine-based inhibitors of epidermal growth factor receptor containing the T790M resistance mutation.',
  authors:
    'Hanan EJ, Eigenbrot C, Bryan MC, Burdick DJ, Chan BK, Chen Y, Dotson J, Heald RA, Jackson PS, La H, Lainchbury MD, Malek S, Purkey HE, Schaefer G, Schmidt S, Seward EM, Sideris S, Tam C, Wang S, Yeap SK, Yen I, Yin J, Yu C, Zilberleyb I, Heffron TP.',
  journal: 'J Med Chem',
  year: 2014,
  volume: '57',
  issue: '23',
  first_page: '10176',
  last_page: '10191',
  pubmed_id: '25383627',
  doi: '10.1021/jm501578n',
  patent_id: null,
};

describe('chembl_get_documents — batch lookup (#54)', () => {
  it('serves the singular { document_chembl_id } call and a padded lowercase list alike', async () => {
    fetchMock.mockImplementation(fakeDocumentList([HANAN_2014]));
    const singularArgs = { document_chembl_id: 'CHEMBL3351701' };
    // @ts-expect-error The singular argument key, served through the declared inputAlias.
    const singular = await runToolContract(chemblGetDocuments, singularArgs);
    const listed = await runToolContract(chemblGetDocuments, {
      document_chembl_ids: [' chembl3351701 '],
    });
    for (const result of [singular, listed]) {
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        documents: [HANAN_2014_OUT],
        not_found_ids: [],
        deferred_ids: [],
      });
    }
    expect(requests()).toEqual([
      { path: '/chembl/api/data/document.json', ids: ['CHEMBL3351701'], limit: '1' },
      { path: '/chembl/api/data/document.json', ids: ['CHEMBL3351701'], limit: '1' },
    ]);
  });

  it("returns #54's three documents in request order: two PMIDs as digit strings and a dataset without one", async () => {
    fetchMock.mockImplementation(fakeDocumentList([HANAN_2014, KNIGHT_2005, PUBCHEM_DATASET]));
    const c = ctx();
    const result = await chemblGetDocuments.handler(
      chemblGetDocuments.input.parse({
        document_chembl_ids: ['CHEMBL3351701', 'chembl1240298', 'CHEMBL1201862'],
      }),
      c,
    );
    expect(
      result.documents.map((doc) => [doc.document_chembl_id, doc.doc_type, doc.pubmed_id]),
    ).toEqual([
      ['CHEMBL3351701', 'PUBLICATION', '25383627'],
      ['CHEMBL1240298', 'PUBLICATION', '15975507'],
      ['CHEMBL1201862', 'DATASET', null],
    ]);
    expect(result.documents[2]).toEqual(PUBCHEM_DATASET);
    expect(result.not_found_ids).toEqual([]);
    expect(getEnrichment(c)).toEqual({});
  });

  it('lists an invented ID and an assay ID in not_found_ids beside a hit, with a notice', async () => {
    fetchMock.mockImplementation(fakeDocumentList([KNIGHT_2005]));
    const c = ctx();
    const result = await chemblGetDocuments.handler(
      chemblGetDocuments.input.parse({
        document_chembl_ids: ['CHEMBL99999999901', 'CHEMBL1240298', 'CHEMBL1908684'],
      }),
      c,
    );
    expect(result.documents.map((doc) => doc.document_chembl_id)).toEqual(['CHEMBL1240298']);
    expect(result.not_found_ids).toEqual(['CHEMBL99999999901', 'CHEMBL1908684']);
    expect(result.deferred_ids).toEqual([]);
    expect(getEnrichment(c)).toEqual({
      notice: `No document record in ChEMBL for 2 of 3 IDs looked up ${MISS_NOTICE_TAIL}`,
    });
  });

  it('succeeds with documents: [] and the notice when every ID misses, on both surfaces', async () => {
    fetchMock.mockImplementation(fakeDocumentList([]));
    const result = await runToolContract(chemblGetDocuments, {
      document_chembl_ids: ['CHEMBL99999999901', 'CHEMBL1908684'],
    });
    const notice = `No document record in ChEMBL for 2 of 2 IDs looked up ${MISS_NOTICE_TAIL}`;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      documents: [],
      not_found_ids: ['CHEMBL99999999901', 'CHEMBL1908684'],
      deferred_ids: [],
      notice,
    });
    const text = result.content.map((block) => (block as { text: string }).text).join('');
    expect(text.split('\n')).toEqual([
      'Not found: CHEMBL99999999901, CHEMBL1908684',
      'Deferred: none',
      '',
      `> ${notice}`,
    ]);
  });

  it('counts a repeated ID once, in any case, and looks it up once', async () => {
    fetchMock.mockImplementation(fakeDocumentList(ids(2).map((id) => rawDocument(id))));
    const result = await chemblGetDocuments.handler(
      chemblGetDocuments.input.parse({
        document_chembl_ids: ['CHEMBL1001', 'chembl1001', ' CHEMBL1000 ', 'CHEMBL1001'],
      }),
      ctx(),
    );
    expect(requests()).toEqual([
      { path: '/chembl/api/data/document.json', ids: ['CHEMBL1001', 'CHEMBL1000'], limit: '2' },
    ]);
    expect(result.documents.map((doc) => doc.document_chembl_id)).toEqual([
      'CHEMBL1001',
      'CHEMBL1000',
    ]);
  });

  it('looks up 100 distinct IDs in one request carrying limit=100, deferring none', async () => {
    fetchMock.mockImplementation(fakeDocumentList(ids(100).map((id) => rawDocument(id))));
    const c = ctx();
    const result = await chemblGetDocuments.handler(
      chemblGetDocuments.input.parse({ document_chembl_ids: ids(100) }),
      c,
    );
    expect(requests()).toEqual([
      { path: '/chembl/api/data/document.json', ids: ids(100), limit: '100' },
    ]);
    expect(result.documents).toHaveLength(100);
    expect(result.not_found_ids).toEqual([]);
    expect(result.deferred_ids).toEqual([]);
    expect(getEnrichment(c)).toEqual({});
  });

  it('defers the 101st distinct ID, counting repeats once, and says to pass it again', async () => {
    fetchMock.mockImplementation(fakeDocumentList(ids(101).map((id) => rawDocument(id))));
    const [first, ...rest] = ids(101) as [string, ...string[]];
    const c = ctx();
    const result = await chemblGetDocuments.handler(
      chemblGetDocuments.input.parse({
        document_chembl_ids: [first, first.toLowerCase(), ...rest, first],
      }),
      c,
    );
    expect(requests()).toEqual([
      { path: '/chembl/api/data/document.json', ids: ids(100), limit: '100' },
    ]);
    expect(result.documents.map((doc) => doc.document_chembl_id)).toEqual(ids(100));
    expect(result.deferred_ids).toEqual(['CHEMBL1100']);
    expect(getEnrichment(c)).toEqual({ notice: DEFER_NOTICE(1) });
  });

  it('joins misses and deferrals into the one notice', async () => {
    fetchMock.mockImplementation(fakeDocumentList(ids(99).map((id) => rawDocument(id))));
    const c = ctx();
    const result = await chemblGetDocuments.handler(
      chemblGetDocuments.input.parse({
        document_chembl_ids: [...ids(99), 'CHEMBL25', 'CHEMBL203', 'CHEMBL1908684'],
      }),
      c,
    );
    expect(result.not_found_ids).toEqual(['CHEMBL25']);
    expect(result.deferred_ids).toEqual(['CHEMBL203', 'CHEMBL1908684']);
    expect(getEnrichment(c)).toEqual({
      notice: `No document record in ChEMBL for 1 of 100 IDs looked up ${MISS_NOTICE_TAIL} ${DEFER_NOTICE(2)}`,
    });
  });

  it("keeps a patent's journal, volume, pubmed_id, and doi null, and every field of a bare record", async () => {
    fetchMock.mockImplementation(fakeDocumentList([ATR_PATENT, { document_chembl_id: 'CHEMBL1' }]));
    const result = await chemblGetDocuments.handler(
      chemblGetDocuments.input.parse({ document_chembl_ids: ['CHEMBL3638439', 'CHEMBL1'] }),
      ctx(),
    );
    expect(result.documents[0]).toEqual(ATR_PATENT);
    expect(result.documents[0]).toMatchObject({
      journal: null,
      volume: null,
      pubmed_id: null,
      doi: null,
    });
    expect(result.documents[1]).toEqual({
      document_chembl_id: 'CHEMBL1',
      doc_type: null,
      title: null,
      authors: null,
      journal: null,
      year: null,
      volume: null,
      issue: null,
      first_page: null,
      last_page: null,
      pubmed_id: null,
      doi: null,
      patent_id: null,
    });
  });

  it('fails the whole call on an upstream rejection rather than reporting the IDs as not found', async () => {
    fetchMock.mockResolvedValue(new Response('Bad Request', { status: 400 }));
    const result = await runToolContract(chemblGetDocuments, { document_chembl_ids: ['CHEMBL1'] });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_query' } },
    });
    expect(result.structuredContent).not.toHaveProperty('not_found_ids');
  });

  it('rejects an empty list, an ID that is no ChEMBL ID, and more than 1000 IDs at the schema', async () => {
    const message =
      'Must be a ChEMBL document ID like CHEMBL3351701 — take one from a chembl_get_bioactivities row or a chembl_get_assay record.';
    for (const raw of ['10.1021/jm501578n', '25383627', '', '   ', 'CHEMBL']) {
      const parsed = chemblGetDocuments.input.safeParse({ document_chembl_ids: ['CHEMBL1', raw] });
      expect(parsed.success, raw).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe(message);
    }
    expect(chemblGetDocuments.input.safeParse({ document_chembl_ids: [] }).success).toBe(false);
    expect(chemblGetDocuments.input.safeParse({ document_chembl_ids: ids(1000) }).success).toBe(
      true,
    );
    const tooMany = await runToolContract(chemblGetDocuments, { document_chembl_ids: ids(1001) });
    expect(tooMany.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is named by the document_chembl_id of bioactivity rows and assay records', () => {
    const rowDescription =
      chemblGetBioactivities.output.shape.activities.element.shape.document_chembl_id.description;
    const assayDescription =
      chemblGetAssay.output.shape.assays.element.shape.document_chembl_id.description;
    for (const text of [rowDescription, assayDescription]) {
      expect(text).toContain('pass to chembl_get_documents');
    }
  });
});

const formatText = (result: Parameters<NonNullable<typeof chemblGetDocuments.format>>[0]) =>
  (chemblGetDocuments.format!(result)[0] as { text: string }).text;

describe('chembl_get_documents format()', () => {
  it('renders every field of each document in request order, then both ID lists', () => {
    const text = formatText({
      documents: [HANAN_2014_OUT, ATR_PATENT, { ...PUBCHEM_DATASET, first_page: 'e12' }],
      not_found_ids: ['CHEMBL25', 'CHEMBL99999999901'],
      deferred_ids: ['CHEMBL2'],
    });
    expect(text.split('\n')).toEqual([
      '**CHEMBL3351701** · PUBLICATION',
      `Title: ${HANAN_2014_OUT.title}`,
      `Authors: ${HANAN_2014_OUT.authors}`,
      'Journal: J Med Chem | Year: 2014 | Volume: 57 | Issue: 23 | Pages: 10176–10191',
      'PMID: 25383627 | DOI: 10.1021/jm501578n | Patent: —',
      '',
      '**CHEMBL3638439** · PATENT',
      'Title: Compounds Useful as Inhibitors of ATR Kinase',
      'Authors: —',
      'Journal: — | Year: 2013 | Volume: — | Issue: — | Pages: —',
      'PMID: — | DOI: — | Patent: US-20130089624-A1',
      '',
      '**CHEMBL1201862** · DATASET',
      'Title: PubChem BioAssay data set',
      'Authors: —',
      'Journal: — | Year: — | Volume: — | Issue: — | Pages: e12–—',
      'PMID: — | DOI: — | Patent: —',
      '',
      'Not found: CHEMBL25, CHEMBL99999999901',
      'Deferred: CHEMBL2',
    ]);
  });

  it('renders — for every absent field of a bare record, and none for empty ID lists', () => {
    const text = formatText({
      documents: [
        {
          document_chembl_id: 'CHEMBL1',
          doc_type: null,
          title: null,
          authors: null,
          journal: null,
          year: null,
          volume: null,
          issue: null,
          first_page: null,
          last_page: null,
          pubmed_id: null,
          doi: null,
          patent_id: null,
        },
      ],
      not_found_ids: [],
      deferred_ids: [],
    });
    expect(text.split('\n')).toEqual([
      '**CHEMBL1** · —',
      'Title: —',
      'Authors: —',
      'Journal: — | Year: — | Volume: — | Issue: — | Pages: —',
      'PMID: — | DOI: — | Patent: —',
      '',
      'Not found: none',
      'Deferred: none',
    ]);
  });

  it.each([
    '[125I](R)-DOI binding to *rat* cortical 5-HT2 receptors',
    '# Heading-like title',
    '1. numbered',
    'two _under_ words<br>with a tag',
    String.raw`a backslash \* before punctuation`,
    'first line\n# second line',
  ])('renders the title %j and every other upstream string as the text recorded', (title) => {
    const text = formatText({
      documents: [
        {
          document_chembl_id: 'CHEMBL1',
          doc_type: '_PUBLICATION_',
          title,
          authors: 'Doe *J*, Roe [R](x).',
          journal: 'J `Med` Chem',
          year: 2014,
          volume: '<b>57</b>',
          issue: '2_3_',
          first_page: '[1]',
          last_page: '9*',
          pubmed_id: '12345',
          doi: '10.1000/a_b_[c](d)',
          patent_id: 'US-&amp;-B2',
        },
      ],
      not_found_ids: [],
      deferred_ids: [],
    });
    const parsed = parseMarkdown(text);
    expect(parsed.text).toBe(
      [
        'CHEMBL1 · _PUBLICATION_',
        `Title: ${title}`,
        'Authors: Doe *J*, Roe [R](x).',
        'Journal: J `Med` Chem | Year: 2014 | Volume: <b>57</b> | Issue: 2_3_ | Pages: [1]–9*',
        'PMID: 12345 | DOI: 10.1000/a_b_[c](d) | Patent: US-&amp;-B2',
        'Not found: none',
        'Deferred: none',
      ].join('\n'),
    );
    expect(markupNodes(parsed.nodes)).toEqual([]);
  });

  it('keeps structuredContent as recorded while content[] reads back the same text', async () => {
    const title = 'Affinity of [3H](S)-ligands for *rat* 5-HT2 receptors';
    fetchMock.mockImplementation(fakeDocumentList([rawDocument('CHEMBL1123456', { title })]));
    const result = await runToolContract(chemblGetDocuments, {
      document_chembl_ids: ['CHEMBL1123456'],
    });
    expect(result.structuredContent).toEqual({
      documents: [
        {
          document_chembl_id: 'CHEMBL1123456',
          doc_type: 'PUBLICATION',
          title,
          authors: 'Doe J, Roe R.',
          journal: 'J Med Chem',
          year: 2014,
          volume: '57',
          issue: '23',
          first_page: '1',
          last_page: '9',
          pubmed_id: '12345',
          doi: '10.1021/chembl1123456',
          patent_id: null,
        },
      ],
      not_found_ids: [],
      deferred_ids: [],
    });
    const content = result.content.map((block) => (block as { text: string }).text).join('');
    const { text, nodes } = parseMarkdown(content);
    expect(text).toBe(
      [
        'CHEMBL1123456 · PUBLICATION',
        `Title: ${title}`,
        'Authors: Doe J, Roe R.',
        'Journal: J Med Chem | Year: 2014 | Volume: 57 | Issue: 23 | Pages: 1–9',
        'PMID: 12345 | DOI: 10.1021/chembl1123456 | Patent: —',
        'Not found: none',
        'Deferred: none',
      ].join('\n'),
    );
    expect(markupNodes(nodes)).toEqual([]);
  });
});
