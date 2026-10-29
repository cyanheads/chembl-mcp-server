/**
 * @fileoverview chembl_get_bioactivities — the flagship compound↔target↔assay
 * bridge. Returns bioactivity measurements for a molecule (or, under
 * `include_alternate_forms`, every form of its family by parent), a target, or both
 * together (which narrows to that compound–target pair), filterable by
 * standard_type, potency (pchembl_value), assay type, organism, and assay variant,
 * ranked on pchembl_value. `potency_view` selects which side of the pchembl_value presence
 * split is retrieved; each view spills to its own DataCanvas table the caller
 * inspects with chembl_dataframe_describe and SQLs with chembl_dataframe_query,
 * bounded by the CHEMBL_MAX_SPILL_ROWS cap and the CHEMBL_SPILL_DEADLINE_MS time
 * budget over a concurrent page walk, and reporting a table either bound cut short
 * as truncated, naming the bound, rather than as the complete set. Without a
 * `canvas_id`, a canvas is minted only when the view spills; with one, the view's
 * table is re-staged with the current result even when it fits inline, and a spill
 * onto it stages under a per-call table that replaces the view's table only once
 * the spill succeeds.
 * `limit` bounds the rows returned inline on every branch — spilled, fit inline,
 * or canvas disabled. With nothing staged, a `cursor` / `nextCursor` pair walks
 * the view a page at a time; a cursor page is served inline and never stages,
 * even with the canvas enabled.
 * @module mcp-server/tools/definitions/chembl-get-bioactivities
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import {
  CanvasIdSchema,
  type CanvasInstance,
  type ColumnType,
  type DataCanvas,
  spillover,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  assayTypeInput,
  clampLimit,
  isChemblId,
  LIMIT_CEILING,
  optionalChemblIdInput,
  optionalMoleculeRefInput,
} from '@/mcp-server/input-normalization.js';
import { mdInline, mdLineStart } from '@/mcp-server/markdown-text.js';
import { getCanvas } from '@/services/canvas-accessor.js';
import {
  CALL_DEADLINE_MS,
  CallDeadline,
  getChemblService,
} from '@/services/chembl/chembl-service.js';
import type {
  Activity,
  GetActivitiesOptions,
  PotencyView,
  VariantFilter,
} from '@/services/chembl/types.js';

/** The bound that left rows of the view out: the CHEMBL_MAX_SPILL_ROWS cap, or the CHEMBL_SPILL_DEADLINE_MS budget. */
type TruncatedBy = 'row_cap' | 'time_budget';

/** The most rows one call returns inline; a larger `limit` is served at this cap. */
const MAX_LIMIT = 1000;

/**
 * Everything that differs between the two potency views: the canvas table each
 * stages to, a worked SQL starter (potency aggregates only mean something on
 * ranked rows), and the filters that actually narrow it (`pchembl_value_min` is
 * potency_ranked-only — on null_potency it is a `contradictory_potency_filter`).
 *
 * The tables are distinct because the views partition the match set exactly, so
 * they stage side by side: run both against one canvas_id and a UNION ALL over
 * the pair reconstructs the honest full rowset in SQL — without ever putting the
 * unrankable rows at the head of a potency-ranked stream.
 */
const VIEW = {
  potency_ranked: {
    table: 'bioactivities',
    sqlExample:
      'SELECT molecule_chembl_id, MEDIAN(pchembl_value) AS med FROM bioactivities GROUP BY 1 ORDER BY 2 DESC',
    narrowWith: 'standard_type or pchembl_value_min',
  },
  null_potency: {
    table: 'bioactivities_null_potency',
    sqlExample:
      'SELECT standard_type, standard_relation, COUNT(*) FROM bioactivities_null_potency GROUP BY 1, 2 ORDER BY 3 DESC',
    narrowWith: 'standard_type or assay_type',
  },
} as const satisfies Record<PotencyView, { table: string; sqlExample: string; narrowWith: string }>;

const ActivitySchema = z
  .object({
    activity_id: z.number().describe('ChEMBL activity row ID.'),
    molecule_chembl_id: z.string().describe('ChEMBL molecule ID of the measured compound.'),
    molecule_pref_name: z
      .string()
      .nullable()
      .describe('Compound preferred name. Null for many research compounds.'),
    target_chembl_id: z.string().describe('ChEMBL target ID the compound was measured against.'),
    target_pref_name: z.string().nullable().describe('Target preferred name. Null when unnamed.'),
    target_organism: z
      .string()
      .nullable()
      .describe('Target organism, e.g. "Homo sapiens". Null when unspecified.'),
    assay_chembl_id: z
      .string()
      .describe('ChEMBL assay ID — pass to chembl_get_assay for provenance.'),
    assay_type: z
      .string()
      .nullable()
      .describe(
        'Assay type code: B=binding, F=functional, A=ADMET, T=toxicity, P=physicochemical, U=unclassified. Null when absent.',
      ),
    assay_description: z.string().nullable().describe('Assay description text. Null when absent.'),
    standard_type: z
      .string()
      .nullable()
      .describe(
        'Standardized activity type, e.g. "IC50", "Ki", "EC50" — the comparability key. Null when absent.',
      ),
    standard_relation: z
      .string()
      .nullable()
      .describe('Standardized relation, e.g. "=", ">", "<". Null when absent.'),
    standard_value: z
      .number()
      .nullable()
      .describe(
        'Standardized value in standard_units. Null when the measurement is missing — never 0.',
      ),
    standard_units: z
      .string()
      .nullable()
      .describe('Standardized units, e.g. "nM". Null when absent.'),
    pchembl_value: z
      .number()
      .nullable()
      .describe(
        '−log10(molar potency); the rank field. Null when underivable (non-standard type, censored relation).',
      ),
    type: z
      .string()
      .nullable()
      .describe('Original (pre-standardization) activity type string from upstream.'),
    value: z.string().nullable().describe('Original value string from upstream — not coerced.'),
    units: z.string().nullable().describe('Original units string from upstream.'),
    relation: z.string().nullable().describe('Original relation string from upstream.'),
    activity_comment: z
      .string()
      .nullable()
      .describe(
        'Depositor or curator comment on the result, free text such as "Not Active", "Active", or "Inconclusive" — often the only result when standard_value is null. Null when absent.',
      ),
    data_validity_comment: z
      .string()
      .nullable()
      .describe(
        'ChEMBL data-validity annotation, e.g. "Outside typical range", "Potential transcription error", "Non standard unit for type", or "Manually validated" (a value curators confirmed). Null when unannotated.',
      ),
    assay_variant_mutation: z
      .string()
      .nullable()
      .describe(
        'Variant of the target protein the assay measured, as ChEMBL records it: a substitution ("T315I"), a deletion ("F508del"), several joined by "," or "/" ("L858R,T790M"), or "UNDEFINED MUTATION" for an unspecified mutant. Null when no variant is recorded.',
      ),
    assay_variant_accession: z
      .string()
      .nullable()
      .describe(
        "UniProt accession of the variant protein, which can differ from the target's own. Null when no variant is recorded, and for UNDEFINED MUTATION.",
      ),
    document_chembl_id: z
      .string()
      .nullable()
      .describe(
        'ChEMBL document ID of the publication or deposited dataset the measurement comes from — cite it. Null when absent.',
      ),
    document_year: z
      .number()
      .nullable()
      .describe(
        'Publication year of the source document. Null when it has none, as for deposited datasets.',
      ),
  })
  .describe('One bioactivity measurement linking a compound, target, and assay.');

