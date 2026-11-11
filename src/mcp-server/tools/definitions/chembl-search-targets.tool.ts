/**
 * @fileoverview chembl_search_targets — resolve a protein/gene/UniProt accession
 * to the ChEMBL target ID that chembl_get_bioactivities needs. Searches the
 * ChEMBL target resource by free-text name or ChEMBL target ID, UniProt accession,
 * gene symbol, organism, and target type, flattening component accessions + gene
 * symbols into each row. A zero-hit notice names every filter sent and steers
 * organism and target_type to the forms ChEMBL records.
 * @module mcp-server/tools/definitions/chembl-search-targets
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  clampLimit,
  isChemblId,
  LIMIT_CEILING,
  optionalCodeInput,
} from '@/mcp-server/input-normalization.js';
import { mdInline } from '@/mcp-server/markdown-text.js';
import { getChemblService } from '@/services/chembl/chembl-service.js';

/** The most targets one call returns; a larger `limit` is served at this cap. */
const MAX_LIMIT = 100;

/** The filters a target search sent, as the handler resolved them. */
interface SentFilters {
  accession: string | undefined;
  geneSymbol: string | undefined;
  nameQuery: string | undefined;
  organism: string | undefined;
  targetChemblId: string | undefined;
  targetType: string | undefined;
}

/** The form each narrowing filter must take to match: both are exact against ChEMBL's vocabulary. */
const ORGANISM_FORM = 'the scientific name ChEMBL records, e.g. "Homo sapiens", not a common name';
const TARGET_TYPE_FORM = 'one full target class exactly, e.g. "SINGLE PROTEIN"';

