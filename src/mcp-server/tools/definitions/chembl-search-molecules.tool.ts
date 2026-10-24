/**
 * @fileoverview chembl_search_molecules — the discovery entry point. Finds
 * compounds by name / ChEMBL ID / InChIKey (search_type=name), or runs a
 * structure search (exact | similarity | substructure) from a SMILES. Surfaces
 * max_phase on every row as the cheap druggability signal, the family
 * parent_chembl_id, and the Tanimoto similarity percent on search_type=similarity
 * results. Flags a total equal to ChEMBL's name or substructure search ceiling as
 * totalCountCapped, and fails an unparseable similarity or substructure SMILES as
 * invalid_structure.
 * @module mcp-server/tools/definitions/chembl-search-molecules
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, encodeCursor, markdown } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { clampLimit, LIMIT_CEILING } from '@/mcp-server/input-normalization.js';
import { mdInline } from '@/mcp-server/markdown-text.js';
import { getChemblService } from '@/services/chembl/chembl-service.js';
import type { MoleculePage, SearchType } from '@/services/chembl/types.js';

/** The most molecules one call returns; a larger `limit` is served at this cap. */
const MAX_LIMIT = 100;

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
    parent_chembl_id: z
      .string()
      .describe(
        "The parent of the compound's family, e.g. \"CHEMBL553\" for erlotinib hydrochloride — the compound's own ID when it is the parent or ChEMBL records no hierarchy for it. A salt's measurements are a small share of its family's: pass the parent to chembl_get_drug_info, or set include_alternate_forms on chembl_get_bioactivities, to reach the whole family.",
      ),
    similarity: z
      .number()
      .nullable()
      .optional()
      .describe(
        'Tanimoto similarity percent (0–100) to the query structure. Present only on search_type=similarity results; on every other search_type the key is absent, not null.',
      ),
  })
  .describe('A compound matched by the search.');

