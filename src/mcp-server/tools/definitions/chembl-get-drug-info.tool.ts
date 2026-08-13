/**
 * @fileoverview chembl_get_drug_info — pharmacology for a drug (molecule):
 * mechanism(s) of action, molecular target(s), action type, first-approval year,
 * and clinical indications with max phase. Composes molecule + mechanisms +
 * indications with Promise.allSettled, and reports each list's retrieval state
 * (complete / truncated / failed) so a bounded or failed list can never read as an
 * authoritative empty one.
 * @module mcp-server/tools/definitions/chembl-get-drug-info
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getChemblService } from '@/services/chembl/chembl-service.js';
import type { DrugInfo, ListStatus } from '@/services/chembl/types.js';

const MechanismSchema = z
  .object({
    target_chembl_id: z
      .string()
      .nullable()
      .describe(
        'ChEMBL target ID the mechanism acts on — chain to chembl_get_bioactivities. Null when unspecified.',
      ),
    mechanism_of_action: z
      .string()
      .nullable()
      .describe(
        'Mechanism of action, e.g. "Epidermal growth factor receptor erbB1 inhibitor". Null when absent.',
      ),
    action_type: z
      .string()
      .nullable()
      .describe('Action type, e.g. "INHIBITOR", "AGONIST", "ANTAGONIST". Null when absent.'),
  })
  .describe('One mechanism of action linked to its molecular target.');

const IndicationSchema = z
  .object({
    mesh_heading: z
      .string()
      .nullable()
      .describe('MeSH disease heading, e.g. "Carcinoma, Non-Small-Cell Lung". Null when absent.'),
    efo_term: z
      .string()
      .nullable()
      .describe('EFO disease term, e.g. "non-small cell lung carcinoma". Null when absent.'),
    max_phase_for_ind: z
      .number()
      .nullable()
      .describe('Max clinical phase reached for THIS indication (1–4). Null when unknown.'),
  })
  .describe('One clinical indication with the phase reached for it.');

const ListStatusSchema = z.enum(['complete', 'truncated', 'failed']);

/**
 * The one place a list's retrieval state is turned into per-list output-field
 * descriptions. `label` is the field prefix; the wording is identical for both
 * lists so an agent learns the contract once.
 */
const statusDescription = (label: 'mechanism' | 'indication') =>
  `Retrieval state of the ${label} list. "complete" = every row ChEMBL records is present, so an empty array is a fact about the molecule. "truncated" = the single-request page cap bounded the list, so the array is a prefix of ${label}s_total_count rows. "failed" = the upstream request was rejected, so the empty array is unknown data, NOT evidence that none exist — re-call chembl_get_drug_info to retry.`;

const totalDescription = (label: 'mechanism' | 'indication') =>
  `Total ${label} rows ChEMBL holds for this molecule (upstream page_meta.total_count). Exceeds the returned array length exactly when the status is "truncated". Null when the fetch failed — the count is unknown, never 0.`;

/**
 * Compose the single agent-facing notice from the two per-list states. Both lists
 * write here and nowhere else, so a truncation disclosure can never be clobbered
 * by a failure disclosure or the reverse — and the research-compound reading is
 * asserted only when BOTH lists came back complete and empty, since an upstream
 * failure is not evidence about the molecule.
 */
function buildNotice(id: string, info: DrugInfo): string | undefined {
  const lists = [
    {
      label: 'mechanisms',
      shown: info.mechanisms.length,
      status: info.mechanisms_status,
      total: info.mechanisms_total_count,
    },
    {
      label: 'indications',
      shown: info.indications.length,
      status: info.indications_status,
      total: info.indications_total_count,
    },
  ];
  const clauses: string[] = [];

  const failed = lists.filter((list) => list.status === 'failed');
  if (failed.length > 0) {
    const names = failed.map((list) => list.label).join(' and ');
    const subject = failed.length > 1 ? 'those arrays are' : 'that array is';
    clauses.push(
      `Upstream fetch failed for ${names} — ${subject} empty because ChEMBL rejected the request, not because ${id} has none recorded. Re-call chembl_get_drug_info to retry.`,
    );
  }

  for (const { label, shown, status, total } of lists) {
    // `total` is non-null whenever the status is truncated; the check narrows the type.
    if (status === 'truncated' && total !== null) {
      clauses.push(
        `Only ${shown} of ${total} ${label} were returned — the single-request page cap bounded the list, so the remaining ${total - shown} are not reachable through this tool.`,
      );
    }
  }

  // The research-compound reading is a claim about the molecule, so it is only
  // available when both lists were actually retrieved and came back empty.
  if (lists.every((list) => list.status === 'complete' && list.shown === 0)) {
    clauses.push(
      `No mechanisms or indications recorded for ${id} (max_phase ${info.max_phase ?? '—'}). It may be a research compound rather than an approved drug — use chembl_get_bioactivities to see what it hits.`,
    );
  }

  return clauses.join(' ') || undefined;
}