/** Two or three phrases as prose: "a and b", "a, b, and c". */
function joinAnd(items: string[]): string {
  return items.length <= 2
    ? items.join(' and ')
    : `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

/**
 * What a zero-hit target search tries next. `organism` and `target_type` match
 * forms a caller rarely guesses (the scientific name, the full class), so either
 * one sent is the first filter to drop; the advice after it names only the
 * identifiers the call sent. The handler's at-least-one gate means some
 * identifier was sent.
 */
function zeroHitAdvice(sent: SentFilters): string {
  const checks = [
    sent.accession && 'the accession',
    sent.geneSymbol && 'the gene symbol',
    sent.targetChemblId && 'the target ID',
  ].filter((check): check is string => Boolean(check));
  const advice = [
    checks.length > 0 ? `verify ${joinAnd(checks)}` : undefined,
    sent.nameQuery ? 'check the spelling or broaden the name query' : undefined,
  ]
    .filter(Boolean)
    .join(', or ');
  let retry: string | undefined;
  if (sent.organism && sent.targetType) {
    retry = `Retry without organism and target_type first: organism matches ${ORGANISM_FORM}, and target_type matches ${TARGET_TYPE_FORM}.`;
  } else if (sent.organism) {
    retry = `Retry without organism first: it matches ${ORGANISM_FORM}.`;
  } else if (sent.targetType) {
    retry = `Retry without target_type first: it matches ${TARGET_TYPE_FORM}.`;
  }
  return retry
    ? `${retry} Otherwise ${advice}.`
    : `${advice.charAt(0).toUpperCase()}${advice.slice(1)}.`;
}

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
    'Resolve a protein/gene/UniProt accession to the ChEMBL target ID that chembl_get_bioactivities needs for the target→leads workflow. Supply at least one of accession (UniProt, e.g. P00533), gene_symbol (e.g. EGFR), or query (free-text name, or a ChEMBL target ID such as CHEMBL203 to read that one target); filter further by organism and target_type. Returns each target with its type, organism, and component UniProt accessions + gene symbols. A UniProt accession from the uniprot/protein server is the most precise input. A capped result carries nextCursor — pass it back as cursor with the same filters to read the next page.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Free-text name match against the target preferred name, e.g. "kinase" or "growth factor receptor" — or a ChEMBL target ID in any case, e.g. "CHEMBL203", which returns that one target.',
      ),
    accession: optionalCodeInput.describe(
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
        'Restrict to a source organism by the scientific name ChEMBL records, e.g. "Homo sapiens" (case-insensitive exact match) — a common name such as "human" matches nothing.',
      ),
    target_type: optionalCodeInput.describe(
      'Restrict to one target class, named in full, e.g. "SINGLE PROTEIN" or "PROTEIN COMPLEX" (exact match on the whole class, case-insensitive here) — a partial class such as "PROTEIN" matches nothing.',
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIMIT_CEILING)
      .optional()
      .describe(
        'Maximum targets to return, up to 100 — a larger value is served at 100, with a notice saying so. Defaults to the server default (25) when omitted.',
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        "Opaque continuation token from a previous call's nextCursor — resumes where that page ended. Omit for the first page. Re-send the same accession/gene_symbol/query/filters that minted it (only limit may change; it sets this page's size); redeeming it against different filters walks a different result set.",
      ),
  }),
  output: z.object({
    targets: z.array(TargetSchema).describe('Matching targets (up to the limit).'),
    nextCursor: z
      .string()
      .optional()
      .describe(
        'Opaque token for the next page — pass it back as cursor with the same filters. Absent when this page is the last one.',
      ),
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
        'Guidance when no target matched — echoes every filter sent, names the organism or target_type form ChEMBL matches, and suggests how to broaden — and the disclosure that a limit above the maximum was served at the maximum.',
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
    {
      reason: 'missing_input',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'None of query, accession, or gene_symbol was supplied.',
      recovery:
        'Supply at least one: accession (UniProt, e.g. P00533), gene_symbol (e.g. EGFR), or query (free-text name or ChEMBL target ID).',
    },
  ],

  async handler(input, ctx) {
    // Zod marks all three optional for form-client compatibility; the at-least-one
    // gate lives here. Any combination is valid — the three AND upstream, so extra
    // ones narrow. Guard for empty strings (form clients send "" not undefined).
    const query = input.query?.trim() || undefined;
    /**
     * A query that is a ChEMBL ID in any case names one target. No preferred name
     * contains "CHEMBL", so routing it to the exact, case-sensitive
     * `target_chembl_id` filter instead of the name match loses no match.
     */
    const targetChemblId =
      query && isChemblId(query.toUpperCase()) ? query.toUpperCase() : undefined;
    const nameQuery = targetChemblId ? undefined : query;
    // Every accession and target type ChEMBL records is uppercase; the schema has trimmed and uppercased both.
    const accession = input.accession;
    const geneSymbol = input.gene_symbol?.trim() || undefined;
    const organism = input.organism?.trim() || undefined;
    const targetType = input.target_type;
    if (!query && !accession && !geneSymbol) {
      throw ctx.fail('missing_input');
    }

    const { limit, notice: limitNotice } = clampLimit(
      input.limit ?? getServerConfig().defaultLimit,
      MAX_LIMIT,
    );
    /**
     * Decoding here is the boundary check: ChEMBL substitutes 0 for an offset it
     * dislikes and answers 200, so a corrupted cursor forwarded unchecked would
     * return page one dressed as a later page. `decodeCursor` throws InvalidParams
     * (-32602) — the code the MCP pagination spec mandates — and that propagates
     * unwrapped. Only the offset is read back: `limit` stays this call's, so a
     * client never has to re-send the page size to keep paging. A blank cursor
     * counts as omitted.
     */
    const cursor = input.cursor?.trim() || undefined;
    const offset = cursor ? decodeCursor(cursor, ctx).offset : 0;
    const page = await getChemblService().searchTargets(
      {
        query: nameQuery,
        targetChemblId,
        accession,
        geneSymbol,
        organism,
        targetType,
        limit,
        offset,
      },
      ctx,
    );

    const nextOffset = offset + page.items.length;
    const hasMore = page.items.length > 0 && nextOffset < page.totalCount;

    ctx.enrich.total(page.totalCount);
    /**
     * `hasMore` keeps the cap disclosure honest across a walk: at offset 0 it
     * reduces to the pre-pagination test, and on the last page it stops claiming a
     * cap that withholds nothing — which would contradict the absent nextCursor.
     */
    if (page.items.length >= limit && hasMore) {
      ctx.enrich.truncated({
        shown: page.items.length,
        cap: limit,
        // A clamped limit is already the maximum, so the default "raise the cap" advice would not hold.
        ...(limitNotice && {
          guidance: `${limitNotice} Showing ${page.items.length} of ${page.totalCount}; pass nextCursor back as cursor for the next page.`,
        }),
      });
    } else {
      ctx.enrich({ truncated: false, shown: page.items.length, cap: limit });
      let notice = limitNotice;
      if (page.items.length === 0) {
        const filters = [
          accession && `accession="${accession}"`,
          geneSymbol && `gene_symbol="${geneSymbol}"`,
          targetChemblId && `query="${targetChemblId}" (a ChEMBL target ID)`,
          nameQuery && `query="${nameQuery}"`,
          organism && `organism="${organism}"`,
          targetType && `target_type="${targetType}"`,
        ]
          .filter(Boolean)
          .join(', ');
        /**
         * A paged call that runs off the end matched fine — saying otherwise would
         * send the caller chasing a bad accession that isn't there.
         */
        const empty =
          offset > 0 && page.totalCount > 0
            ? `That cursor starts past the end of the ${page.totalCount} targets matching ${filters} — the walk is complete.`
            : `No target matched ${filters}. ${zeroHitAdvice({ accession, geneSymbol, targetChemblId, nameQuery, organism, targetType })}`;
        notice = notice ? `${notice} ${empty}` : empty;
      }
      if (notice) ctx.enrich.notice(notice);
    }

    /**
     * Omitted — never `null` or `''` — on the last page, per the MCP pagination
     * contract. An empty page never mints one either: a cursor at the same offset
     * would not advance.
     */
    return {
      targets: page.items,
      ...(hasMore && { nextCursor: encodeCursor({ offset: nextOffset, limit }) }),
    };
  },

  format: (result) => {
    if (result.targets.length === 0) {
      return [{ type: 'text', text: 'No matching targets.' }];
    }
    const lines = result.targets.map((t) => {
      const parts = [
        `**${mdInline(t.target_chembl_id)}** — ${mdInline(t.pref_name ?? '(unnamed)')}`,
        `Type: ${mdInline(t.target_type ?? '—')} | Organism: ${mdInline(t.organism ?? '—')}`,
      ];
      for (const c of t.components) {
        const genes = c.gene_symbols.length > 0 ? c.gene_symbols.map(mdInline).join(', ') : '—';
        parts.push(`  • accession ${mdInline(c.accession ?? '—')} | genes: ${genes}`);
      }
      return parts.join('\n');
    });
    /**
     * Content-only clients read this surface, not structuredContent — without the
     * line they cannot tell a capped page from the whole result set.
     */
    if (result.nextCursor) {
      lines.push(
        `More targets remain — re-call with cursor="${result.nextCursor}" and the same filters for the next page.`,
      );
    }
    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
