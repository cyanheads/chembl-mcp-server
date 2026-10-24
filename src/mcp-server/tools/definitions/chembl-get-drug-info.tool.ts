/**
 * @fileoverview chembl_get_drug_info — pharmacology for a drug (molecule):
 * mechanism(s) of action, molecular target(s), action type, first-approval year,
 * and clinical indications with max phase, across the drug's family — the parent
 * the molecule record resolves to and its alternate forms. The two lists follow
 * the record through Promise.allSettled, and each reports its retrieval state
 * (complete / truncated / failed) so a bounded or failed list can never read as an
 * authoritative empty one.
 * @module mcp-server/tools/definitions/chembl-get-drug-info
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { moleculeRefInput } from '@/mcp-server/input-normalization.js';
import { mdInline, mdLineStart } from '@/mcp-server/markdown-text.js';
import { getChemblService } from '@/services/chembl/chembl-service.js';
import type { DrugInfo, ListFailure, ListStatus } from '@/services/chembl/types.js';

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
    molecule_chembl_id: z
      .string()
      .nullable()
      .describe(
        'The form of the drug the mechanism is recorded on — the parent, or one of its salts or other alternate forms. Null when ChEMBL names none.',
      ),
  })
  .describe('One mechanism of action linked to its molecular target.');

const IndicationSchema = z
  .object({
    mesh_id: z
      .string()
      .nullable()
      .describe('MeSH descriptor ID, e.g. "D002289". Null when absent.'),
    mesh_heading: z
      .string()
      .nullable()
      .describe('MeSH disease heading, e.g. "Carcinoma, Non-Small-Cell Lung". Null when absent.'),
    efo_id: z
      .string()
      .nullable()
      .describe('EFO ontology ID, e.g. "EFO:0003060". Null when absent.'),
    efo_term: z
      .string()
      .nullable()
      .describe('EFO disease term, e.g. "non-small cell lung carcinoma". Null when absent.'),
    max_phase_for_ind: z
      .number()
      .nullable()
      .describe(
        'Max clinical phase reached for THIS indication (1–4), the highest across the forms it is recorded on. Null when unknown.',
      ),
    forms: z
      .array(
        z
          .object({
            molecule_chembl_id: z
              .string()
              .describe(
                'A form of the drug the indication is recorded on — the parent, or one of its salts or other alternate forms.',
              ),
            max_phase_for_ind: z
              .number()
              .nullable()
              .describe(
                'Max clinical phase THIS form reached for the indication — a deuterated analog can sit lower than its parent. Null when unknown.',
              ),
          })
          .describe('One form the indication is recorded on, at its own phase.'),
      )
      .describe(
        'The forms of the drug the indication is recorded on, each with its own highest phase for it. Empty when ChEMBL names none.',
      ),
  })
  .describe(
    'One clinical indication, listed once per MeSH/EFO pair across the drug and its alternate forms, with the highest phase reached for it and the phase each form reached.',
  );

const ListStatusSchema = z.enum(['complete', 'truncated', 'failed']);

const ListFailureSchema = z.enum(['timeout', 'upstream_error']).nullable();

/**
 * The one place a list's retrieval state is turned into per-list output-field
 * descriptions. `label` is the field prefix; the wording is identical for both
 * lists so an agent learns the contract once.
 */
const statusDescription = (label: 'mechanism' | 'indication') =>
  `Retrieval state of the ${label} list. "complete" = every row ChEMBL records for the molecule and its alternate forms is present, so an empty array is a fact about the molecule. "truncated" = the single-request page cap bounded the list, so the array ${label === 'mechanism' ? 'is a prefix of mechanisms_total_count rows' : 'holds the indications of the rows fetched (indications_rows_fetched, fewer than indications_total_count)'}. "failed" = the list was not retrieved (the request ran out of time or ChEMBL answered with an error, as ${label}s_failure says), so the empty array is unknown data, NOT evidence that none exist — re-call chembl_get_drug_info to retry.`;

/** Per-list description of why a `failed` list failed. */
const failureDescription = (label: 'mechanism' | 'indication') =>
  `Why the ${label} list failed, when ${label}s_status is "failed": "timeout" = the request ran out of time before ChEMBL returned the list; "upstream_error" = ChEMBL answered with an error (a rate limit, a server error, a rejected request) or could not be reached. Null when the list did not fail.`;

const MECHANISMS_TOTAL_DESCRIPTION =
  'Total mechanism rows ChEMBL holds for the molecule and its alternate forms. Exceeds the returned array length exactly when the status is "truncated". Null when the fetch failed — the count is unknown, never 0.';

const INDICATIONS_TOTAL_DESCRIPTION =
  'When the status is "complete", the number of distinct indications — the returned array length, rows recorded on several forms counted once. When "truncated", the indication rows ChEMBL holds for the molecule and its alternate forms, an upper bound on the distinct indications. Null when the fetch failed — the count is unknown, never 0.';