/** Keep sparse or integer-only previews from narrowing later fractional measurements. */
const ACTIVITY_COLUMNS = {
  activity_id: 'BIGINT',
  molecule_chembl_id: 'VARCHAR',
  molecule_pref_name: 'VARCHAR',
  target_chembl_id: 'VARCHAR',
  target_pref_name: 'VARCHAR',
  target_organism: 'VARCHAR',
  assay_chembl_id: 'VARCHAR',
  assay_type: 'VARCHAR',
  assay_description: 'VARCHAR',
  standard_type: 'VARCHAR',
  standard_relation: 'VARCHAR',
  standard_value: 'DOUBLE',
  standard_units: 'VARCHAR',
  pchembl_value: 'DOUBLE',
  type: 'VARCHAR',
  value: 'VARCHAR',
  units: 'VARCHAR',
  relation: 'VARCHAR',
  activity_comment: 'VARCHAR',
  data_validity_comment: 'VARCHAR',
  assay_variant_mutation: 'VARCHAR',
  assay_variant_accession: 'VARCHAR',
  document_chembl_id: 'VARCHAR',
  document_year: 'INTEGER',
} satisfies Record<keyof Activity, ColumnType>;

const ACTIVITY_CANVAS_SCHEMA = Object.entries(ACTIVITY_COLUMNS).map(([name, type]) => ({
  name,
  type,
}));

/**
 * Stands in for the `CanvasInstance` handed to `spillover()` when the caller
 * supplied no `canvas_id`, so the canvas is minted on the first `registerTable`
 * (which `spillover()` makes only on a spill) rather than before fit-or-spill is
 * known. An inline fit therefore never holds a tenant canvas slot. `spillover()`
 * calls only `registerTable` and `drop`; `canvasId` is read once the spill has
 * minted. A registration that fails (an upstream error or a cancellation in the
 * spill tail) leaves the minted canvas holding no table, so it is released before
 * the original error propagates — a failed release is logged, never thrown over
 * it. Remove once the framework acquires lazily (cyanheads/mcp-ts-core#501).
 */
function mintOnSpill(
  canvas: DataCanvas,
  ctx: Context,
  mint: () => Promise<CanvasInstance>,
): CanvasInstance {
  let minted: CanvasInstance | undefined;
  const lazy: Pick<CanvasInstance, 'canvasId' | 'registerTable' | 'drop'> = {
    get canvasId() {
      if (!minted) throw new Error('No canvas was minted: the view did not spill.');
      return minted.canvasId;
    },
    async registerTable(name, rows, options) {
      minted ??= await mint();
      try {
        return await minted.registerTable(name, rows, options);
      } catch (error) {
        const empty = minted;
        minted = undefined;
        await canvas.drop(empty.canvasId, ctx).catch((releaseError: unknown) => {
          ctx.log.warning('Could not release the canvas a failed spill minted.', {
            canvasId: empty.canvasId,
            error: releaseError instanceof Error ? releaseError.message : String(releaseError),
          });
        });
        throw error;
      }
    },
    /** Before the mint, and after a failed spill's release, there is no table to drop. */
    async drop(name) {
      return minted ? await minted.drop(name) : false;
    },
  };
  return lazy as CanvasInstance;
}

/**
 * The write still running onto each supplied canvas's view table, keyed by canvas
 * and table. Two writers replace that table: a spill's swap of its staging table
 * in ({@link promoteStaged}), and an inline fit or zero match re-staging it with
 * `registerTable`. Interleaved, either can fail the other: a re-stage landing
 * between a swap's drop and its copy takes the name the copy needs
 * (`register_as_clash`), a swap's drop can pull the table from under a re-stage's
 * append, and two swaps find the table dropped or taken under them. Each write
 * waits for the one before it ({@link onViewTable}), so the later writer is the
 * one that lands.
 */
const swaps = new Map<string, Promise<unknown>>();

/**
 * Run `write` once every earlier write onto `table` on this canvas has settled,
 * and settle with its outcome. An earlier write's failure is its own call's to
 * report, so it only hands the turn on. The entry is removed once the last write
 * queued on the table settles, failures included.
 */
async function onViewTable<T>(
  instance: CanvasInstance,
  table: string,
  write: () => Promise<T>,
): Promise<T> {
  const key = `${instance.canvasId}/${table}`;
  const previous = swaps.get(key);
  const turn = (async () => {
    await previous?.catch(() => undefined);
    return await write();
  })();
  swaps.set(key, turn);
  try {
    return await turn;
  } finally {
    if (swaps.get(key) === turn) swaps.delete(key);
  }
}

/**
 * Replace `table` on a supplied canvas with the rows a successful spill registered
 * under `staging`, then drop `staging`. The spill stages under its own name because
 * registering under the view's name drops the earlier table before the first row
 * lands, so a spill that failed or was cancelled part-way would take those rows
 * with it. `registerAs` refuses a name that exists rather than replacing it, so the
 * earlier table is dropped first and the staging table copied in after, which
 * keeps the declared column types. The drop and the copy take no signal, so a
 * cancellation cannot land between them; one already observed when the swap would
 * begin leaves the earlier table and is rethrown. An engine fault inside the copy
 * is the one outcome that leaves the view with no table. The staging table is
 * dropped either way, and a failed drop of it is logged, never thrown over the
 * outcome. The swap takes its turn on the table ({@link onViewTable}).
 */
async function promoteStaged(
  instance: CanvasInstance,
  staging: string,
  table: string,
  ctx: Context,
): Promise<void> {
  await onViewTable(instance, table, async () => {
    try {
      ctx.signal.throwIfAborted();
      await instance.drop(table);
      await instance.query(`SELECT * FROM ${staging}`, { registerAs: table, preview: 0 });
    } finally {
      await instance.drop(staging).catch((dropError: unknown) => {
        ctx.log.warning('Could not drop the staging table of a spill onto a supplied canvas.', {
          tableName: staging,
          error: dropError instanceof Error ? dropError.message : String(dropError),
        });
      });
    }
  });
}

/**
 * Compose the agent-facing notice for a bioactivities result. Names which side of
 * the pchembl_value split was returned and how to reach the other (so the honest
 * totalCount and the narrower view never appear to contradict each other), plus
 * the spill / re-stage / row-cap / canvas-disabled / cursor-page / empty-result
 * context. Returns undefined when there is nothing worth saying (fit inline with
 * nothing staged, limit held nothing back, whole match set in view).
 *
 * `stagedRows` is the row count registered on the view's table, or null when
 * nothing was staged; a non-null count without `spilled` is an inline fit
 * re-staged on a supplied canvas. `truncatedBy` names the bound that left rows of
 * the view out of what the walk fetched (`fetchedRows`), or is null when no bound
 * did: the walk reached the view's end, or ended on a short page before the
 * reported total. `page` is set on the inline-page branch —
 * canvas disabled, or any cursor page — and says where the page starts in the
 * view and whether rows remain past it. `canvasId` names the canvas the table was
 * staged on, and the supplied canvas a cursor page left untouched. `variant` is the
 * parsed variant filter, which a zero match explains. `typeVariant` is the case
 * variant ChEMBL records for a standard_type that matched nothing, when the lookup
 * found one.
 */
