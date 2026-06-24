/**
 * @fileoverview chembl://target/{chemblId} — a target record by ChEMBL target
 * ID: pref_name, type, organism, and component UniProt accessions + gene
 * symbols. A convenience injectable-context mirror of the per-target fetch;
 * fully covered by the tool surface.
 * @module mcp-server/resources/definitions/chembl-target
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getChemblService } from '@/services/chembl/chembl-service.js';

export const chemblTargetResource = resource('chembl://target/{chemblId}', {
  name: 'chembl-target',
  title: 'chembl-target',
  description:
    'A target record by ChEMBL target ID — pref_name, type, organism, and component UniProt accessions + gene symbols. Convenience injectable-context mirror of the per-target fetch.',
  mimeType: 'application/json',
  params: z.object({
    chemblId: z
      .string()
      .regex(/^CHEMBL\d+$/, 'Must be a ChEMBL ID like CHEMBL203.')
      .describe('ChEMBL target ID, e.g. "CHEMBL203".'),
  }),

  handler(params, ctx) {
    ctx.log.debug('Fetching target resource', { chemblId: params.chemblId });
    return getChemblService().getTarget(params.chemblId, ctx);
  },

  examples: [{ name: 'EGFR', uri: 'chembl://target/CHEMBL203' }],
});
