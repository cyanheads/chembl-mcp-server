/**
 * @fileoverview chembl_get_documents — the publication, patent, or deposited
 * dataset behind ChEMBL document IDs, for one document or a shortlist, in one
 * upstream request: type, title, authors, journal, year, volume, issue, pages,
 * PubMed ID, DOI, and patent number. Call it to cite the document a bioactivity
 * row or an assay record names. An ID with no document record and an ID past the
 * per-call cap are results, never errors.
 * @module mcp-server/tools/definitions/chembl-get-documents
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { chemblIdListInput, ID_LIST_CEILING } from '@/mcp-server/input-normalization.js';
import { mdInline } from '@/mcp-server/markdown-text.js';
import { getChemblService, ID_LOOKUP_CAP } from '@/services/chembl/chembl-service.js';

const DocumentSchema = z
  .object({
    document_chembl_id: z.string().describe('ChEMBL document ID.'),
    doc_type: z
      .string()
      .nullable()
      .describe(
        'PUBLICATION (a journal article), PATENT, DATASET (a deposited dataset, e.g. a PubChem BioAssay set), or BOOK. Null when absent.',
      ),
    title: z.string().nullable().describe('Title as ChEMBL records it. Null when absent.'),
    authors: z
      .string()
      .nullable()
      .describe(
        'Author list as ChEMBL records it, e.g. "Knight ZA, Shokat KM.". Null when ChEMBL records none, as for patents and many datasets.',
      ),
    journal: z
      .string()
      .nullable()
      .describe(
        'Journal abbreviation, e.g. "J Med Chem". Null when ChEMBL records none, as for patents and nearly every dataset.',
      ),
    year: z
      .number()
      .nullable()
      .describe(
        'Publication year, e.g. 2014. Null when ChEMBL records none, as for many datasets.',
      ),
    volume: z
      .string()
      .nullable()
      .describe('Journal volume as recorded, e.g. "57". Null when absent.'),
    issue: z
      .string()
      .nullable()
      .describe('Journal issue as recorded, e.g. "23". Null when absent.'),
    first_page: z
      .string()
      .nullable()
      .describe('First page as recorded, e.g. "10176". Null when absent.'),
    last_page: z
      .string()
      .nullable()
      .describe('Last page as recorded, e.g. "10191". Null when absent.'),
    pubmed_id: z
      .string()
      .nullable()
      .describe(
        'PubMed ID as a digit string, e.g. "25383627" — pass it to a PubMed server for the abstract. Null for patents, most datasets, and some publications.',
      ),
    doi: z
      .string()
      .nullable()
      .describe(
        'DOI, e.g. "10.1021/jm501578n"; a dataset deposited with ChEMBL carries a ChEMBL-minted 10.6019/ DOI. Null when absent.',
      ),
    patent_id: z
      .string()
      .nullable()
      .describe('Patent number, e.g. "US-8470888-B2". Null for anything but a patent.'),
  })
  .describe('One document: the publication, patent, or dataset and how to cite it.');

/** `n` with its noun, plural unless 1: "1 ID", "3 IDs". */
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * The one notice for the IDs with no record and the IDs past the cap, or
 * undefined when there are neither. `ctx.enrich.notice()` keeps only its last
 * call, so both clauses go out together.
 */
function buildNotice(found: number, notFound: number, deferred: number): string | undefined {
  const clauses: string[] = [];
  if (notFound > 0) {
    clauses.push(
      `No document record in ChEMBL for ${notFound} of ${count(found + notFound, 'ID')} looked up (not_found_ids) — document IDs come from the document_chembl_id of chembl_get_bioactivities rows and chembl_get_assay records; a compound, target, or assay ID matches none.`,
    );
  }
  if (deferred > 0) {
    clauses.push(
      `Not looked up: ${count(deferred, 'ID')} past the first ${ID_LOOKUP_CAP} distinct (deferred_ids) — call again with deferred_ids as document_chembl_ids.`,
    );
  }
  return clauses.join(' ') || undefined;
}

