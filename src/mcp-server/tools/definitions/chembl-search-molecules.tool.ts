/**
 * @fileoverview chembl_search_molecules — the discovery entry point. Finds
 * compounds by name / ChEMBL ID / InChIKey (search_type=name), or runs a
 * structure search (exact | similarity | substructure) from a SMILES. Surfaces
 * max_phase on every row as the cheap druggability signal, the family
 * parent_chembl_id, and the Tanimoto similarity percent on search_type=similarity
 * results. Applies max_phase_min on every search_type and names in the notice each
 * input the chosen search_type ignores (query, structure, or a similarity_threshold
 * set off its default). Flags a total equal to ChEMBL's name or
 * substructure search ceiling — or a filtered substructure total ChEMBL took from
 * only its first 30000 hits — as totalCountCapped, and fails an unparseable
 * similarity or substructure SMILES as invalid_structure.
 * @module mcp-server/tools/definitions/chembl-search-molecules
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, encodeCursor, markdown } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { clampLimit, LIMIT_CEILING } from '@/mcp-server/input-normalization.js';
import { mdInline } from '@/mcp-server/markdown-text.js';
import { getChemblService, SUBSTRUCTURE_SEARCH_CEILING } from '@/services/chembl/chembl-service.js';
import type { MoleculePage, SearchType } from '@/services/chembl/types.js';

/** The most molecules one call returns; a larger `limit` is served at this cap. */
const MAX_LIMIT = 100;

/**
 * The schema fills this when similarity_threshold is omitted, so only another
 * value shows a caller set the threshold on a search_type that ignores it.
 */
const DEFAULT_SIMILARITY_THRESHOLD = 70;