const INDICATIONS_ROWS_FETCHED_DESCRIPTION =
  'Indication rows fetched from ChEMBL for the molecule and its alternate forms, before rows recorded on several forms merge. When the status is "truncated", each row not fetched (indications_total_count minus this) can add at most one indication, so that difference bounds the indications missing. Null when the fetch failed.';

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
      // A mechanism row is one mechanism, so the rows fetched are the ones shown.
      rows: info.mechanisms.length,
      status: info.mechanisms_status,
      total: info.mechanisms_total_count,
      failure: info.mechanisms_failure,
    },
    {
      label: 'indications',
      shown: info.indications.length,
      rows: info.indications_rows_fetched,
      status: info.indications_status,
      total: info.indications_total_count,
      failure: info.indications_failure,
    },
  ];
  const clauses: string[] = [];

  /**
   * A list that ran out of time was never turned away, so it is never worded as
   * ChEMBL rejecting it — one clause per kind of failure, naming its lists.
   */
  for (const kind of ['timeout', 'upstream_error'] as const) {
    const failed = lists.filter((list) => list.status === 'failed' && list.failure === kind);
    if (failed.length === 0) continue;
    const names = failed.map((list) => list.label).join(' and ');
    const several = failed.length > 1;
    const subject = several ? 'those arrays are' : 'that array is';
    clauses.push(
      kind === 'timeout'
        ? `Upstream fetch timed out for ${names} — ${subject} empty because the ${several ? 'requests' : 'request'} ran out of time before ChEMBL returned ${several ? 'them' : 'it'}, not because ${id} has none recorded. Re-call chembl_get_drug_info to retry.`
        : `Upstream fetch failed for ${names} — ${subject} empty because ChEMBL returned an error or could not be reached, not because ${id} has none recorded. Re-call chembl_get_drug_info to retry.`,
    );
  }

  for (const { label, shown, rows, status, total } of lists) {
    // Both counts are non-null whenever the status is truncated; the check narrows the type.
    if (status !== 'truncated' || total === null || rows === null) continue;
    /**
     * An indication total counts rows, several of which merge into one indication,
     * so each unfetched row adds at most one indication — and can raise the phase
     * or add a form of one already shown.
     */
    clauses.push(
      label === 'mechanisms'
        ? `Only ${shown} of ${total} mechanisms were returned — the single-request page cap bounded the list, so the remaining ${total - shown} are not reachable through this tool.`
        : `Only ${shown} indications were returned — the single-request page cap fetched ${rows} of the ${total} indication rows ChEMBL records for this family, so up to ${total - rows} more indications are not reachable through this tool, and each shown indication's max_phase_for_ind and forms are lower bounds: the rows not fetched can raise a phase or add a form.`,
    );
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
  list: {
    failure: ListFailure | null;
    /** Indication rows fetched; mechanisms carry no separate row count. */
    rows?: number | null;
    shown: number;
    status: ListStatus;
    total: number | null;
  },
): string {
  const { failure, rows, shown, status, total } = list;
  let head = `${label}_status: ${status} | ${label}_total_count: ${total ?? '—'}`;
  if (rows !== undefined) head += ` | ${label}_rows_fetched: ${rows ?? '—'}`;
  if (status === 'failed') {
    const why =
      failure === 'timeout'
        ? 'the request ran out of time before ChEMBL returned the list'
        : 'ChEMBL returned an error or could not be reached';
    return `${head} | ${label}_failure: ${failure ?? '—'}\n— not retrieved: ${why}, so this list is unknown, not empty. Re-call to retry.`;
  }
  if (status === 'truncated') {
    return rows === undefined
      ? `${head} — showing ${shown} of ${total}; the remaining ${(total ?? 0) - shown} were not returned`
      : `${head} — showing ${shown}; the page cap fetched ${rows} of the ${total} rows, so up to ${(total ?? 0) - (rows ?? 0)} more were not returned, and the phases and forms shown are lower bounds`;
  }
  return head;
}