export const chemblSearchMolecules = tool('chembl_search_molecules', {
  title: 'chembl-search-molecules',
  description:
    "Discovery entry point for compounds. Find by name / ChEMBL ID / InChIKey with the default search_type=name (supply query), or run a structure search with search_type exact | similarity | substructure (supply structure as a SMILES). At least one of query or structure is required, and structure is required for the three structure modes. Returns ChEMBL ID, preferred name, canonical SMILES, formula, MW, AlogP, Lipinski violations, QED, max clinical phase, and the family parent_chembl_id on every row; only search_type=similarity adds a Tanimoto similarity percent. Chain molecule_chembl_id into chembl_get_bioactivities or chembl_get_drug_info. A salt often ranks ahead of its parent and carries a small share of the family's measurements, so check parent_chembl_id before chaining. A capped result carries nextCursor — pass it back as cursor with the same filters to read the next page.",
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
      .max(LIMIT_CEILING)
      .optional()
      .describe(
        'Maximum molecules to return, up to 100 — a larger value is served at 100, with a notice saying so. Defaults to the server default (25) when omitted.',
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        "Opaque continuation token from a previous call's nextCursor — resumes where that page ended. Omit for the first page. Re-send the same query/structure/filters that minted it (only limit may change; it sets this page's size); redeeming it against different filters walks a different result set.",
      ),
  }),
  output: z.object({
    molecules: z.array(MoleculeSchema).describe('Matching compounds (up to the limit).'),
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
      .describe(
        'Total compounds matching before the limit was applied — a lower bound when totalCountCapped is true.',
      ),
    totalCountCapped: z
      .boolean()
      .describe(
        "True when totalCount is ChEMBL's ceiling for the search — 10000 for a name search, 30000 for a substructure search: at least that many compounds match, and no page past the ceiling can be reached. Narrow the query to bring the matches under it.",
      ),
    truncated: z.boolean().describe('True when the result was capped at the limit.'),
    shown: z.number().describe('Number of molecules returned.'),
    cap: z.number().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        "Guidance when nothing matched — echoes the query and suggests how to broaden — the disclosure that a limit above the maximum was served at the maximum, and, when totalCountCapped is true, that the total is ChEMBL's search ceiling and how to narrow below it.",
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
      reason: 'invalid_structure',
      code: JsonRpcErrorCode.ValidationError,
      when: 'ChEMBL could not parse the SMILES of a similarity or substructure search.',
      recovery:
        'Check the SMILES for an atom over its valence (a carbon with five bonds), an unclosed ring-closure digit or parenthesis, or an aromatic ring that cannot be kekulized, then retry.',
      thrownBy: 'service',
    },
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
    const service = getChemblService();

    // Validate the input/mode pairing at the handler level, then fetch within the
    // narrowed branch so the validated value is non-undefined without an assertion.
    let page: MoleculePage;
    if (searchType === 'name') {
      if (!query) {
        throw ctx.fail('missing_input', 'search_type=name requires a query.');
      }
      page = await service.searchMolecules(
        { query, maxPhaseMin: input.max_phase_min, limit, offset },
        ctx,
      );
    } else {
      if (!structure) {
        throw ctx.fail('missing_input', `search_type=${searchType} requires a structure (SMILES).`);
      }
      page = await service.structureSearch(
        { structure, searchType, similarityThreshold: input.similarity_threshold, limit, offset },
        ctx,
      );
    }

    const nextOffset = offset + page.items.length;
    const hasMore = page.items.length > 0 && nextOffset < page.totalCount;
    const what =
      searchType === 'name' ? `query "${query}"` : `${searchType} structure "${structure}"`;
    /**
     * Only name and substructure searches carry a ceiling. Every page of a capped
     * search says so, since any of them can be the one a caller reads; the total
     * and the cursor stay as ChEMBL reports them.
     */
    const ceiling = page.totalCountCapped
      ? `At least ${page.totalCount} compounds match ${what}: ChEMBL stops counting and paging a ${searchType} search at ${page.totalCount}, so the matches past it cannot be reached. ${
          searchType === 'name'
            ? 'Use a more specific name, or set max_phase_min, to bring the matches under that ceiling.'
            : 'Search a larger, more specific substructure to bring the matches under that ceiling.'
        }`
      : undefined;

    ctx.enrich.total(page.totalCount);
    ctx.enrich({ totalCountCapped: page.totalCountCapped });
    /**
     * `hasMore` keeps the cap disclosure honest across a walk: at offset 0 it
     * reduces to the pre-pagination test, and on the last page it stops claiming a
     * cap that withholds nothing — which would contradict the absent nextCursor.
     */
    if (page.items.length >= limit && hasMore) {
      const showing = ceiling
        ? `Showing ${page.items.length} of the first ${page.totalCount}; pass nextCursor back as cursor for the next page. ${ceiling}`
        : `Showing ${page.items.length} of ${page.totalCount}; pass nextCursor back as cursor for the next page.`;
      ctx.enrich.truncated({
        shown: page.items.length,
        cap: limit,
        // A clamped limit is already the maximum, so the default "raise the cap" advice would not hold.
        ...((limitNotice || ceiling) && {
          guidance: limitNotice ? `${limitNotice} ${showing}` : showing,
        }),
      });
    } else {
      ctx.enrich({ truncated: false, shown: page.items.length, cap: limit });
      let tail = ceiling;
      if (page.items.length === 0) {
        /**
         * A paged call that runs off the end matched fine — saying otherwise would
         * send the caller chasing a spelling problem that isn't there. Off the end
         * of a capped search, the ceiling ended the walk, not the matches.
         */
        if (offset > 0 && ceiling) {
          tail = `That cursor starts at or past ChEMBL's search ceiling, so the walk ends here short of the last match. ${ceiling}`;
        } else if (offset > 0 && page.totalCount > 0) {
          tail = `That cursor starts past the end of the ${page.totalCount} compounds matching ${what} — the walk is complete.`;
        } else {
          tail = `No compound matched ${what}. Check spelling/SMILES, lower the similarity threshold, or try a broader name.`;
        }
      }
      const notice = [limitNotice, tail].filter(Boolean).join(' ');
      if (notice) ctx.enrich.notice(notice);
    }

    /**
     * Omitted — never `null` or `''` — on the last page, per the MCP pagination
     * contract. An empty page never mints one either: a cursor at the same offset
     * would not advance.
     */
    return {
      molecules: page.items,
      ...(hasMore && { nextCursor: encodeCursor({ offset: nextOffset, limit }) }),
    };
  },

  format: (result) => {
    if (result.molecules.length === 0) {
      return [{ type: 'text', text: 'No matching compounds.' }];
    }
    /**
     * A structure is a code span sized to the value: SMILES syntax is Markdown
     * syntax (`[C@H](N)` is a link, `\[` an escaped bracket), and a span's literal
     * reads back byte for byte.
     */
    const structure = (value: string | null) =>
      value === null ? '—' : markdown().inlineCode(value).build();
    const lines = result.molecules.map((m) => {
      const parts = [
        `**${mdInline(m.molecule_chembl_id)}** — ${mdInline(m.pref_name ?? '(unnamed)')}`,
      ];
      const phase = m.max_phase != null ? `phase ${m.max_phase}` : 'phase —';
      parts.push(
        `${phase} | MW: ${m.mw_freebase ?? '—'} | AlogP: ${m.alogp ?? '—'} | RO5 violations: ${m.num_ro5_violations ?? '—'} | QED: ${m.qed_weighted ?? '—'}`,
      );
      parts.push(
        `Formula: ${mdInline(m.full_molformula ?? '—')} | Type: ${mdInline(m.molecule_type ?? '—')} | Parent: ${mdInline(m.parent_chembl_id)}`,
      );
      parts.push(
        `SMILES: ${structure(m.canonical_smiles)} | InChIKey: ${structure(m.standard_inchi_key)}`,
      );
      if (m.similarity != null) parts.push(`Similarity: ${m.similarity}%`);
      return parts.join('\n');
    });
    /**
     * Content-only clients read this surface, not structuredContent — without the
     * line they cannot tell a capped page from the whole result set.
     */
    if (result.nextCursor) {
      lines.push(
        `More compounds remain — re-call with cursor="${result.nextCursor}" and the same filters for the next page.`,
      );
    }
    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
