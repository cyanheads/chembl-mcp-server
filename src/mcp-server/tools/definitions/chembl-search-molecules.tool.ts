/**
 * @fileoverview chembl_search_molecules — the discovery entry point. Finds
 * compounds by name / ChEMBL ID / InChIKey (search_type=name), or runs a
 * structure search (exact | similarity | substructure) from a SMILES. Surfaces
 * max_phase on every row as the cheap druggability signal, and the Tanimoto
 * similarity percent on structure-search results.
 * @module mcp-server/tools/definitions/chembl-search-molecules
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getChemblService } from '@/services/chembl/chembl-service.js';
import type { Molecule, SearchType } from '@/services/chembl/types.js';

const MoleculeSchema = z
  .object({
    molecule_chembl_id: z
      .string()
      .describe(
        'ChEMBL molecule ID, e.g. "CHEMBL25". Pass to chembl_get_bioactivities or chembl_get_drug_info.',
      ),
    pref_name: z
      .string()
      .nullable()
      .describe('Preferred name, e.g. "ASPIRIN". Null for many research compounds.'),
    canonical_smiles: z
      .string()
      .nullable()
      .describe('Canonical SMILES structure. Null when no structure is recorded.'),
    standard_inchi_key: z
      .string()
      .nullable()
      .describe(
        'Standard InChIKey — chain to the pubchem server for richer chemistry. Null when absent.',
      ),
    full_molformula: z
      .string()
      .nullable()
      .describe('Molecular formula, e.g. "C9H8O4". Null when absent.'),
    mw_freebase: z
      .number()
      .nullable()
      .describe('Molecular weight of the free base in g/mol, e.g. 180.16. Null when absent.'),
    alogp: z
      .number()
      .nullable()
      .describe('Calculated AlogP lipophilicity, e.g. 1.31. Null when absent.'),
    num_ro5_violations: z
      .number()
      .nullable()
      .describe('Lipinski rule-of-five violation count (0–4). Null when not computed.'),
    qed_weighted: z
      .number()
      .nullable()
      .describe('QED weighted drug-likeness score, 0–1. Null when not computed.'),
    max_phase: z
      .number()
      .nullable()
      .describe(
        'Max clinical phase: 4 = marketed drug, 0 = research compound. Null when unknown. The cheap druggability signal.',
      ),
    molecule_type: z
      .string()
      .nullable()
      .describe('Molecule type, e.g. "Small molecule". Null when absent.'),
    similarity: z
      .number()
      .nullable()
      .optional()
      .describe(
        'Tanimoto similarity percent (0–100) to the query structure. Present only on similarity/substructure search.',
      ),
  })
  .describe('A compound matched by the search.');

export const chemblSearchMolecules = tool('chembl_search_molecules', {
  title: 'chembl-search-molecules',
  description:
    'Discovery entry point for compounds. Find by name / ChEMBL ID / InChIKey with the default search_type=name (supply query), or run a structure search with search_type exact | similarity | substructure (supply structure as a SMILES). At least one of query or structure is required, and structure is required for the three structure modes. Returns ChEMBL ID, preferred name, canonical SMILES, formula, MW, AlogP, Lipinski violations, QED, and max clinical phase on every row; structure searches also carry a Tanimoto similarity percent. Chain molecule_chembl_id into chembl_get_bioactivities or chembl_get_drug_info.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Search text for search_type=name — a drug name, ChEMBL ID, or InChIKey, e.g. "imatinib" or "CHEMBL25".',
      ),
    structure: z
      .string()
      .optional()
      .describe(
        'SMILES string for structure search, e.g. "CC(=O)Oc1ccccc1C(=O)O". Required when search_type is exact/similarity/substructure.',
      ),
    search_type: z
      .enum(['name', 'exact', 'similarity', 'substructure'])
      .default('name')
      .describe(
        'name = text lookup (query); exact = exact structure match; similarity = Tanimoto ≥ threshold; substructure = contains the structure. All structure modes need `structure`.',
      ),
    similarity_threshold: z
      .number()
      .int()
      .min(40)
      .max(100)
      .default(70)
      .describe(
        'Minimum Tanimoto similarity percent for search_type=similarity (40–100; ChEMBL rejects below 40). Ignored for other modes.',
      ),
    max_phase_min: z
      .number()
      .int()
      .min(0)
      .max(4)
      .optional()
      .describe(
        'For search_type=name, restrict to compounds at or above this max clinical phase (e.g. 4 for marketed drugs only).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum molecules to return. Defaults to the server default (25) when omitted.'),
  }),
  output: z.object({
    molecules: z.array(MoleculeSchema).describe('Matching compounds (up to the limit).'),
  }),
  enrichment: {
    totalCount: z.number().describe('Total compounds matching before the limit was applied.'),
    truncated: z.boolean().describe('True when the result was capped at the limit.'),
    shown: z.number().describe('Number of molecules returned.'),
    cap: z.number().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when nothing matched — echoes the query and suggests how to broaden.'),
  },
  errors: [
    {
      reason: 'missing_input',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither query nor structure was supplied, or a structure search_type was chosen without a structure.',
      recovery:
        'Supply query for name/ID/InChIKey search, or structure (SMILES) with an appropriate search_type for structure search.',
    },
  ],

  async handler(input, ctx) {
    const query = input.query?.trim() || undefined;
    const structure = input.structure?.trim() || undefined;
    const searchType: SearchType = input.search_type;
    const limit = input.limit ?? getServerConfig().defaultLimit;
    const service = getChemblService();

    // Validate the input/mode pairing at the handler level, then fetch within the
    // narrowed branch so the validated value is non-undefined without an assertion.
    let page: { items: Molecule[]; totalCount: number };
    if (searchType === 'name') {
      if (!query) {
        throw ctx.fail('missing_input', 'search_type=name requires a query.', {
          ...ctx.recoveryFor('missing_input'),
        });
      }
      page = await service.searchMolecules({ query, maxPhaseMin: input.max_phase_min, limit }, ctx);
    } else {
      if (!structure) {
        throw ctx.fail(
          'missing_input',
          `search_type=${searchType} requires a structure (SMILES).`,
          {
            ...ctx.recoveryFor('missing_input'),
          },
        );
      }
      page = await service.structureSearch(
        { structure, searchType, similarityThreshold: input.similarity_threshold, limit },
        ctx,
      );
    }

    ctx.enrich.total(page.totalCount);
    if (page.items.length >= limit && page.totalCount > page.items.length) {
      ctx.enrich.truncated({ shown: page.items.length, cap: limit });
    } else {
      ctx.enrich({ truncated: false, shown: page.items.length, cap: limit });
    }
    if (page.items.length === 0) {
      const what =
        searchType === 'name' ? `query "${query}"` : `${searchType} structure "${structure}"`;
      ctx.enrich.notice(
        `No compound matched ${what}. Check spelling/SMILES, lower the similarity threshold, or try a broader name.`,
      );
    }

    return { molecules: page.items };
  },

  format: (result) => {
    if (result.molecules.length === 0) {
      return [{ type: 'text', text: 'No matching compounds.' }];
    }
    const lines = result.molecules.map((m) => {
      const parts = [`**${m.molecule_chembl_id}** — ${m.pref_name ?? '(unnamed)'}`];
      const phase = m.max_phase != null ? `phase ${m.max_phase}` : 'phase —';
      parts.push(
        `${phase} | MW: ${m.mw_freebase ?? '—'} | AlogP: ${m.alogp ?? '—'} | RO5 violations: ${m.num_ro5_violations ?? '—'} | QED: ${m.qed_weighted ?? '—'}`,
      );
      parts.push(`Formula: ${m.full_molformula ?? '—'} | Type: ${m.molecule_type ?? '—'}`);
      parts.push(`SMILES: ${m.canonical_smiles ?? '—'} | InChIKey: ${m.standard_inchi_key ?? '—'}`);
      if (m.similarity != null) parts.push(`Similarity: ${m.similarity}%`);
      return parts.join('\n');
    });
    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