/** What a zero-hit search can try next, naming only the inputs its search_type reads. */
const BROADEN_HINT: Record<SearchType, string> = {
  name: 'check the spelling or try a broader name',
  exact: 'check the SMILES, or run a similarity or substructure search',
  similarity: 'check the SMILES or lower the similarity threshold',
  substructure: 'check the SMILES or try a smaller substructure',
};

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
        "Max clinical phase: 4 = reached approval, 3–1 = clinical trial phase, 0.5 = early phase 1, −1 = clinical with the phase unknown. Null when ChEMBL records no clinical development (a preclinical or research compound). The cheap druggability signal. A drug withdrawn from a market keeps 4, so 4 means it reached approval, not that it is on the market now: read chembl_get_drug_info's withdrawn and warnings for that.",
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
      .default(DEFAULT_SIMILARITY_THRESHOLD)
      .describe(
        'Minimum Tanimoto similarity percent for search_type=similarity (40–100; ChEMBL rejects below 40). Every other search_type ignores it, and the notice names a value other than the default 70 as ignored.',
      ),
    max_phase_min: z
      .number()
      .int()
      .min(0)
      .max(4)
      .optional()
      .describe(
        'Restrict to compounds at or above this max clinical phase, e.g. 4 for drugs that reached approval, withdrawn ones included. Applies to every search_type; a compound with no recorded phase never passes, even at 0.',
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
        "True when totalCount is a lower bound: ChEMBL's ceiling for the search — 10000 for a name search, 30000 for a substructure search — or, with max_phase_min on a substructure search, the qualifying compounds among the first 30000 hits of a structure that has at least that many. Matches past the ceiling cannot be reached; narrow the query to bring them under it.",
      ),
    truncated: z.boolean().describe('True when the result was capped at the limit.'),
    shown: z.number().describe('Number of molecules returned.'),
    cap: z.number().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when nothing matched — echoes the query and max_phase_min and suggests how to broaden — the disclosure that a limit above the maximum was served at the maximum, each input the chosen search_type ignored (query on a structure search, structure on a name search, a similarity_threshold other than 70 on any search but similarity), and, when totalCountCapped is true, why the total is a lower bound and how to narrow below it.',
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
    const maxPhaseMin = input.max_phase_min;
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
    /**
     * Each search_type reads one of query and structure, and only similarity reads
     * similarity_threshold. An input the search does not read is named as ignored
     * rather than dropped silently; rejecting it would fail calls that answer
     * correctly today.
     */
    let ignoredInput: string | undefined;
    let page: MoleculePage;
    if (searchType === 'name') {
      if (!query) {
        throw ctx.fail('missing_input', 'search_type=name requires a query.');
      }
      if (structure) {
        ignoredInput =
          'structure was ignored: search_type=name searches by query only; set search_type to exact, similarity, or substructure to search by structure.';
      }
      page = await service.searchMolecules({ query, maxPhaseMin, limit, offset }, ctx);
    } else {
      if (!structure) {
        throw ctx.fail('missing_input', `search_type=${searchType} requires a structure (SMILES).`);
      }
      if (query) {
        ignoredInput = `query was ignored: search_type=${searchType} searches by structure only.`;
      }
      page = await service.structureSearch(
        {
          structure,
          searchType,
          similarityThreshold: input.similarity_threshold,
          maxPhaseMin,
          limit,
          offset,
        },
        ctx,
      );
    }
    const thresholdIgnored =
      searchType !== 'similarity' && input.similarity_threshold !== DEFAULT_SIMILARITY_THRESHOLD
        ? 'similarity_threshold was ignored: only search_type=similarity applies a Tanimoto threshold.'
        : undefined;
    const ignored = [ignoredInput, thresholdIgnored].filter(Boolean).join(' ') || undefined;

    const nextOffset = offset + page.items.length;
    const hasMore = page.items.length > 0 && nextOffset < page.totalCount;
    const searched =
      searchType === 'name' ? `query "${query}"` : `${searchType} structure "${structure}"`;
    const what =
      maxPhaseMin === undefined ? searched : `${searched} with max_phase_min=${maxPhaseMin}`;
    /**
     * A filtered substructure total is capped when the unfiltered search reaches
     * ChEMBL's ceiling: the filter ran over only the hits up to it, so the total
     * counts the qualifying compounds among them, not every one.
     */
    const phaseCapped =
      page.totalCountCapped && searchType === 'substructure' && maxPhaseMin !== undefined;
    /**
     * Only name and substructure searches carry a ceiling. Every page of a capped
     * search says so, since any of them can be the one a caller reads; the total
     * and the cursor stay as ChEMBL reports them.
     */
    let ceiling: string | undefined;
    if (phaseCapped) {
      ceiling = `ChEMBL applies max_phase_min to only the first ${SUBSTRUCTURE_SEARCH_CEILING} hits of a substructure search, and ${searched} reaches that ceiling, so the ${page.totalCount} matches are a lower bound: qualifying compounds past those hits are missed. Search a larger, more specific substructure to bring the matches under that ceiling.`;
    } else if (page.totalCountCapped) {
      ceiling = `At least ${page.totalCount} compounds match ${what}: ChEMBL stops counting and paging a ${searchType} search at ${page.totalCount}, so the matches past it cannot be reached. ${
        searchType === 'name'
          ? 'Use a more specific name, or set max_phase_min, to bring the matches under that ceiling.'
          : 'Search a larger, more specific substructure to bring the matches under that ceiling.'
      }`;
    }

    ctx.enrich.total(page.totalCount);
    ctx.enrich({ totalCountCapped: page.totalCountCapped });
    /**
     * `hasMore` keeps the cap disclosure honest across a walk: at offset 0 it
     * reduces to the pre-pagination test, and on the last page it stops claiming a
     * cap that withholds nothing — which would contradict the absent nextCursor.
     * The notice is one string (each write replaces the last): the clamp and an
     * ignored input lead, the page's own disclosure follows.
     */
    if (page.items.length >= limit && hasMore) {
      const of = ceiling && !phaseCapped ? 'of the first' : 'of';
      const showing = `Showing ${page.items.length} ${of} ${page.totalCount}; pass nextCursor back as cursor for the next page.`;
      ctx.enrich.truncated({
        shown: page.items.length,
        cap: limit,
        // A clamped limit is already the maximum, so the default "raise the cap" advice would not hold.
        ...((limitNotice || ignored || ceiling) && {
          guidance: [limitNotice, ignored, showing, ceiling].filter(Boolean).join(' '),
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
        if (offset > 0 && phaseCapped) {
          tail = `That cursor starts past the last of the ${page.totalCount} compounds ChEMBL returned, so the walk ends here short of the last match. ${ceiling}`;
        } else if (offset > 0 && ceiling) {
          tail = `That cursor starts at or past ChEMBL's search ceiling, so the walk ends here short of the last match. ${ceiling}`;
        } else if (offset > 0 && page.totalCount > 0) {
          tail = `That cursor starts past the end of the ${page.totalCount} compounds matching ${what} — the walk is complete.`;
        } else {
          const noMatch =
            maxPhaseMin === undefined
              ? `No compound matched ${what}: ${BROADEN_HINT[searchType]}.`
              : `No compound matched ${what}. Retry without max_phase_min first: it keeps only compounds whose recorded max clinical phase is at least ${maxPhaseMin}, and one with no recorded phase never passes. Otherwise ${BROADEN_HINT[searchType]}.`;
          tail = ceiling ? `${noMatch} ${ceiling}` : noMatch;
        }
      }
      const notice = [limitNotice, ignored, tail].filter(Boolean).join(' ');
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