export const chemblGetDocuments = tool('chembl_get_documents', {
  title: 'chembl-get-documents',
  description: `The publication, patent, or deposited dataset behind ChEMBL document IDs, for one document or a shortlist in one call: type, title, authors, journal, year, volume, issue, pages, PubMed ID, DOI, and patent number. Supply document_chembl_ids from the document_chembl_id of chembl_get_bioactivities rows or chembl_get_assay records: the first ${ID_LOOKUP_CAP} distinct IDs are looked up and returned in the order given, the rest come back in deferred_ids to pass again, and an ID with no document record (a compound, target, or assay ID included) is listed in not_found_ids rather than failing the call. Call this to cite a measurement; a pubmed_id or doi chains to a PubMed or Crossref server for the abstract.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    // Each ID parses from any case and surrounding whitespace to the canonical ID;
    // the advertised pattern spells those variants out, since JSON Schema `pattern` takes no flags.
    document_chembl_ids: chemblIdListInput(
      'Must be a ChEMBL document ID like CHEMBL3351701 — take one from a chembl_get_bioactivities row or a chembl_get_assay record.',
    ).describe(
      `ChEMBL document IDs from the document_chembl_id of bioactivity rows or assay records, e.g. ["CHEMBL3351701", "CHEMBL1240298"]: 1–${ID_LIST_CEILING}, any case. The first ${ID_LOOKUP_CAP} distinct IDs are looked up; the rest come back in deferred_ids.`,
    ),
  }),
  // The singular key. The framework renames it and wraps a lone string into the list.
  inputAliases: { document_chembl_id: 'document_chembl_ids' },
  output: z.object({
    documents: z
      .array(DocumentSchema)
      .describe('The documents found, in the order their IDs were given.'),
    not_found_ids: z
      .array(z.string())
      .describe(
        'IDs looked up that ChEMBL holds no document for — an unknown ID, or a compound, target, or assay ID — in the order given. Empty when every ID looked up was found.',
      ),
    deferred_ids: z
      .array(z.string())
      .describe(
        `Distinct IDs past the first ${ID_LOOKUP_CAP}, not looked up, in the order given — pass them as document_chembl_ids in another call. Empty when none.`,
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when not_found_ids or deferred_ids is non-empty: counts each and says where document IDs come from and how to look up the deferred ones.',
      ),
  },

  errors: [
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'ChEMBL rate-limits the upstream request.',
      recovery: 'Wait a few seconds and retry.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    // The schema has trimmed and uppercased every ID.
    const lookup = await getChemblService().getDocuments(input.document_chembl_ids, ctx);
    const notice = buildNotice(
      lookup.items.length,
      lookup.notFoundIds.length,
      lookup.deferredIds.length,
    );
    if (notice) ctx.enrich.notice(notice);
    return {
      documents: lookup.items,
      not_found_ids: lookup.notFoundIds,
      deferred_ids: lookup.deferredIds,
    };
  },

  format: (result) => {
    const blocks = result.documents.map((doc) => {
      const pages =
        doc.first_page === null && doc.last_page === null
          ? '—'
          : `${mdInline(doc.first_page ?? '—')}–${mdInline(doc.last_page ?? '—')}`;
      return [
        `**${mdInline(doc.document_chembl_id)}** · ${mdInline(doc.doc_type ?? '—')}`,
        `Title: ${mdInline(doc.title ?? '—')}`,
        `Authors: ${mdInline(doc.authors ?? '—')}`,
        `Journal: ${mdInline(doc.journal ?? '—')} | Year: ${doc.year ?? '—'} | Volume: ${mdInline(doc.volume ?? '—')} | Issue: ${mdInline(doc.issue ?? '—')} | Pages: ${pages}`,
        `PMID: ${mdInline(doc.pubmed_id ?? '—')} | DOI: ${mdInline(doc.doi ?? '—')} | Patent: ${mdInline(doc.patent_id ?? '—')}`,
      ].join('\n');
    });
    blocks.push(
      `Not found: ${mdInline(result.not_found_ids.join(', ') || 'none')}\nDeferred: ${mdInline(result.deferred_ids.join(', ') || 'none')}`,
    );
    return [{ type: 'text', text: blocks.join('\n\n') }];
  },
});
