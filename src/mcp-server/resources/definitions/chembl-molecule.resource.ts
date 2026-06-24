/**
 * @fileoverview chembl://molecule/{chemblId} — a molecule record by ChEMBL ID,
 * the same shape a chembl_search_molecules row carries. A convenience
 * injectable-context mirror of the per-molecule fetch for clients that support
 * resources; fully covered by the tool surface.
 * @module mcp-server/resources/definitions/chembl-molecule
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getChemblService } from '@/services/chembl/chembl-service.js';

export const chemblMoleculeResource = resource('chembl://molecule/{chemblId}', {
  name: 'chembl-molecule',
  title: 'chembl-molecule',
  description:
    'A molecule record by ChEMBL ID — the same shape a chembl_search_molecules row carries (ID, names, structures, properties, max clinical phase). Convenience injectable-context mirror of the per-molecule fetch.',
  mimeType: 'application/json',
  params: z.object({
    chemblId: z
      .string()
      .regex(/^CHEMBL\d+$/, 'Must be a ChEMBL ID like CHEMBL25.')
      .describe('ChEMBL molecule ID, e.g. "CHEMBL25".'),
  }),

  handler(params, ctx) {
    return getChemblService().getMolecule(params.chemblId, ctx);
  },

  examples: [{ name: 'Aspirin', uri: 'chembl://molecule/CHEMBL25' }],
});
