/**
 * @fileoverview chembl_get_drug_info — pharmacology for a drug (molecule): the
 * queried form's own max phase and first-approval year, and, across the drug's
 * family (the parent the molecule record resolves to and its alternate forms),
 * mechanism(s) of action, molecular target(s), action type, withdrawal and
 * boxed-warning status with ChEMBL's warning records, and clinical indications
 * with max phase. The three lists and the family's flags follow the record
 * through Promise.allSettled; each list reports its retrieval state (complete /
 * truncated / failed) so a bounded or failed list can never read as an
 * authoritative empty one, and the notice says when the family read failed or was
 * cut short.
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
        'Max clinical phase reached for THIS indication (4 = approved, 3–1 = trial phase, 0.5 = early phase 1, −1 = phase unknown), the highest across the forms it is recorded on. Null when unknown.',
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

const WarningSchema = z
  .object({
    warning_type: z
      .string()
      .nullable()
      .describe(
        '"Withdrawn" (pulled from the market where warning_country says) or "Black Box Warning" (a boxed warning on the label). Null when absent.',
      ),
    warning_class: z
      .string()
      .nullable()
      .describe(
        'Toxicity class, e.g. "cardiotoxicity", "hepatotoxicity". Null when ChEMBL records none.',
      ),
    warning_country: z
      .string()
      .nullable()
      .describe(
        'Where it applies: a country, a semicolon-separated list of them, "Worldwide", or a region such as "European Union". Null when absent.',
      ),
    warning_year: z
      .number()
      .nullable()
      .describe(
        'Year of the withdrawal, e.g. 2004. Null when ChEMBL records none, as on boxed warnings.',
      ),
    warning_description: z
      .string()
      .nullable()
      .describe(
        'Why the drug was withdrawn, e.g. "Risk for heart attack and stroke". Null when ChEMBL records none, as on boxed warnings.',
      ),
    efo_id: z
      .string()
      .nullable()
      .describe('EFO ID of the adverse effect, e.g. "EFO:0000712". Null when unmapped.'),
    efo_term: z
      .string()
      .nullable()
      .describe('EFO term of the adverse effect, e.g. "stroke". Null when unmapped.'),
    molecule_chembl_id: z
      .string()
      .nullable()
      .describe(
        'The form of the drug the record is filed on — the parent, or one of its salts or other alternate forms. Null when ChEMBL names none.',
      ),
    refs: z
      .array(
        z
          .object({
            ref_type: z
              .string()
              .nullable()
              .describe('Source type, e.g. "DailyMed", "FDA", "WHO", "PubMed". Null when absent.'),
            ref_id: z
              .string()
              .nullable()
              .describe(
                'Identifier within the source, e.g. a DailyMed set ID or a PubMed ID. Null when absent.',
              ),
            ref_url: z.string().nullable().describe('Link to the source. Null when absent.'),
          })
          .describe('One source ChEMBL cites for the record.'),
      )
      .describe('The sources ChEMBL cites for the record. Empty when it cites none.'),
  })
  .describe('One withdrawal or boxed-warning record ChEMBL files on a form of the drug.');

const ListStatusSchema = z.enum(['complete', 'truncated', 'failed']);

const ListFailureSchema = z.enum(['timeout', 'upstream_error']).nullable();

/**
 * The one place a list's retrieval state is turned into per-list output-field
 * descriptions. `label` is the field prefix; the wording is identical for every
 * list so an agent learns the contract once. A mechanism or warning row is one
 * item, while indication rows merge across forms, so only the indication list
 * words its truncation by the rows fetched.
 */
const statusDescription = (label: 'mechanism' | 'indication' | 'warning') =>
  `Retrieval state of the ${label} list. "complete" = every row ChEMBL records for the molecule and its alternate forms is present, so an empty array is a fact about the molecule. "truncated" = the single-request page cap bounded the list, so the array ${label === 'indication' ? 'holds the indications of the rows fetched (indications_rows_fetched, fewer than indications_total_count)' : `is a prefix of ${label}s_total_count rows`}. "failed" = the list was not retrieved (the request ran out of time or ChEMBL answered with an error, as ${label}s_failure says), so the empty array is unknown data, NOT evidence that none exist — re-call chembl_get_drug_info to retry.`;

/** Per-list description of why a `failed` list failed. */
const failureDescription = (label: 'mechanism' | 'indication' | 'warning') =>
  `Why the ${label} list failed, when ${label}s_status is "failed": "timeout" = the request ran out of time before ChEMBL returned the list; "upstream_error" = ChEMBL answered with an error (a rate limit, a server error, a rejected request) or could not be reached. Null when the list did not fail.`;

