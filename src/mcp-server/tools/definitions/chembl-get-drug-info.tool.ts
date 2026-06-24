/**
 * @fileoverview chembl_get_drug_info — pharmacology for a drug (molecule):
 * mechanism(s) of action, molecular target(s), action type, first-approval year,
 * and clinical indications with max phase. Composes molecule + mechanisms +
 * indications with Promise.allSettled so a missing list degrades gracefully.
 * @module mcp-server/tools/definitions/chembl-get-drug-info
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getChemblService } from '@/services/chembl/chembl-service.js';

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

export const chemblGetDrugInfo = tool('chembl_get_drug_info', {
  title: 'chembl-get-drug-info',
  description:
    "Pharmacology for a drug (molecule): mechanism(s) of action, the molecular target(s) it acts on, action type (inhibitor / agonist / …), first-approval year, and clinical indications with the max phase reached for each. Supply molecule_chembl_id (from chembl_search_molecules). Distinct from the openfda server's label/adverse-event view — this is the curated mechanism-and-indication record. A mechanism's target_chembl_id chains into chembl_get_bioactivities for compounds hitting the same target.",
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
      .describe('Mechanisms of action. Empty when none are recorded.'),
    indications: z
      .array(IndicationSchema)
      .describe('Clinical indications. Empty when none are recorded.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no pharmacology was found — the molecule may be a research compound, not a drug.',
      ),
  },

  async handler(input, ctx) {
    const id = input.molecule_chembl_id.trim();
    const info = await getChemblService().getDrugInfo(id, ctx);
    if (info.mechanisms.length === 0 && info.indications.length === 0) {
      ctx.enrich.notice(
        `No mechanisms or indications recorded for ${id} (max_phase ${info.max_phase ?? '—'}). It may be a research compound rather than an approved drug — use chembl_get_bioactivities to see what it hits.`,
      );
    }
    return info;
  },

  format: (result) => {
    const lines = [`**${result.molecule_chembl_id}** — ${result.pref_name ?? '(unnamed)'}`];
    lines.push(
      `Max phase: ${result.max_phase ?? '—'} | First approval: ${result.first_approval ?? '—'}`,
    );
    lines.push('');
    lines.push('### Mechanisms of action');
    if (result.mechanisms.length === 0) {
      lines.push('— none recorded');
    } else {
      for (const m of result.mechanisms) {
        lines.push(
          `- ${m.mechanism_of_action ?? '—'} (${m.action_type ?? '—'}) → target ${m.target_chembl_id ?? '—'}`,
        );
      }
    }
    lines.push('');
    lines.push('### Indications');
    if (result.indications.length === 0) {
      lines.push('— none recorded');
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
