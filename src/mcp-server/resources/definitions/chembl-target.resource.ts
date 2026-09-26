/**
 * @fileoverview chembl://target/{chemblId} — a target record by ChEMBL target
 * ID: pref_name, type, organism, and component UniProt accessions + gene
 * symbols. A convenience injectable-context mirror of the per-target fetch;
 * fully covered by the tool surface.
 * @module mcp-server/resources/definitions/chembl-target
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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

  handler(params, ctx) {
    return getChemblService().getTarget(params.chemblId, ctx);
  },

  examples: [{ name: 'EGFR', uri: 'chembl://target/CHEMBL203' }],
});