/** The total of a list whose rows are its items, one to one. */
const rowTotalDescription = (label: 'mechanism' | 'warning') =>
  `Total ${label} rows ChEMBL holds for the molecule and its alternate forms. Exceeds the returned array length exactly when the status is "truncated". Null when the fetch failed — the count is unknown, never 0.`;

const INDICATIONS_TOTAL_DESCRIPTION =
  'When the status is "complete", the number of distinct indications — the returned array length, rows recorded on several forms counted once. When "truncated", the indication rows ChEMBL holds for the molecule and its alternate forms, an upper bound on the distinct indications. Null when the fetch failed — the count is unknown, never 0.';

const INDICATIONS_ROWS_FETCHED_DESCRIPTION =
  'Indication rows fetched from ChEMBL for the molecule and its alternate forms, before rows recorded on several forms merge. When the status is "truncated", each row not fetched (indications_total_count minus this) can add at most one indication, so that difference bounds the indications missing. Null when the fetch failed.';

/** What the tool returns: the service's drug info without its family-read state, which the notice reports. */
type DrugInfoOutput = Omit<DrugInfo, 'family_read'>;

/** "a", "a and b", "a, b, and c". */
const LIST_NAMES = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/**
 * Compose the single agent-facing notice from the three per-list states and the
 * family read. Everything writes here and nowhere else, so a truncation disclosure
 * can never be clobbered by a failure disclosure or the reverse — and the
 * research-compound reading is asserted only when the mechanism and indication
 * lists BOTH came back complete and empty, since an upstream failure is not
 * evidence about the molecule.
 */