/**
 * The per-list state line on the text surface, in the same `key: value | key: value`
 * idiom chembl_get_bioactivities uses — so a truncated or failed list reads as one
 * on `content[]`, not only in `structuredContent`.
 */
function renderListState(
  label: 'mechanisms' | 'indications',
  status: ListStatus,
  total: number | null,
  shown: number,
): string {
  const head = `${label}_status: ${status} | ${label}_total_count: ${total ?? '—'}`;
  if (status === 'failed') {
    return `${head}\n— not retrieved: the upstream request failed, so this list is unknown, not empty. Re-call to retry.`;
  }
  if (status === 'truncated') {
    return `${head} — showing ${shown} of ${total}; the remaining ${(total ?? 0) - shown} were not returned`;
  }
  return head;
}

export const chemblGetDrugInfo = tool('chembl_get_drug_info', {
  title: 'chembl-get-drug-info',
  description:
    'Pharmacology for a drug (molecule): mechanism(s) of action, the molecular target(s) it acts on, action type (inhibitor / agonist / …), first-approval year, and clinical indications with the max phase reached for each. Supply molecule_chembl_id (from chembl_search_molecules). Distinct from the openfda server\'s label/adverse-event view — this is the curated mechanism-and-indication record. A mechanism\'s target_chembl_id chains into chembl_get_bioactivities for compounds hitting the same target. Each list carries its own retrieval state: an empty mechanisms or indications array means the molecule has none recorded only when the matching mechanisms_status / indications_status is "complete" — "failed" means the upstream request was rejected and the array says nothing about the molecule, and "truncated" means the page cap bounded the list at fewer rows than the matching *_total_count.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    molecule_chembl_id: z
      .string()
      .min(1)
      .describe(
        'ChEMBL molecule ID (from chembl_search_molecules), e.g. "CHEMBL939" for gefitinib.',
      ),
  }),
  output: z.object({
    molecule_chembl_id: z.string().describe('The ChEMBL molecule ID queried.'),
    pref_name: z
      .string()
      .nullable()
      .describe('Preferred drug name, e.g. "GEFITINIB". Null when unnamed.'),
    max_phase: z
      .number()
      .nullable()
      .describe('Max clinical phase across indications: 4 = marketed. Null when unknown.'),
    first_approval: z
      .number()
      .nullable()
      .describe('Year of first approval, e.g. 2003. Null when unapproved or unknown.'),
    mechanisms: z
      .array(MechanismSchema)
      .describe(
        'Mechanisms of action. Empty is authoritative only when mechanisms_status is "complete".',
      ),
    mechanisms_total_count: z.number().nullable().describe(totalDescription('mechanism')),
    mechanisms_status: ListStatusSchema.describe(statusDescription('mechanism')),
    indications: z
      .array(IndicationSchema)
      .describe(
        'Clinical indications. Empty is authoritative only when indications_status is "complete".',
      ),
    indications_total_count: z.number().nullable().describe(totalDescription('indication')),
    indications_status: ListStatusSchema.describe(statusDescription('indication')),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Disclosure of anything the two lists do not say for themselves: a list whose upstream fetch failed (so its emptiness means nothing), a list the page cap bounded, or — only when both lists came back complete and empty — that the molecule may be a research compound rather than a drug.',
      ),
  },

  async handler(input, ctx) {
    const id = input.molecule_chembl_id.trim();
    const info = await getChemblService().getDrugInfo(id, ctx);
    // One notice writer for both lists and all three states — two independent
    // writers would clobber each other on the single notice string.
    const notice = buildNotice(id, info);
    if (notice) ctx.enrich.notice(notice);
    return info;
  },

  format: (result) => {
    const lines = [`**${result.molecule_chembl_id}** — ${result.pref_name ?? '(unnamed)'}`];
    lines.push(
      `Max phase: ${result.max_phase ?? '—'} | First approval: ${result.first_approval ?? '—'}`,
    );
    lines.push('');
    lines.push('### Mechanisms of action');
    lines.push(
      renderListState(
        'mechanisms',
        result.mechanisms_status,
        result.mechanisms_total_count,
        result.mechanisms.length,
      ),
    );
    if (result.mechanisms.length === 0) {
      if (result.mechanisms_status === 'complete') lines.push('— none recorded');
    } else {
      for (const m of result.mechanisms) {
        lines.push(
          `- ${m.mechanism_of_action ?? '—'} (${m.action_type ?? '—'}) → target ${m.target_chembl_id ?? '—'}`,
        );
      }
    }
    lines.push('');
    lines.push('### Indications');
    lines.push(
      renderListState(
        'indications',
        result.indications_status,
        result.indications_total_count,
        result.indications.length,
      ),
    );
    if (result.indications.length === 0) {
      if (result.indications_status === 'complete') lines.push('— none recorded');
    } else {
      for (const i of result.indications) {
        lines.push(
          `- ${i.mesh_heading ?? '—'} / EFO: ${i.efo_term ?? '—'} (max phase ${i.max_phase_for_ind ?? '—'})`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