export const chemblGetDrugInfo = tool('chembl_get_drug_info', {
  title: 'chembl-get-drug-info',
  description:
    'Pharmacology for a drug (molecule): mechanism(s) of action, the molecular target(s) it acts on, action type (inhibitor / agonist / …), first-approval year, and clinical indications with the max phase reached for each. Supply molecule_chembl_id (from chembl_search_molecules) — a parent or any of its salts and other alternate forms gives the same answer: ChEMBL often records a drug\'s mechanisms and approved indications on a salt, so both lists cover the whole family under parent_molecule_chembl_id. Each mechanism names the form it is recorded on, and each indication is listed once per MeSH/EFO pair at the highest phase any form reached, with the forms it is recorded on, each at its own phase. Distinct from the openfda server\'s label/adverse-event view — this is the curated mechanism-and-indication record. A mechanism\'s target_chembl_id chains into chembl_get_bioactivities for compounds hitting the same target. Each list carries its own retrieval state: an empty mechanisms or indications array means the molecule has none recorded only when the matching mechanisms_status / indications_status is "complete" — "failed" means the list was not retrieved (the request ran out of time or ChEMBL answered with an error, as the matching *_failure says) and the array says nothing about the molecule, and "truncated" means the page cap fetched fewer rows than ChEMBL holds, which the matching *_total_count reports.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    molecule_chembl_id: moleculeRefInput.describe(
      'ChEMBL molecule ID (from chembl_search_molecules), e.g. "CHEMBL939" for gefitinib, or the molecule\'s standard InChIKey, e.g. "XGALLCVXEZPNRQ-UHFFFAOYSA-N". A salt or other alternate form answers with its parent\'s family, the same as the parent.',
    ),
  }),
  output: z.object({
    molecule_chembl_id: z
      .string()
      .describe("The ChEMBL molecule ID queried, as the molecule's own record writes it."),
    parent_molecule_chembl_id: z
      .string()
      .describe(
        "The parent of the queried molecule's family — the molecule itself when it is the parent or ChEMBL records no hierarchy for it. Both lists cover this parent and every alternate form ChEMBL files under it (salts, isotope-labelled and deuterated analogs).",
      ),
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
    mechanisms_total_count: z.number().nullable().describe(MECHANISMS_TOTAL_DESCRIPTION),
    mechanisms_status: ListStatusSchema.describe(statusDescription('mechanism')),
    mechanisms_failure: ListFailureSchema.describe(failureDescription('mechanism')),
    indications: z
      .array(IndicationSchema)
      .describe(
        'Clinical indications. Empty is authoritative only when indications_status is "complete". When "truncated", each indication\'s max_phase_for_ind and forms are lower bounds: rows past the page cap can raise a phase or add a form.',
      ),
    indications_total_count: z.number().nullable().describe(INDICATIONS_TOTAL_DESCRIPTION),
    indications_rows_fetched: z.number().nullable().describe(INDICATIONS_ROWS_FETCHED_DESCRIPTION),
    indications_status: ListStatusSchema.describe(statusDescription('indication')),
    indications_failure: ListFailureSchema.describe(failureDescription('indication')),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Disclosure of anything the two lists do not say for themselves: a list whose upstream fetch timed out or failed (so its emptiness means nothing), a list the page cap bounded, or — only when both lists came back complete and empty — that the molecule may be a research compound rather than a drug.',
      ),
  },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'ChEMBL has no record for the requested identifier or structure.',
      recovery:
        'Verify the ChEMBL ID / SMILES, or discover it via chembl_search_molecules or chembl_search_targets.',
      thrownBy: 'service',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'ChEMBL rate-limits the upstream request.',
      recovery: 'Wait a few seconds and retry.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    // The schema has trimmed the reference and uppercased a ChEMBL ID or InChIKey.
    const info = await getChemblService().getDrugInfo(input.molecule_chembl_id, ctx);
    // One notice writer for both lists and all three states — two independent
    // writers would clobber each other on the single notice string.
    const notice = buildNotice(info.molecule_chembl_id, info);
    if (notice) ctx.enrich.notice(notice);
    return info;
  },

  format: (result) => {
    const lines = [
      `**${mdInline(result.molecule_chembl_id)}** — ${mdInline(result.pref_name ?? '(unnamed)')}`,
    ];
    lines.push(
      `Max phase: ${result.max_phase ?? '—'} | First approval: ${result.first_approval ?? '—'}`,
    );
    lines.push(
      `Parent: ${mdInline(result.parent_molecule_chembl_id)} — both lists cover the parent and its alternate forms`,
    );
    lines.push('');
    lines.push('### Mechanisms of action');
    lines.push(
      renderListState('mechanisms', {
        failure: result.mechanisms_failure,
        shown: result.mechanisms.length,
        status: result.mechanisms_status,
        total: result.mechanisms_total_count,
      }),
    );
    if (result.mechanisms.length === 0) {
      if (result.mechanisms_status === 'complete') lines.push('— none recorded');
    } else {
      // A list item's content begins a line, so its leading string takes the line-start escape.
      for (const m of result.mechanisms) {
        lines.push(
          `- ${mdLineStart(m.mechanism_of_action ?? '—')} (${mdInline(m.action_type ?? '—')}) → target ${mdInline(m.target_chembl_id ?? '—')} — recorded on ${mdInline(m.molecule_chembl_id ?? '—')}`,
        );
      }
    }
    lines.push('');
    lines.push('### Indications');
    lines.push(
      renderListState('indications', {
        failure: result.indications_failure,
        rows: result.indications_rows_fetched,
        shown: result.indications.length,
        status: result.indications_status,
        total: result.indications_total_count,
      }),
    );
    if (result.indications.length === 0) {
      if (result.indications_status === 'complete') lines.push('— none recorded');
    } else {
      for (const i of result.indications) {
        const forms = i.forms
          .map((f) => `${mdInline(f.molecule_chembl_id)} (phase ${f.max_phase_for_ind ?? '—'})`)
          .join(', ');
        lines.push(
          `- ${mdLineStart(i.mesh_heading ?? '—')} [MeSH ${mdInline(i.mesh_id ?? '—')}] / EFO: ${mdInline(i.efo_term ?? '—')} [${mdInline(i.efo_id ?? '—')}] (max phase ${i.max_phase_for_ind ?? '—'}) — recorded on ${forms || '—'}`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
