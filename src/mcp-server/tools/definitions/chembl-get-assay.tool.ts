/**
 * @fileoverview chembl_get_assay — assay detail for one assay or a shortlist, by
 * assay ChEMBL ID, in one upstream request: the provenance behind bioactivity
 * rows (description, type, BioAssay Ontology format, target, organism, cell type,
 * tissue, strain, source document, and the 0–9 confidence score). Call it to
 * judge whether measurements are comparable. An ID with no assay record and an ID
 * past the per-call cap are results, never errors.
 * @module mcp-server/tools/definitions/chembl-get-assay
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { chemblIdListInput, ID_LIST_CEILING } from '@/mcp-server/input-normalization.js';
import { mdInline, mdLineStart } from '@/mcp-server/markdown-text.js';
import { getChemblService, ID_LOOKUP_CAP } from '@/services/chembl/chembl-service.js';

const AssaySchema = z
  .object({
    assay_chembl_id: z.string().describe('ChEMBL assay ID.'),
    description: z.string().nullable().describe('Assay description text. Null when absent.'),
    assay_type: z
      .string()
      .nullable()
      .describe(
        'Assay type code: B=binding, F=functional, A=ADMET, T=toxicity, P=physicochemical, U=unclassified. Null when absent.',
      ),
    assay_type_description: z
      .string()
      .nullable()
      .describe('Human-readable assay type, e.g. "Binding". Null when absent.'),
    bao_label: z
      .string()
      .nullable()
      .describe(
        'BioAssay Ontology format of the assay, e.g. "single protein format", "cell-based format", "organism-based format", "tissue-based format". Null when absent.',
      ),
    target_chembl_id: z
      .string()
      .nullable()
      .describe(
        'ChEMBL target ID the assay measures — chain to chembl_search_targets/chembl_get_bioactivities. Null when unassigned.',
      ),
    organism: z
      .string()
      .nullable()
      .describe(
        "Organism ChEMBL records for the assay itself, not its target's organism. Null when the assay records none, even when the target is a human protein.",
      ),
    assay_cell_type: z
      .string()
      .nullable()
      .describe(
        'Cell line or cell type the assay ran in, e.g. "A-431". Null when ChEMBL records none, as for most assays that are not cell-based.',
      ),
    assay_tissue: z
      .string()
      .nullable()
      .describe('Tissue the assay ran in, e.g. "Liver", "Plasma". Null when ChEMBL records none.'),
    assay_strain: z
      .string()
      .nullable()
      .describe(
        'Strain of the organism the assay used, e.g. "Sprague-Dawley". Null when ChEMBL records none.',
      ),
    confidence_score: z
      .number()
      .nullable()
      .describe(
        "ChEMBL confidence score, 0–9: 9 = direct single protein target, 8 = homologous single protein, 7–4 = protein complexes or multiple proteins, 3–1 = a non-protein, subcellular, or non-molecular target, 0 = no target assigned yet (ChEMBL's default; target_chembl_id is then a placeholder such as Unchecked or ADMET). Null when absent from the record.",
      ),
    confidence_description: z
      .string()
      .nullable()
      .describe(
        'Human-readable confidence description, e.g. "Direct single protein target assigned". Null when absent.',
      ),
    document_chembl_id: z
      .string()
      .nullable()
      .describe(
        'ChEMBL document ID of the publication or deposited dataset that described the assay, e.g. "CHEMBL3875233" — pass to chembl_get_documents for its title, PMID, and DOI to cite. Null when absent.',
      ),
  })
  .describe('One assay: its provenance and confidence score.');

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
      `No assay record in ChEMBL for ${notFound} of ${count(found + notFound, 'ID')} looked up (not_found_ids) — assay IDs come from the assay_chembl_id of chembl_get_bioactivities rows; a compound, target, or document ID matches none.`,
    );
  }
  if (deferred > 0) {
    clauses.push(
      `Not looked up: ${count(deferred, 'ID')} past the first ${ID_LOOKUP_CAP} distinct (deferred_ids) — call again with deferred_ids as assay_chembl_ids.`,
    );
  }
  return clauses.join(' ') || undefined;
}

export const chemblGetAssay = tool('chembl_get_assay', {
  title: 'chembl-get-assay',
  description: `Assay provenance behind bioactivity rows, for one assay or a shortlist in one call: description, type (binding / functional / ADMET / toxicity), BioAssay Ontology format (single protein, cell-based, organism-based, …), the target it measures, organism, cell type, tissue, strain, source document, and ChEMBL's 0–9 confidence score (9 = direct single protein target, lower = homologous, complex, or non-protein targets, 0 = no target assigned yet). Supply assay_chembl_ids from chembl_get_bioactivities rows: the first ${ID_LOOKUP_CAP} distinct IDs are looked up and returned in the order given, the rest come back in deferred_ids to pass again, and an ID with no assay record (a compound or target ID included) is listed in not_found_ids rather than failing the call. Call this to judge whether measurements are comparable before ranking them together.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    // Each ID parses from any case and surrounding whitespace to the canonical ID;
    // the advertised pattern spells those variants out, since JSON Schema `pattern` takes no flags.
    assay_chembl_ids: chemblIdListInput(
      'Must be a ChEMBL assay ID like CHEMBL674637 — take one from a chembl_get_bioactivities row.',
    ).describe(
      `ChEMBL assay IDs from bioactivity rows' assay_chembl_id, e.g. ["CHEMBL674637", "CHEMBL3877213"]: 1–${ID_LIST_CEILING}, any case. The first ${ID_LOOKUP_CAP} distinct IDs are looked up; the rest come back in deferred_ids.`,
    ),
  }),
  // The singular key. The framework renames it and wraps a lone string into the list.
  inputAliases: { assay_chembl_id: 'assay_chembl_ids' },
  output: z.object({
    assays: z.array(AssaySchema).describe('The assays found, in the order their IDs were given.'),
    not_found_ids: z
      .array(z.string())
      .describe(
        'IDs looked up that ChEMBL holds no assay for — an unknown ID, or a compound, target, or document ID — in the order given. Empty when every ID looked up was found.',
      ),
    deferred_ids: z
      .array(z.string())
      .describe(
        `Distinct IDs past the first ${ID_LOOKUP_CAP}, not looked up, in the order given — pass them as assay_chembl_ids in another call. Empty when none.`,
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when not_found_ids or deferred_ids is non-empty: counts each and says where assay IDs come from and how to look up the deferred ones.',
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
    const lookup = await getChemblService().getAssays(input.assay_chembl_ids, ctx);
    const notice = buildNotice(
      lookup.items.length,
      lookup.notFoundIds.length,
      lookup.deferredIds.length,
    );
    if (notice) ctx.enrich.notice(notice);
    return {
      assays: lookup.items,
      not_found_ids: lookup.notFoundIds,
      deferred_ids: lookup.deferredIds,
    };
  },

  format: (result) => {
    const blocks = result.assays.map((assay) => {
      const lines = [`**${mdInline(assay.assay_chembl_id)}**`];
      // The description begins its line, where a leading `#` or `1.` would open a block.
      if (assay.description) lines.push(mdLineStart(assay.description));
      lines.push(
        `Type: ${mdInline(assay.assay_type_description ?? '—')} (${mdInline(assay.assay_type ?? '—')}) | Target: ${mdInline(assay.target_chembl_id ?? '—')} | Organism: ${mdInline(assay.organism ?? '—')}`,
      );
      lines.push(
        `Confidence: ${assay.confidence_score ?? '—'} (${mdInline(assay.confidence_description ?? '—')})`,
      );
      lines.push(
        `Format: ${mdInline(assay.bao_label ?? '—')} | Cell type: ${mdInline(assay.assay_cell_type ?? '—')} | Tissue: ${mdInline(assay.assay_tissue ?? '—')} | Strain: ${mdInline(assay.assay_strain ?? '—')} | Document: ${mdInline(assay.document_chembl_id ?? '—')}`,
      );
      return lines.join('\n');
    });
    blocks.push(
      `Not found: ${mdInline(result.not_found_ids.join(', ') || 'none')}\nDeferred: ${mdInline(result.deferred_ids.join(', ') || 'none')}`,
    );
    return [{ type: 'text', text: blocks.join('\n\n') }];
  },
});