function buildNotice(
  id: string,
  info: DrugInfoOutput,
  familyRead: DrugInfo['family_read'],
): string | undefined {
  const mechanisms = {
    label: 'mechanisms',
    shown: info.mechanisms.length,
    // A mechanism row is one mechanism, so the rows fetched are the ones shown.
    rows: info.mechanisms.length,
    status: info.mechanisms_status,
    total: info.mechanisms_total_count,
    failure: info.mechanisms_failure,
  };
  const indications = {
    label: 'indications',
    shown: info.indications.length,
    rows: info.indications_rows_fetched,
    status: info.indications_status,
    total: info.indications_total_count,
    failure: info.indications_failure,
  };
  const warnings = {
    label: 'warnings',
    shown: info.warnings.length,
    // A warning row is one warning, as a mechanism row is one mechanism.
    rows: info.warnings.length,
    status: info.warnings_status,
    total: info.warnings_total_count,
    failure: info.warnings_failure,
  };
  const lists = [mechanisms, indications, warnings];
  const clauses: string[] = [];

  /**
   * A list that ran out of time was never turned away, so it is never worded as
   * ChEMBL rejecting it — one clause per kind of failure, naming its lists.
   */
  for (const kind of ['timeout', 'upstream_error'] as const) {
    const failed = lists.filter((list) => list.status === 'failed' && list.failure === kind);
    if (failed.length === 0) continue;
    const names = LIST_NAMES.format(failed.map((list) => list.label));
    const several = failed.length > 1;
    const subject = several ? 'those arrays are' : 'that array is';
    clauses.push(
      kind === 'timeout'
        ? `Upstream fetch timed out for ${names} — ${subject} empty because the ${several ? 'requests' : 'request'} ran out of time before ChEMBL returned ${several ? 'them' : 'it'}, not because ${id} has none recorded. Re-call chembl_get_drug_info to retry.`
        : `Upstream fetch failed for ${names} — ${subject} empty because ChEMBL returned an error or could not be reached, not because ${id} has none recorded. Re-call chembl_get_drug_info to retry.`,
    );
  }

  /**
   * The two flags fold the forms the family read returned into the queried form's
   * own record, so a read that never landed leaves that record answering alone,
   * and one the page cap cut short leaves forms unread. The phase and year are
   * the queried form's own either way.
   */
  if (familyRead.status === 'failed') {
    const cause =
      familyRead.failure === 'timeout'
        ? 'the request ran out of time'
        : 'ChEMBL returned an error or could not be reached';
    clauses.push(
      `The forms of ${id}'s family were not read (${cause}), so withdrawn and black_box_warning reflect only ${id}'s own record — a null flag is unknown, not false. Re-call chembl_get_drug_info to retry.`,
    );
  } else if (familyRead.status === 'truncated') {
    clauses.push(
      `The page cap read only some of the forms of ${id}'s family, so a null withdrawn or black_box_warning is unknown, not false.`,
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
      label === 'indications'
        ? `Only ${shown} indications were returned — the single-request page cap fetched ${rows} of the ${total} indication rows ChEMBL records for this family, so up to ${total - rows} more indications are not reachable through this tool, and each shown indication's max_phase_for_ind and forms are lower bounds: the rows not fetched can raise a phase or add a form.`
        : `Only ${shown} of ${total} ${label} were returned — the single-request page cap bounded the list, so the remaining ${total - shown} are not reachable through this tool.`,
    );
  }

  // The research-compound reading is a claim about the molecule, so it is only
  // available when both pharmacology lists were actually retrieved and came back empty.
  if ([mechanisms, indications].every((list) => list.status === 'complete' && list.shown === 0)) {
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
  label: 'mechanisms' | 'indications' | 'warnings',
  list: {
    failure: ListFailure | null;
    /** Indication rows fetched; mechanisms and warnings carry no separate row count. */
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

/** A flag on the header line, or — when unknown. */
const renderFlag = (flag: boolean | null) => (flag === null ? '—' : String(flag));

/**
 * A URL as a CommonMark link destination in pointy brackets, which holds any
 * character but a line break and an unescaped `<` or `>`. The brackets, the
 * backslash, and `&` (which would open a character reference) take a backslash
 * and a line break is percent-encoded, so a reader parses back the URL as
 * written, percent-encoding only what a URL cannot hold, as `encodeURI` does.
 */
function linkDestination(url: string): string {
  return url
    .replace(/[\\<>&]/g, (char) => `\\${char}`)
    .replace(/\r\n?|\n/g, (lineBreak) => encodeURIComponent(lineBreak));
}

/** One warning as a list item, its cited sources nested under it as links. */
function renderWarning(warning: DrugInfoOutput['warnings'][number]): string[] {
  const lines = [
    `- ${mdLineStart(warning.warning_type ?? '—')} — class: ${mdInline(warning.warning_class ?? '—')} | country: ${mdInline(warning.warning_country ?? '—')} | year: ${warning.warning_year ?? '—'} | description: ${mdInline(warning.warning_description ?? '—')} | EFO: ${mdInline(warning.efo_term ?? '—')} [${mdInline(warning.efo_id ?? '—')}] | recorded on ${mdInline(warning.molecule_chembl_id ?? '—')}`,
  ];
  if (warning.refs.length === 0) lines.push('  - no source recorded');
  for (const ref of warning.refs) {
    const link = ref.ref_url === null ? '—' : `[source](<${linkDestination(ref.ref_url)}>)`;
    lines.push(`  - ${mdLineStart(ref.ref_type ?? '—')} ${mdInline(ref.ref_id ?? '—')} — ${link}`);
  }
  return lines;
}

export const chemblGetDrugInfo = tool('chembl_get_drug_info', {
  title: 'chembl-get-drug-info',
  description:
    'Pharmacology for a drug (molecule): mechanism(s) of action, the molecular target(s) it acts on, action type (inhibitor / agonist / …), max clinical phase, first-approval year, whether it has been withdrawn from a market or carries a boxed warning with ChEMBL\'s withdrawal and boxed-warning records, and clinical indications with the max phase reached for each. A withdrawn drug keeps max_phase 4 — read withdrawn and warnings before taking phase 4 as on the market. Supply molecule_chembl_id (from chembl_search_molecules) — a parent or any of its salts and other alternate forms reads the same family: ChEMBL often records a drug\'s mechanisms, approved indications, and warnings on a salt, so both flags and every list cover the whole family under parent_molecule_chembl_id, isotope-labelled and deuterated analogs included. max_phase and first_approval come from the queried form\'s own record, never from the family, since an analog filed under an approved parent can itself be investigational; re-call with parent_molecule_chembl_id to read them for the parent. Each mechanism and warning names the form it is recorded on, and each indication is listed once per MeSH/EFO pair at the highest phase any form reached, with the forms it is recorded on, each at its own phase. Distinct from the openfda server\'s label/adverse-event view — this is the curated mechanism-and-indication record. A mechanism\'s target_chembl_id chains into chembl_get_bioactivities for compounds hitting the same target. Each list carries its own retrieval state: an empty mechanisms, indications, or warnings array means the molecule has none recorded only when the matching mechanisms_status / indications_status / warnings_status is "complete" — "failed" means the list was not retrieved (the request ran out of time or ChEMBL answered with an error, as the matching *_failure says) and the array says nothing about the molecule, and "truncated" means the page cap fetched fewer rows than ChEMBL holds, which the matching *_total_count reports.',
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
        "The parent of the queried molecule's family — the molecule itself when it is the parent or ChEMBL records no hierarchy for it. Both flags and every list cover this parent and every alternate form ChEMBL files under it (salts, isotope-labelled and deuterated analogs); max_phase and first_approval are the queried molecule's own — pass this ID as molecule_chembl_id for the parent's.",
      ),
    pref_name: z
      .string()
      .nullable()
      .describe('Preferred drug name, e.g. "GEFITINIB". Null when unnamed.'),
    max_phase: z
      .number()
      .nullable()
      .describe(
        "The queried form's own max clinical phase, as its ChEMBL record writes it: 4 = approved, 3–1 = trial phase, 0.5 = early phase 1, −1 = clinical with the phase unknown. Never the family's highest: ChEMBL files deuterated and isotope-labelled analogs under their parent, so the parent's phase would read an investigational analog as approved. A salt can record a lower phase than its parent — re-call with parent_molecule_chembl_id for the parent's own phase. A drug withdrawn from a market keeps 4: read withdrawn and warnings for that. Null when ChEMBL records no clinical development for this form.",
      ),
    first_approval: z
      .number()
      .nullable()
      .describe(
        "The queried form's own year of first approval, e.g. 2003 — never the family's earliest, which would hand a deuterated analog approved years later its parent's year. A withdrawal does not clear it: read withdrawn and warnings for that. Null when this form records none — unapproved, or the year is unknown (ChEMBL records a few drugs' year on a salt alone).",
      ),
    withdrawn: z
      .boolean()
      .nullable()
      .describe(
        "Whether any form of the drug's family has been withdrawn from the market in at least one country — the parent and every form ChEMBL files under it, salts and isotope-labelled and deuterated analogs included; warnings says where, when, and why, and each warning's molecule_chembl_id names the form it is filed on. The drug can still be marketed elsewhere, and a withdrawal never lowers max_phase. Null when no form read carries the flag and not every form could be read, as the notice then says — unknown, never a guessed false.",
      ),
    black_box_warning: z
      .boolean()
      .nullable()
      .describe(
        'Whether any form of the drug\'s family carries a boxed ("black box") warning on its label — the parent and every form ChEMBL files under it, salts and isotope-labelled and deuterated analogs included; warnings names the country and the label cited, and each warning\'s molecule_chembl_id names the form it is filed on. Null when no form read carries the flag and not every form could be read, as the notice then says — unknown, never a guessed false.',
      ),
    mechanisms: z
      .array(MechanismSchema)
      .describe(
        'Mechanisms of action. Empty is authoritative only when mechanisms_status is "complete".',
      ),
    mechanisms_total_count: z.number().nullable().describe(rowTotalDescription('mechanism')),
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
    warnings: z
      .array(WarningSchema)
      .describe(
        'Withdrawal and boxed-warning records filed on the drug and its alternate forms, one per ChEMBL record. Empty is authoritative only when warnings_status is "complete".',
      ),
    warnings_total_count: z.number().nullable().describe(rowTotalDescription('warning')),
    warnings_status: ListStatusSchema.describe(statusDescription('warning')),
    warnings_failure: ListFailureSchema.describe(failureDescription('warning')),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        "Disclosure of anything the lists and the family-level fields do not say for themselves: a list whose upstream fetch timed out or failed (so its emptiness means nothing), a list the page cap bounded, a read of the family's forms that failed or was cut short (so withdrawn and black_box_warning may not cover every form), or — only when the mechanism and indication lists both came back complete and empty — that the molecule may be a research compound rather than a drug.",
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
    const { family_read: familyRead, ...info } = await getChemblService().getDrugInfo(
      input.molecule_chembl_id,
      ctx,
    );
    // One notice writer for every list and the family read — independent writers
    // would clobber each other on the single notice string.
    const notice = buildNotice(info.molecule_chembl_id, info, familyRead);
    if (notice) ctx.enrich.notice(notice);
    return info;
  },

  format: (result) => {
    const lines = [
      `**${mdInline(result.molecule_chembl_id)}** — ${mdInline(result.pref_name ?? '(unnamed)')}`,
    ];
    lines.push(
      `Max phase: ${result.max_phase ?? '—'} | First approval: ${result.first_approval ?? '—'} | Withdrawn: ${renderFlag(result.withdrawn)} | Black box warning: ${renderFlag(result.black_box_warning)}`,
    );
    lines.push(
      `Parent: ${mdInline(result.parent_molecule_chembl_id)} — the phase and approval year are this form's own; both flags and every list below cover the parent and its alternate forms unless the notice says a read failed or was cut short`,
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
    lines.push('');
    lines.push('### Warnings');
    lines.push(
      renderListState('warnings', {
        failure: result.warnings_failure,
        shown: result.warnings.length,
        status: result.warnings_status,
        total: result.warnings_total_count,
      }),
    );
    if (result.warnings.length === 0) {
      if (result.warnings_status === 'complete') lines.push('— none recorded');
    } else {
      for (const warning of result.warnings) lines.push(...renderWarning(warning));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
