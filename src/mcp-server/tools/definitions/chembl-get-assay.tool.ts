/**
 * @fileoverview chembl_get_assay — assay detail by assay ChEMBL ID: the
 * provenance behind a bioactivity row (description, type, target, organism, and
 * the 1–9 confidence score). Call it to judge whether two measurements are
 * comparable.
 * @module mcp-server/tools/definitions/chembl-get-assay
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getChemblService } from '@/services/chembl/chembl-service.js';

export const chemblGetAssay = tool('chembl_get_assay', {
  title: 'chembl-get-assay',
  description:
    "Assay provenance behind a bioactivity row: description, type (binding / functional / ADMET / toxicity), the target it measures, organism, and ChEMBL's 1–9 confidence score (9 = direct assay on the protein target, lower = homologous or indirect). Supply assay_chembl_id from a chembl_get_bioactivities row. Call this to judge whether two measurements are comparable before ranking them together.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    assay_chembl_id: z
      .string()
      .min(1)
      .describe('ChEMBL assay ID from a bioactivity row\'s assay_chembl_id, e.g. "CHEMBL674637".'),
  }),
  output: z.object({
    assay_chembl_id: z.string().describe('The ChEMBL assay ID queried.'),
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
    target_chembl_id: z
      .string()
      .nullable()
      .describe(
        'ChEMBL target ID the assay measures — chain to chembl_search_targets/chembl_get_bioactivities. Null when unassigned.',
      ),
    organism: z.string().nullable().describe('Assay organism. Null when unspecified.'),
    confidence_score: z
      .number()
      .nullable()
      .describe(
        'ChEMBL confidence score, 1–9 (9 = direct single-protein assay; lower = homologous/indirect). Null when unscored.',
      ),
    confidence_description: z
      .string()
      .nullable()
      .describe(
        'Human-readable confidence description, e.g. "Direct single protein target assigned". Null when absent.',
      ),
  }),

  async handler(input, ctx) {
    return await getChemblService().getAssay(input.assay_chembl_id.trim(), ctx);
  },

  format: (result) => {
    const lines = [`**${result.assay_chembl_id}**`];
    if (result.description) lines.push(result.description);
    lines.push(
      `Type: ${result.assay_type_description ?? '—'} (${result.assay_type ?? '—'}) | Target: ${result.target_chembl_id ?? '—'} | Organism: ${result.organism ?? '—'}`,
    );
    lines.push(
      `Confidence: ${result.confidence_score ?? '—'} (${result.confidence_description ?? '—'})`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
