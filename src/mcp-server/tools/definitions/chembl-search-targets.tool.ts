/**
 * @fileoverview chembl_search_targets — resolve a protein/gene/UniProt accession
 * to the ChEMBL target ID that chembl_get_bioactivities needs. Searches the
 * ChEMBL target resource by free-text name, UniProt accession, gene symbol, and
 * organism, flattening component accessions + gene symbols into each row.
 * @module mcp-server/tools/definitions/chembl-search-targets
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getChemblService } from '@/services/chembl/chembl-service.js';

const TargetComponentSchema = z
  .object({
    accession: z
      .string()
      .nullable()
      .describe(
        'UniProt accession of the protein component, e.g. "P00533". Null when not a protein target.',
      ),
    gene_symbols: z
      .array(z.string().describe('A gene symbol for this component, e.g. "EGFR".'))
      .describe(
        'Gene symbols for this component, flattened from component synonyms. Empty when none are recorded.',
      ),
  })
  .describe('One protein component of the target.');

const TargetSchema = z
  .object({
    target_chembl_id: z
      .string()
      .describe(
        'ChEMBL target ID, e.g. "CHEMBL203". Pass to chembl_get_bioactivities as target_chembl_id.',
      ),
    pref_name: z
      .string()
      .nullable()
      .describe(
        'Preferred target name, e.g. "Epidermal growth factor receptor". Null when unnamed.',
      ),
    target_type: z
      .string()
      .nullable()
      .describe(
        'Target class: "SINGLE PROTEIN", "PROTEIN COMPLEX", "PROTEIN FAMILY", "CELL-LINE", "ORGANISM", etc.',
      ),
    organism: z
      .string()
      .nullable()
      .describe('Source organism, e.g. "Homo sapiens". Null when unspecified.'),
    components: z
      .array(TargetComponentSchema)
      .describe('Protein components with UniProt accessions and gene symbols.'),
  })
  .describe('A ChEMBL target resolved from the supplied protein identifier.');

export const chemblSearchTargets = tool('chembl_search_targets', {
  title: 'chembl-search-targets',
  description:
    'Resolve a protein/gene/UniProt accession to the ChEMBL target ID that chembl_get_bioactivities needs for the target→leads workflow. Supply at least one of accession (UniProt, e.g. P00533), gene_symbol (e.g. EGFR), or query (free-text name); filter further by organism and target_type. Returns each target with its type, organism, and component UniProt accessions + gene symbols. A UniProt accession from the uniprot/protein server is the most precise input.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Free-text name match against the target preferred name, e.g. "kinase" or "growth factor receptor".',
      ),
    accession: z
      .string()
      .optional()
      .describe(
        'UniProt accession of a target component, e.g. "P00533". The most precise resolver — from the uniprot/protein server.',
      ),
    gene_symbol: z
      .string()
      .optional()
      .describe('Gene symbol of a target component, e.g. "EGFR" (case-insensitive exact match).'),
    organism: z
      .string()
      .optional()
      .describe(
        'Restrict to a source organism, e.g. "Homo sapiens" (case-insensitive exact match).',
      ),
    target_type: z
      .string()
      .optional()
      .describe('Restrict to a target class, e.g. "SINGLE PROTEIN" or "PROTEIN COMPLEX".'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum targets to return. Defaults to the server default (25) when omitted.'),
  }),
  output: z.object({
    targets: z.array(TargetSchema).describe('Matching targets (up to the limit).'),
  }),
  enrichment: {
    totalCount: z
      .number()
      .describe('Total targets matching the filters before the limit was applied.'),
    truncated: z.boolean().describe('True when the result was capped at the limit.'),
    shown: z.number().describe('Number of targets returned.'),
    cap: z.number().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no target matched — echoes the filters and suggests how to broaden.',
      ),
  },
  errors: [
    {
      reason: 'missing_input',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'None of query, accession, or gene_symbol was supplied.',
      recovery:
        'Supply at least one: accession (UniProt, e.g. P00533), gene_symbol (e.g. EGFR), or query (free-text name).',
    },
  ],

  async handler(input, ctx) {
    // Zod marks all three optional for form-client compatibility; XOR-style gate
    // here. Guard for empty strings (form clients send "" not undefined).
    const query = input.query?.trim() || undefined;
    const accession = input.accession?.trim() || undefined;
    const geneSymbol = input.gene_symbol?.trim() || undefined;
    if (!query && !accession && !geneSymbol) {
      throw ctx.fail('missing_input', undefined, { ...ctx.recoveryFor('missing_input') });
    }

    const limit = input.limit ?? getServerConfig().defaultLimit;
    const page = await getChemblService().searchTargets(
      {
        query,
        accession,
        geneSymbol,
        organism: input.organism?.trim() || undefined,
        targetType: input.target_type?.trim() || undefined,
        limit,
      },
      ctx,
    );

    ctx.enrich.total(page.totalCount);
    if (page.items.length >= limit && page.totalCount > page.items.length) {
      ctx.enrich.truncated({ shown: page.items.length, cap: limit });
    } else {
      ctx.enrich({ truncated: false, shown: page.items.length, cap: limit });
    }
    if (page.items.length === 0) {
      const filters = [
        accession && `accession="${accession}"`,
        geneSymbol && `gene_symbol="${geneSymbol}"`,
        query && `query="${query}"`,
      ]
        .filter(Boolean)
        .join(', ');
      ctx.enrich.notice(
        `No target matched ${filters}. Verify the accession/symbol, or broaden with a free-text query.`,
      );
    }

    return { targets: page.items };
  },

  format: (result) => {
    if (result.targets.length === 0) {
      return [{ type: 'text', text: 'No matching targets.' }];
    }
    const lines = result.targets.map((t) => {
      const parts = [
        `**${t.target_chembl_id}** — ${t.pref_name ?? '(unnamed)'}`,
        `Type: ${t.target_type ?? '—'} | Organism: ${t.organism ?? '—'}`,
      ];
      for (const c of t.components) {
        const genes = c.gene_symbols.length > 0 ? c.gene_symbols.join(', ') : '—';
        parts.push(`  • accession ${c.accession ?? '—'} | genes: ${genes}`);
      }
      return parts.join('\n');
    });
    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