function buildNotice(args: {
  view: PotencyView;
  previewCount: number;
  totalCount: number;
  viewTotal: number;
  spilled: boolean;
  stagedRows: number | null;
  fetchedRows: number;
  truncatedBy: TruncatedBy | null;
  rowCap: number;
  deadlineMs: number;
  canvasDisabled: boolean;
  canvasId?: string | undefined;
  page?: { offset: number; hasMore: boolean };
  variant: VariantFilter | undefined;
  typeVariant: { requested: string; recorded: string } | undefined;
}): string | undefined {
  const {
    view,
    variant,
    typeVariant,
    previewCount,
    totalCount,
    viewTotal,
    spilled,
    stagedRows,
    fetchedRows,
    truncatedBy,
    rowCap,
    deadlineMs,
    canvasDisabled,
    canvasId,
    page,
  } = args;
  const nullView = view === 'null_potency';
  const otherView: PotencyView = nullView ? 'potency_ranked' : 'null_potency';
  const table = VIEW[view].table;

  if (previewCount === 0) {
    // A paged call that runs off the end matched fine — saying otherwise would
    // send the caller chasing a filter that isn't wrong.
    if (page && page.offset > 0 && viewTotal > 0) {
      return `That cursor starts past the end of the ${viewTotal} rows in this view — the walk is complete.`;
    }
    const variantHint =
      variant?.kind === 'mutation'
        ? ' variant must equal a recorded variant string whole, case-insensitively, in the order ChEMBL records it: "L858R,T790M" matches its rows, while "T790M,L858R" and a lone "L858R" do not. Re-call without variant and read assay_variant_mutation on the rows for the recorded strings.'
        : '';
    const empty =
      totalCount === 0
        ? typeVariant
          ? `No measurements matched standard_type "${typeVariant.requested}". standard_type matches exactly, case included, and ChEMBL records a case variant of it under these filters: "${typeVariant.recorded}". Re-call with standard_type: "${typeVariant.recorded}".${variantHint}`
          : `No measurements matched. Broaden the filters (drop standard_type or lower pchembl_value_min), or check the ID.${variantHint}`
        : nullView
          ? `Every one of the ${totalCount} matching measurements carries a derivable pchembl_value, so the null_potency view is empty. The default potency_view: "potency_ranked" holds all ${totalCount}.`
          : `All ${totalCount} matching measurements lack a derivable pchembl_value, so none appear in this potency-ranked view — the measurements exist but report no comparable potency. Re-call with potency_view: "null_potency" to retrieve them.`;
    // A supplied canvas_id still had the view re-staged, so an earlier query's rows cannot pass for this one's.
    return stagedRows === null
      ? empty
      : `${empty} Table "${table}" on canvas ${canvasId} now holds 0 rows, replacing what an earlier query staged there.`;
  }

  /**
   * Which view this is and how to reach the other. Suppressed when the other view
   * is empty: on the default view a pchembl_value_min floor already removed the
   * null rows, and on the null view every match lacks a pchembl_value.
   */
  const excluded = totalCount - viewTotal;
  const crossRef =
    excluded === 0
      ? ''
      : nullView
        ? ` Null-potency view: this holds the ${viewTotal} measurements with no derivable pchembl_value, of ${totalCount} matching. The default potency_view: "${otherView}" holds the other ${excluded}.`
        : ` Ranked by potency: this view holds the ${viewTotal} measurements with a pchembl_value; ${totalCount} match in total. Re-call with potency_view: "${otherView}" for the other ${excluded} (the rest report none).`;

  const narrowWith = VIEW[view].narrowWith;
  const capNote =
    truncatedBy === 'row_cap'
      ? ` Capped: the staged table holds ${stagedRows} rows of a larger upstream set (CHEMBL_MAX_SPILL_ROWS=${rowCap}), not the complete view — narrow with ${narrowWith}, or read SQL aggregates over it as a bounded sample.`
      : truncatedBy === 'time_budget'
        ? ` Cut short: the staged table holds ${stagedRows} of the ${viewTotal} rows in this view — the time budget (CHEMBL_SPILL_DEADLINE_MS=${deadlineMs}) ended the page walk, so it is not the complete view. Re-call to retry, narrow with ${narrowWith}, or read SQL aggregates over it as a bounded sample.`
        : '';
  const sqlGuide = `List its columns with chembl_dataframe_describe, then SQL the staged set with chembl_dataframe_query — e.g. ${VIEW[view].sqlExample}.`;

  /**
   * Which rows of the view an unstaged page holds, starting at `offset`, and the
   * way on: nextCursor whenever rows remain past it.
   */
  const pageSpan = (offset: number, hasMore: boolean): string => {
    const rows =
      previewCount === 1 ? `row ${offset + 1}` : `rows ${offset + 1}–${offset + previewCount}`;
    return offset === 0 && !hasMore
      ? `Showing all ${viewTotal} rows in this view.`
      : `Showing ${rows} of the ${viewTotal} rows in this view${
          hasMore
            ? '; pass nextCursor back as cursor, with the same filters and potency_view, for the next page.'
            : ' — the last page.'
        }`;
  };

  if (spilled) {
    return `${stagedRows} measurements staged as table "${table}" on canvas ${canvasId}. ${sqlGuide}${capNote}${crossRef}`;
  }

  if (stagedRows !== null) {
    // An inline fit re-staged on the supplied canvas: rows past `limit` are on the table it staged.
    const shown =
      previewCount < viewTotal
        ? ` Showing ${previewCount} of the ${viewTotal} rows in this view inline; ${stagedRows < viewTotal ? `the table holds the first ${stagedRows}` : 'the rest are on the table'}.`
        : '';
    return `The view fit inline and was staged as table "${table}" on canvas ${canvasId} (${stagedRows} rows), replacing whatever an earlier query staged under that name. ${sqlGuide}${shown}${capNote}${crossRef}`;
  }

  if (page) {
    /**
     * An inline page — canvas disabled, or a cursor page. Nothing was staged. What
     * a cursor-less re-call stages depends on canvas_id: a supplied canvas has the
     * view re-staged on it, while without one only a spill stages (on a new canvas).
     */
    const shown = pageSpan(page.offset, page.hasMore);
    if (canvasDisabled) {
      return `Canvas disabled on this server (CANVAS_PROVIDER_TYPE=none): ${shown} Nothing spilled, so SQL over the staged set is unavailable here.${crossRef}`;
    }
    const restage = canvasId
      ? `, so nothing was written to canvas ${canvasId}; re-call without cursor to re-stage the view on it.`
      : '. Without cursor, a view that spills stages on a new canvas, and one that fits inline stages only on a canvas_id you pass.';
    return `Cursor page, not staged: ${shown} A cursor page is served inline and never stages${restage}${crossRef}`;
  }

  /**
   * Canvas enabled, what the walk fetched fit inline, no canvas_id: nothing was
   * staged. Worth a note when a bound stopped the walk short of the view, when
   * rows remain past this page (which nextCursor then reaches, exactly as the
   * handler mints it), or when a second view exists.
   */
  const bound =
    truncatedBy === 'time_budget'
      ? `The time budget (CHEMBL_SPILL_DEADLINE_MS=${deadlineMs}) ended the page walk after ${fetchedRows} of the ${viewTotal} rows in this view, so nothing was staged — re-call to retry the walk, or narrow with ${narrowWith}. `
      : truncatedBy === 'row_cap'
        ? `The page walk stopped at the row cap (CHEMBL_MAX_SPILL_ROWS=${rowCap}) after ${fetchedRows} of the ${viewTotal} rows in this view, so nothing was staged. `
        : '';
  const shown = previewCount < viewTotal ? pageSpan(0, true) : '';
  return `${bound}${shown}${crossRef}`.trim() || undefined;
}

/**
 * Parse the `variant` input. Blank reads as omitted, and "wild_type" in any case
 * selects the rows that record no variant. Any other value is matched whole, so the
 * whitespace beside a "," or "/" separator is dropped to meet ChEMBL's recorded
 * form ("l858r , T790M" → "l858r,T790M"); splitting on the separator keeps that
 * linear in the input length, where a `\s*[,/]\s*` replace rescans whitespace runs.
 */
function parseVariant(raw: string | undefined): VariantFilter | undefined {
  const value = raw?.trim();
  if (!value) return;
  if (value.toLowerCase() === 'wild_type') return { kind: 'wild_type' };
  const mutation = value
    .split(/([,/])/)
    .map((part) => part.trim())
    .join('');
  return { kind: 'mutation', mutation };
}

export const chemblGetBioactivities = tool('chembl_get_bioactivities', {
  title: 'chembl-get-bioactivities',
  description:
    'The flagship compound↔target bioactivity bridge: measurements for a molecule (target deconvolution / selectivity), a target (lead finding), or both together (how potently one compound hits one target). Supply at least one of molecule_chembl_id (from chembl_search_molecules) or target_chembl_id (from chembl_search_targets) — supplying both narrows to that compound–target pair, supplying neither is an error. A drug\'s measurements are often split across its salts and other alternate forms, so molecule_chembl_id reads that one form unless include_alternate_forms widens it to the whole family under its parent (a salt\'s ID included), every view, page, and spill reading the same family. Filter by standard_type (IC50/Ki/EC50/…), minimum potency pchembl_value_min, assay_type, organism, and variant (wild type, or one recorded mutant such as "T315I"). Each row carries its activity_comment and data_validity_comment, its assay variant, and its source document for citation. Not every measurement has a derivable pchembl_value, so potency_view picks which side of that split you get: the default "potency_ranked" returns the measurements that have one, most potent first (ChEMBL sorts the rest first otherwise, which is why they are not merged), and "null_potency" returns exactly the measurements that have none. totalCount is the honest full match count across both views either way. Mixing measurement types (IC50 vs Ki) is a scientific error — set standard_type to compare like with like. A popular target carries tens of thousands of rows: results spill to a DataCanvas table (call chembl_dataframe_describe for its columns, then chembl_dataframe_query for honest aggregates across the staged set), while an inline preview answers the immediate question. Each view stages its own table (bioactivities / bioactivities_null_potency), so running both against one canvas_id lets a UNION ALL rebuild the full set. A canvas is minted only when a view spills; pass its canvas_id back and every later non-cursor call re-stages the table of its view with its own rows, even when they fit inline or none match, so a successful call never leaves rows from an earlier query in it, and a spill that fails or is cancelled leaves the earlier table in place. The spill is bounded by a row cap (CHEMBL_MAX_SPILL_ROWS) and a time budget (CHEMBL_SPILL_DEADLINE_MS); when either stops it short of the view, truncated is true, truncated_by names the bound, and the table is a bounded slice, not the complete view. The inline rows are always capped at limit, so compare that against totalCount before treating them as the whole answer. Spilling needs the canvas, which is on unless the server sets CANVAS_PROVIDER_TYPE=none. Whenever a call stages nothing and rows remain past this page — the canvas is off, or the view fit inline with no canvas_id — nextCursor continues the view: pass it back as cursor, with the same filters and potency_view, for the next page. A cursor page is always returned inline and never staged, canvas or not.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    molecule_chembl_id: optionalMoleculeRefInput.describe(
      'ChEMBL molecule ID (from chembl_search_molecules), e.g. "CHEMBL941". Supply this, target_chembl_id, or both — both narrows to that compound–target pair.',
    ),
    include_alternate_forms: z
      .boolean()
      .default(false)
      .describe(
        "Widen molecule_chembl_id to its whole family: the parent it belongs to and every salt and other alternate form ChEMBL files under it (a drug's measurements are often split across them). A salt's ID reaches its parent's family; each row keeps the molecule_chembl_id of the form it was measured on. Requires molecule_chembl_id; combines with target_chembl_id and every filter. Defaults to false: that one form's measurements only.",
      ),
    target_chembl_id: optionalChemblIdInput(
      'Must be a ChEMBL target ID like CHEMBL203 — find one with chembl_search_targets.',
    ).describe(
      'ChEMBL target ID (from chembl_search_targets), e.g. "CHEMBL203". Supply this, molecule_chembl_id, or both — both narrows to that compound–target pair.',
    ),
    standard_type: z
      .string()
      .optional()
      .describe(
        'Restrict to one measurement type, e.g. "IC50", "Ki", "EC50". Matched exactly, case included — ChEMBL records distinct types that differ only by case, such as "Kd" and "KD". Set this to compare potencies validly.',
      ),
    pchembl_value_min: z
      .number()
      .optional()
      .describe(
        'Minimum pchembl_value (−log10 molar potency), e.g. 7 keeps sub-100 nM activities. Only valid on the potency_ranked view — the null_potency rows have no pchembl_value to compare against.',
      ),
    potency_view: z
      .enum(['potency_ranked', 'null_potency'])
      .default('potency_ranked')
      .describe(
        'Which side of the pchembl_value presence split to retrieve. "potency_ranked" (default) returns the measurements that have a derivable pchembl_value, most potent first. "null_potency" returns exactly the measurements that have none — the rows the ranked view excludes, otherwise unreachable. The two partition the match set and stage to separate canvas tables.',
      ),
    assay_type: assayTypeInput.describe(
      'Restrict to an assay type code: "B" (binding), "F" (functional), "A" (ADMET), "T" (toxicity), "P" (physicochemical), "U" (unassigned).',
    ),
    organism: z
      .string()
      .optional()
      .describe(
        'Restrict to a target organism, e.g. "Homo sapiens" (case-insensitive exact match).',
      ),
    variant: z
      .string()
      .optional()
      .describe(
        'Restrict to one assay variant of the target. "wild_type" keeps the measurements that record no variant. Any other value keeps those whose recorded assay_variant_mutation equals it whole, case-insensitively, with spaces beside "," or "/" ignored: a substitution ("T315I"), a deletion ("F508del"), a multi-mutant in the order ChEMBL records it ("L858R,T790M"; "T790M,L858R" matches nothing, and "L858R" alone matches only the single mutant), or "UNDEFINED MUTATION" for an unspecified mutant. Read assay_variant_mutation on unfiltered rows for the recorded strings.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIMIT_CEILING)
      .optional()
      .describe(
        'Maximum rows in the inline preview or cursor page, up to 1000 — a larger value is served at 1000, with a notice saying so. Defaults to the server default (25). With the canvas enabled, a view that spills still stages in full whatever the limit; when a call stages nothing, nextCursor reaches the rows past limit.',
      ),
    canvas_id: CanvasIdSchema.optional().describe(
      "Optional canvas ID from a prior call to reuse the same canvas. With it, the call re-stages the selected potency_view's table with this call's rows whether they spill, fit inline, or are empty, so a second query of the SAME view REPLACES (overwrites) its prior rows once it succeeds — it does not append, and a spill that fails or is cancelled leaves them — while the other view's table is left intact, which is what lets both coexist on one canvas. Omit it and a fresh canvas is minted only if the view spills. Left untouched on a cursor page, which never stages.",
    ),
    cursor: z
      .string()
      .optional()
      .describe(
        "Opaque continuation token from a previous call's nextCursor — resumes the view where that page ended. Omit for the first page. Re-send the same molecule_chembl_id/target_chembl_id, include_alternate_forms, filters, and potency_view that minted it (only limit may change; it sets this page's size); redeeming it against different filters walks a different result set. A cursor page is returned inline and never staged, even with the canvas enabled.",
      ),
  }),
  output: z.object({
    activities: z
      .array(ActivitySchema)
      .describe(
        'Bioactivity rows for the selected potency_view — the inline preview, the cursor page, or the full view when it fit without spilling.',
      ),
    totalCount: z
      .number()
      .describe(
        'Total matching measurements upstream — the honest full count spanning BOTH potency views, before any preview cap. The staged/preview rows are the selected view of this.',
      ),
    potency_view: z
      .enum(['potency_ranked', 'null_potency'])
      .describe(
        'Which view these rows came from: "potency_ranked" = measurements with a derivable pchembl_value; "null_potency" = measurements with none. Re-call with the other value to reach the rest of totalCount.',
      ),
    spilled: z
      .boolean()
      .describe(
        'True when the view exceeded the inline preview and spilled to the canvas. False when it fit inline — including an inline fit re-staged on a supplied canvas_id, which table_name and staged_row_count report.',
      ),
    canvas_id: z
      .string()
      .nullable()
      .describe(
        'Canvas ID holding the staged table — pass to chembl_dataframe_describe to list its columns, then to chembl_dataframe_query to run SQL over them. Null when nothing was staged: canvas disabled, a cursor page, or an inline fit with no canvas_id supplied.',
      ),
    table_name: z
      .string()
      .nullable()
      .describe(
        'Canvas table name holding the staged rowset, and the FROM target for chembl_dataframe_query SQL — "bioactivities" for potency_ranked, "bioactivities_null_potency" for null_potency. Null when nothing was staged.',
      ),
    staged_row_count: z
      .number()
      .nullable()
      .describe(
        'Rows actually registered on the canvas table — 0 when a re-staged view matched nothing. Null when nothing was staged. Below the view total when truncated is true.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when a bound stopped the page walk short of the view — the CHEMBL_MAX_SPILL_ROWS row cap or the CHEMBL_SPILL_DEADLINE_MS time budget, as truncated_by says. The staged table is then a bounded slice, NOT the complete view, so aggregates over it are a sample. Narrow the filters to bring the view under the bound.',
      ),
    truncated_by: z
      .enum(['row_cap', 'time_budget'])
      .nullable()
      .describe(
        'The bound that cut the staged table short when truncated is true: "row_cap" — the CHEMBL_MAX_SPILL_ROWS cap; "time_budget" — the CHEMBL_SPILL_DEADLINE_MS budget ended the page walk, at its expiry or once what was left would not hold another page, so a re-call can stage more. Null when truncated is false.',
      ),
    canvasDisabled: z
      .boolean()
      .describe(
        'True when the server runs with the canvas off (CANVAS_PROVIDER_TYPE=none), so large sets could not spill — the inline rows are one page of the view, not the full set, and nextCursor continues it.',
      ),
    nextCursor: z
      .string()
      .optional()
      .describe(
        'Opaque token for the next page of this view — pass it back as cursor with the same filters and potency_view. Minted only when nothing was staged and rows remain past this page: with the canvas disabled, on a cursor page, or when the view fit inline with no canvas_id supplied. Absent on the last page and whenever the call staged a table (a spill, or an inline fit re-staged on a supplied canvas_id).',
      ),
  }),
  enrichment: {
    appliedFilters: z
      .object({
        scope: z
          .string()
          .describe(
            'Which IDs scoped the query: the molecule, the target, or both when it narrowed to a compound–target pair. Under include_alternate_forms the molecule side names the family parent whose forms were read.',
          ),
        standard_type: z.string().nullable().describe('The standard_type filter applied, or null.'),
        pchembl_value_min: z
          .number()
          .nullable()
          .describe('The pchembl_value_min filter applied, or null.'),
        assay_type: z.string().nullable().describe('The assay_type filter applied, or null.'),
        organism: z.string().nullable().describe('The organism filter applied, or null.'),
        variant: z
          .string()
          .nullable()
          .describe(
            'The variant filter applied — "wild_type", or the variant string matched, spaces beside separators removed — or null.',
          ),
      })
      .describe('Filters as the server parsed them.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no measurements matched (naming the spelling ChEMBL records when the standard_type sent differs from it only by case), how to SQL the staged set, or which rows of the view an inline page holds and how to continue it — led by the disclosure that a limit above the maximum was served at the maximum.',
      ),
  },
  enrichmentTrailer: {
    appliedFilters: {
      render: (f) =>
        `### Filters\n- Scope: ${f.scope}\n- standard_type: ${f.standard_type ?? '—'} | pchembl_value_min: ${f.pchembl_value_min ?? '—'} | assay_type: ${f.assay_type ?? '—'} | organism: ${f.organism ?? '—'} | variant: ${f.variant ?? '—'}`,
    },
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
      reason: 'missing_filter',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither molecule_chembl_id nor target_chembl_id was supplied, so the query had nothing to scope to.',
      recovery:
        'Supply molecule_chembl_id (from chembl_search_molecules), target_chembl_id (from chembl_search_targets), or both to narrow to one compound–target pair.',
    },
    {
      reason: 'not_a_chembl_id',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'molecule_chembl_id is not a ChEMBL ID like CHEMBL941, so it could match no measurement.',
      recovery:
        'Find the compound with chembl_search_molecules and pass the molecule_chembl_id it returns, e.g. "CHEMBL941".',
    },
    {
      reason: 'alternate_forms_without_molecule',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'include_alternate_forms was set without molecule_chembl_id, so there was no molecule whose family to read.',
      recovery:
        'Supply molecule_chembl_id (from chembl_search_molecules) alongside include_alternate_forms, or drop the flag to query the target alone.',
    },
    {
      reason: 'contradictory_potency_filter',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'pchembl_value_min was supplied alongside potency_view "null_potency", whose rows have no pchembl_value for the floor to compare against — the combination can only ever match zero measurements.',
      recovery:
        'Drop pchembl_value_min to browse the null-potency measurements, or leave potency_view at "potency_ranked" to apply the potency floor.',
    },
    {
      reason: 'canvas_capacity_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The view spilled with no canvas_id supplied, and the tenant already holds as many canvases as CANVAS_MAX_CANVASES_PER_TENANT allows, so none could be minted to stage it.',
      recovery:
        'Pass a canvas_id from an earlier chembl_get_bioactivities response to stage on that canvas (replacing its table for the same potency_view), narrow the filters until the view fits inline (an inline fit needs no canvas), or retry once idle canvases expire.',
      retryable: true,
    },
  ],

  async handler(input, ctx) {
    // The schema has trimmed both IDs, uppercased a ChEMBL ID, and read a blank as unset.
    const moleculeId = input.molecule_chembl_id;
    const targetId = input.target_chembl_id;

    /**
     * At-least-one gate — Zod cannot express a cross-field requirement, so enforce
     * here. Both together is a legitimate query: ChEMBL ANDs the two filters, so the
     * pair resolves to the measurements of that one compound against that one target.
     */
    if (!moleculeId && !targetId) {
      throw ctx.fail('missing_filter');
    }
    if (input.include_alternate_forms && !moleculeId) {
      throw ctx.fail('alternate_forms_without_molecule');
    }
    /**
     * The molecule filter matches a ChEMBL ID exactly, so any other reference would
     * return an empty success. Under include_alternate_forms the reference is
     * resolved through its molecule record instead, which also answers an InChIKey
     * or a structure, so it is not gated there.
     */
    if (moleculeId && !input.include_alternate_forms && !isChemblId(moleculeId)) {
      throw ctx.fail('not_a_chembl_id');
    }

    const view: PotencyView = input.potency_view;

    /**
     * A potency floor over rows defined by having no potency matches nothing. Fail
     * loudly rather than returning an empty set that reads as "ChEMBL has no such
     * measurements" — and rather than silently dropping one of the two filters.
     */
    if (view === 'null_potency' && input.pchembl_value_min !== undefined) {
      throw ctx.fail('contradictory_potency_filter');
    }

    /**
     * Decoding is the boundary check, ahead of every upstream request: ChEMBL
     * answers a negative, non-numeric, or empty offset with page one (HTTP 200), so
     * a corrupted cursor forwarded unchecked would return page one dressed as a
     * later page. `decodeCursor` throws InvalidParams (-32602), which propagates
     * unwrapped. Only the offset is read back: `limit` stays this call's. A blank
     * cursor (form clients send "") counts as omitted.
     */
    const cursor = input.cursor?.trim() || undefined;
    const cursorOffset = cursor ? decodeCursor(cursor, ctx).offset : undefined;

    const config = getServerConfig();
    const { limit, notice: limitNotice } = clampLimit(
      input.limit ?? config.defaultLimit,
      MAX_LIMIT,
    );
    /** Write the call's one notice: the limit clamp, when there was one, ahead of the result's own. */
    const disclose = (notice: string | undefined) => {
      const text = [limitNotice, notice].filter(Boolean).join(' ');
      if (text) ctx.enrich.notice(text);
    };
    const service = getChemblService();
    const standardType = input.standard_type?.trim() || undefined;
    // The schema has mapped a code or ChEMBL's name for it to the code.
    const assayType = input.assay_type;
    const organism = input.organism?.trim() || undefined;
    const variant = parseVariant(input.variant);

    const canvas = getCanvas();
    const inlinePage = !canvas || cursorOffset !== undefined;
    /**
     * One time budget for every upstream request of the call: a spill's count and
     * concurrent page walk share CHEMBL_SPILL_DEADLINE_MS (#16), and an inline
     * page's count and pages share the per-call budget every other tool gets (#33).
     * The family parent lookup draws on it too.
     */
    const deadline = new CallDeadline(inlinePage ? CALL_DEADLINE_MS : config.spillDeadlineMs);

    /**
     * Under include_alternate_forms the molecule record names the family parent,
     * and the parent filter replaces the molecule filter in the shared params, so
     * the count, both views, cursor pages, and the spill all read the same family.
     * A lookup failure fails the call — 404 as not_found — rather than falling back
     * to the one form, which would answer a different question.
     */
    const molecule: GetActivitiesOptions['molecule'] = !moleculeId
      ? undefined
      : input.include_alternate_forms
        ? {
            scope: 'family',
            id: (await service.getMolecule(moleculeId, ctx, deadline)).parent_chembl_id,
          }
        : { scope: 'form', id: moleculeId };
    const moleculeScope =
      molecule?.scope === 'family'
        ? `molecule ${moleculeId} with its alternate forms (parent ${molecule.id})`
        : `molecule ${moleculeId}`;

    ctx.enrich({
      appliedFilters: {
        // Name both sides when both narrowed the query — reporting only the molecule
        // would read as an unfiltered compound sweep the caller never asked for.
        scope:
          moleculeId && targetId
            ? `${moleculeScope} × target ${targetId}`
            : moleculeId
              ? moleculeScope
              : `target ${targetId}`,
        standard_type: standardType ?? null,
        pchembl_value_min: input.pchembl_value_min ?? null,
        assay_type: assayType ?? null,
        organism: organism ?? null,
        variant: variant ? (variant.kind === 'wild_type' ? 'wild_type' : variant.mutation) : null,
      },
    });

    const filters: GetActivitiesOptions = {
      molecule,
      targetChemblId: targetId,
      standardType,
      pchemblValueMin: input.pchembl_value_min,
      assayType,
      organism,
      variant,
      potencyView: view,
    };

    // Two-phase (#3): totalCount is the honest full match count from a separate
    // count call (no pchembl_value presence filter), so it spans both views; the
    // preview/spill stream carries the presence filter for the selected view.
    // viewTotal is that view's own upstream count — equal to totalCount only when
    // the split excluded nothing (e.g. a pchembl_value_min floor already had).
    const totalCount = await service.countActivities(filters, ctx, deadline);
    /**
     * standard_type stays an exact match: ChEMBL records distinct types that differ
     * only by case (Kd / KD), so matching case-insensitively would change answers
     * that are right as sent. When nothing matched, one best-effort lookup names a
     * case variant ChEMBL records under the same filters, for the notice.
     */
    const recordedType =
      totalCount === 0 && standardType
        ? await service.findStandardTypeSpelling(filters, ctx, deadline)
        : null;
    const typeVariant =
      standardType && recordedType
        ? { requested: standardType, recorded: recordedType }
        : undefined;
    let viewTotal = 0;
    const onViewTotal = (total: number) => {
      viewTotal = total;
    };

    /**
     * Budget for spillover's drain buffer — it decides fit-vs-spill and feeds the
     * overflow sentinel, and nothing else: the inline rows come from the walk's
     * first `limit` rows (`head` below), so a spill shows a full `limit` however
     * few rows the buffer held. Real rows serialize to 690–870 characters on
     * average, so 800 per row puts the line at about `limit` average rows: a view
     * much larger than `limit` spills and stays SQL-queryable from its canvas_id,
     * rather than coming back as one page and a cursor with nothing staged. The
     * floor fits a small view of ~60 rows inline at any `limit`.
     */
    const previewChars = Math.max(50_000, limit * 800);

    if (inlinePage) {
      /**
       * Inline page — the canvas is disabled, or a cursor asked for a window of the
       * view. A cursor page is served this same way with the canvas enabled: it
       * never stages, so it acquires no canvas and leaves a supplied canvas_id as
       * it was. Up to `limit` rows from the cursor's offset, drained manually so
       * the page is capped at the limit rather than the spill budget; `limit` maxes
       * out at 1000, so this path needs no row cap. The upstream pages are `limit`
       * rows (at most CHEMBL_MAX_PAGE_SIZE): a full page would be downloaded only
       * to be discarded.
       */
      const offset = cursorOffset ?? 0;
      const preview: Activity[] = [];
      for await (const row of service.streamActivities(
        { ...filters, offset, pageSize: limit },
        ctx,
        onViewTotal,
        deadline,
      )) {
        preview.push(row);
        if (preview.length >= limit) break;
      }
      /**
       * The view's own total decides whether rows remain. Omitted — never `null`
       * or `''` — on the last page, per the MCP pagination contract; an empty page
       * never mints one either, since a cursor at the same offset would not advance.
       */
      const nextOffset = offset + preview.length;
      const hasMore = preview.length > 0 && nextOffset < viewTotal;
      const notice = buildNotice({
        view,
        variant,
        typeVariant,
        previewCount: preview.length,
        totalCount,
        viewTotal,
        spilled: false,
        stagedRows: null,
        fetchedRows: preview.length,
        truncatedBy: null,
        rowCap: config.maxSpillRows,
        deadlineMs: config.spillDeadlineMs,
        canvasDisabled: !canvas,
        canvasId: input.canvas_id,
        page: { offset, hasMore },
      });
      disclose(notice);
      return {
        activities: preview,
        totalCount,
        potency_view: view,
        spilled: false,
        canvas_id: null,
        table_name: null,
        staged_row_count: null,
        truncated: false,
        truncated_by: null,
        canvasDisabled: !canvas,
        ...(hasMore && { nextCursor: encodeCursor({ offset: nextOffset, limit }) }),
      };
    }

    /**
     * A supplied canvas_id is resolved first, so an unknown or expired id fails
     * before the spill walk. Without one, nothing is minted until the view spills
     * (#28). The framework's refusal at the tenant's canvas cap carries a hint
     * offering a drop tool, which frees no canvas here, so it is re-raised under
     * this tool's contract with the original on `cause`.
     */
    const instance =
      input.canvas_id === undefined
        ? mintOnSpill(canvas, ctx, () =>
            canvas.acquire(undefined, ctx).catch((error: unknown) => {
              if (error instanceof McpError && error.data?.reason === 'canvas_capacity_exhausted') {
                throw ctx.fail(
                  'canvas_capacity_exhausted',
                  error.message,
                  {
                    tenantId: error.data.tenantId,
                    activeCount: error.data.activeCount,
                    cap: error.data.cap,
                  },
                  { cause: error },
                );
              }
              throw error;
            }),
          )
        : await canvas.acquire(input.canvas_id, ctx);
    // Every write of this call's rows to the canvas ends up in this table.
    const tableName = VIEW[view].table;
    /**
     * A supplied canvas holds this view's table from an earlier call, so its spill
     * registers under a name of its own and replaces the table only once it
     * succeeds (#28). A minted canvas holds no earlier table and spills straight to
     * the view's name.
     */
    const spillTable =
      input.canvas_id === undefined
        ? tableName
        : `${tableName}_staging_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;

    /**
     * The walk fetches the view's pages concurrently in CHEMBL_MAX_PAGE_SIZE pages,
     * stopping short of CHEMBL_MAX_SPILL_ROWS (#14) and ending at the contiguous
     * prefix it holds if the time budget ends it (#16). spillover's row type is
     * Record<string, unknown>; an Activity is structurally a string-keyed record, so
     * the source is widened for the generic constraint. The walk is closed here on
     * every outcome, an early stop or a failed spill included, releasing any page
     * still in flight.
     */
    let deadlineHit = false;
    const source = service.spillActivities(filters, ctx, {
      deadline,
      maxRows: config.maxSpillRows,
      onTotal: onViewTotal,
      onDeadline: () => {
        deadlineHit = true;
      },
    });
    /** The walk's first `limit` rows, kept as they pass to spillover — the inline preview. */
    const head: Activity[] = [];
    async function* keepHead(): AsyncGenerator<Activity> {
      for await (const row of source) {
        if (head.length < limit) head.push(row);
        yield row;
      }
    }
    const result = await spillover<Activity & Record<string, unknown>>({
      canvas: instance,
      source: keepHead() as AsyncIterable<Activity & Record<string, unknown>>,
      previewChars,
      tableName: spillTable,
      schema: ACTIVITY_CANVAS_SCHEMA,
      caps: { maxRows: config.maxSpillRows },
      signal: ctx.signal,
    }).finally(() => source.return(undefined));

    /**
     * The bound that left rows of the view out of what the call fetched or staged
     * (#14, #16): the time budget when it ended the walk, the row cap when the rows
     * reached it. A walk that ended on a short page before the view total
     * `page_meta.total_count` reported, with neither bound reached, names none.
     */
    const boundOf = (rows: number): TruncatedBy | null =>
      rows >= viewTotal
        ? null
        : deadlineHit
          ? 'time_budget'
          : rows >= config.maxSpillRows
            ? 'row_cap'
            : null;

    /**
     * `limit` bounds the inline preview on every branch. spillover sizes its
     * preview buffer by the character budget, not by row count, so the preview is
     * the walk's first `limit` rows rather than that buffer — never the budget
     * itself, which is what drives the fit-vs-spill decision and its overflow
     * sentinel. Rows past the cap stay reachable on the staged table when the view
     * spilled or a supplied canvas_id had the fit re-staged, and through nextCursor
     * when it fit inline with no canvas_id, as on the canvas-disabled branch above.
     */
    const preview = head;

    if (result.spilled) {
      if (spillTable !== tableName) await promoteStaged(instance, spillTable, tableName, ctx);
      const truncatedBy = boundOf(result.handle.rowCount);
      const notice = buildNotice({
        view,
        variant,
        typeVariant,
        previewCount: preview.length,
        totalCount,
        viewTotal,
        spilled: true,
        stagedRows: result.handle.rowCount,
        fetchedRows: result.handle.rowCount,
        truncatedBy,
        rowCap: config.maxSpillRows,
        deadlineMs: config.spillDeadlineMs,
        canvasDisabled: false,
        canvasId: instance.canvasId,
      });
      disclose(notice);
      return {
        activities: preview,
        totalCount,
        potency_view: view,
        spilled: true,
        canvas_id: instance.canvasId,
        table_name: tableName,
        staged_row_count: result.handle.rowCount,
        truncated: truncatedBy !== null,
        truncated_by: truncatedBy,
        canvasDisabled: false,
      };
    }

    if (input.canvas_id !== undefined) {
      /**
       * The view fit inline, but the caller named a canvas: re-stage the view's
       * table with these rows (#31) so describe and SQL never serve an earlier
       * query's rows as this one's. Zero rows stage an empty table with the full
       * schema. The fit holds the whole view, rows past `limit` included, so the
       * table gets all of it up to the spill cap. The write takes its turn on the
       * table, and a cancellation observed by then leaves the earlier table.
       */
      const staged = result.previewRows.slice(0, config.maxSpillRows);
      const handle = await onViewTable(instance, tableName, () => {
        ctx.signal.throwIfAborted();
        return instance.registerTable(tableName, staged, { schema: ACTIVITY_CANVAS_SCHEMA });
      });
      const truncatedBy = boundOf(handle.rowCount);
      const notice = buildNotice({
        view,
        variant,
        typeVariant,
        previewCount: preview.length,
        totalCount,
        viewTotal,
        spilled: false,
        stagedRows: handle.rowCount,
        fetchedRows: result.previewRows.length,
        truncatedBy,
        rowCap: config.maxSpillRows,
        deadlineMs: config.spillDeadlineMs,
        canvasDisabled: false,
        canvasId: instance.canvasId,
      });
      disclose(notice);
      return {
        activities: preview,
        totalCount,
        potency_view: view,
        spilled: false,
        canvas_id: instance.canvasId,
        table_name: handle.tableName,
        staged_row_count: handle.rowCount,
        truncated: truncatedBy !== null,
        truncated_by: truncatedBy,
        canvasDisabled: false,
      };
    }

    /**
     * Nothing staged, so the output reports no truncation; the notice still names
     * a bound that stopped the walk short of the view, so the inline rows are not
     * read as everything there is. A short final page alone names none. Rows past
     * this page — held back by `limit`, or never fetched because a bound stopped
     * the walk — continue through a cursor from the offset this page ends at,
     * which the cursor-page branch above serves (#17).
     */
    const fetchedRows = result.previewRows.length;
    const hasMore = preview.length > 0 && preview.length < viewTotal;
    const notice = buildNotice({
      view,
      variant,
      typeVariant,
      previewCount: preview.length,
      totalCount,
      viewTotal,
      spilled: false,
      stagedRows: null,
      fetchedRows,
      truncatedBy: boundOf(fetchedRows),
      rowCap: config.maxSpillRows,
      deadlineMs: config.spillDeadlineMs,
      canvasDisabled: false,
    });
    disclose(notice);
    return {
      activities: preview,
      totalCount,
      potency_view: view,
      spilled: false,
      canvas_id: null,
      table_name: null,
      staged_row_count: null,
      truncated: false,
      truncated_by: null,
      canvasDisabled: false,
      ...(hasMore && { nextCursor: encodeCursor({ offset: preview.length, limit }) }),
    };
  },

  format: (result) => {
    const spillNote = result.spilled
      ? `spilled: yes — staged on canvas \`${result.canvas_id}\` as table \`${result.table_name}\` (chembl_dataframe_describe for the columns, then chembl_dataframe_query to SQL them)`
      : result.table_name !== null
        ? `spilled: no — the view fit inline and was re-staged on canvas \`${result.canvas_id}\` as table \`${result.table_name}\` (chembl_dataframe_describe for the columns, then chembl_dataframe_query to SQL them)`
        : result.canvasDisabled
          ? 'spilled: no — canvas disabled; these rows are a capped preview, not the complete set'
          : result.activities.length === result.totalCount
            ? 'spilled: no (preview is the full set)'
            : `spilled: no — showing ${result.activities.length} of ${result.totalCount} matching measurements (${result.potency_view} view)`;
    const otherView = result.potency_view === 'null_potency' ? 'potency_ranked' : 'null_potency';
    // Truncation rides its own line so a capped table can never read as complete.
    const stagingNote = [
      `potency_view: \`${result.potency_view}\` — re-call with \`${otherView}\` for the measurements this view excludes`,
      `staged_row_count: ${result.staged_row_count ?? '— (nothing staged)'}`,
      result.truncated
        ? `truncated: yes (truncated_by: ${result.truncated_by}) — ${
            result.truncated_by === 'time_budget'
              ? 'the time budget (CHEMBL_SPILL_DEADLINE_MS) ended the page walk'
              : 'the row cap was hit (CHEMBL_MAX_SPILL_ROWS)'
          }, so the staged table is a bounded slice of a larger upstream set, NOT the complete view`
        : 'truncated: no',
    ].join(' | ');
    const header = `**${result.totalCount}** measurements total — ${spillNote}.\n${stagingNote}`;
    if (result.activities.length === 0) {
      return [{ type: 'text', text: `${header}\n\nNo rows in preview.` }];
    }
    const rows = result.activities.map((a) => {
      // Relation, value, and units escape as one string, so a construct spanning them is seen whole.
      const potency =
        a.standard_value != null
          ? mdInline(
              `${a.standard_relation ?? ''}${a.standard_value} ${a.standard_units ?? ''}`.trim(),
            )
          : 'not reported';
      const pchembl = a.pchembl_value != null ? a.pchembl_value.toString() : '—';
      const raw =
        a.value != null
          ? mdInline(`${a.relation ?? ''}${a.value} ${a.units ?? ''}`.trim())
          : 'not reported';
      // Segments render only when present, so an unannotated row reads as before.
      const comments = [
        a.activity_comment !== null && ` | activity_comment: ${mdInline(a.activity_comment)}`,
        a.data_validity_comment !== null &&
          ` | data_validity_comment: ${mdInline(a.data_validity_comment)}`,
      ];
      const provenance = [
        (a.assay_variant_mutation !== null || a.assay_variant_accession !== null) &&
          ` | variant: ${mdInline(a.assay_variant_mutation ?? '—')}${a.assay_variant_accession !== null ? ` (${mdInline(a.assay_variant_accession)})` : ''}`,
        (a.document_chembl_id !== null || a.document_year !== null) &&
          ` | document ${mdInline(a.document_chembl_id ?? '—')}${a.document_year !== null ? ` (${a.document_year})` : ''}`,
      ];
      return [
        `**${mdInline(a.molecule_chembl_id)}** (${mdInline(a.molecule_pref_name ?? '—')}) → **${mdInline(a.target_chembl_id)}** (${mdInline(a.target_pref_name ?? '—')}) [${mdInline(a.target_organism ?? '—')}]`,
        // standard_type begins its line, where a leading `#` or `>` would open a block.
        `${mdLineStart(a.standard_type ?? '—')}: ${potency} | pChEMBL: ${pchembl} | raw ${mdInline(a.type ?? '—')}: ${raw}${comments.filter(Boolean).join('')}`,
        `assay ${mdInline(a.assay_chembl_id)} (${mdInline(a.assay_type ?? '—')}): ${mdInline(a.assay_description ?? '—')} | activity_id ${a.activity_id}${provenance.filter(Boolean).join('')}`,
      ].join('\n');
    });
    /**
     * Content-only clients read this surface, not structuredContent — without the
     * line they cannot tell a page from the whole view, or reach the next one.
     */
    if (result.nextCursor) {
      rows.push(
        `More rows remain in this view — re-call with cursor="${result.nextCursor}" and the same filters and potency_view for the next page.`,
      );
    }
    return [{ type: 'text', text: `${header}\n\n${rows.join('\n\n')}` }];
  },
});
