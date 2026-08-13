/**
 * @fileoverview chembl_get_bioactivities — the flagship compound↔target↔assay
 * bridge. Returns bioactivity measurements for a molecule, a target, or both
 * together (which narrows to that compound–target pair), filterable by
 * standard_type, potency (pchembl_value), assay type, and organism, ranked on
 * pchembl_value. `potency_view` selects which side of the pchembl_value presence
 * split is retrieved; each view spills to its own DataCanvas table the caller
 * inspects with chembl_dataframe_describe and SQLs with chembl_dataframe_query,
 * bounded by the CHEMBL_MAX_SPILL_ROWS cap and reporting a capped table as
 * truncated rather than as the complete set. `limit` bounds the rows returned
 * inline on every branch — spilled, fit inline, or canvas disabled.
 * @module mcp-server/tools/definitions/chembl-get-bioactivities
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getChemblService } from '@/services/chembl/chembl-service.js';
import type { Activity, GetActivitiesOptions, PotencyView } from '@/services/chembl/types.js';

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
  })
  .describe('One bioactivity measurement linking a compound, target, and assay.');

/**
 * Compose the agent-facing notice for a bioactivities result. Names which side of
 * the pchembl_value split was returned and how to reach the other (so the honest
 * totalCount and the narrower view never appear to contradict each other), plus
 * the spill / row-cap / canvas-disabled / empty-result context. Returns undefined
 * when there is nothing worth saying (canvas enabled, fit inline, limit held
 * nothing back, whole match set in view).
 */
function buildNotice(args: {
  view: PotencyView;
  previewCount: number;
  totalCount: number;
  viewTotal: number;
  spilled: boolean;
  stagedRows: number | null;
  truncated: boolean;
  rowCap: number;
  canvasDisabled: boolean;
  canvasId?: string;
}): string | undefined {
  const {
    view,
    previewCount,
    totalCount,
    viewTotal,
    spilled,
    stagedRows,
    truncated,
    rowCap,
    canvasDisabled,
    canvasId,
  } = args;
  const nullView = view === 'null_potency';
  const otherView: PotencyView = nullView ? 'potency_ranked' : 'null_potency';

  if (previewCount === 0) {
    if (totalCount === 0) {
      return 'No measurements matched. Broaden the filters (drop standard_type or lower pchembl_value_min), or check the ID.';
    }
    return nullView
      ? `Every one of the ${totalCount} matching measurements carries a derivable pchembl_value, so the null_potency view is empty. The default potency_view: "potency_ranked" holds all ${totalCount}.`
      : `All ${totalCount} matching measurements lack a derivable pchembl_value, so none appear in this potency-ranked view — the measurements exist but report no comparable potency. Re-call with potency_view: "null_potency" to retrieve them.`;
  }

  /**
   * Which view this is and how to reach the other. Suppressed on the default view
   * when nothing was excluded (a pchembl_value_min floor already removed the null
   * rows, so there is no second view to point at).
   */
  const excluded = totalCount - viewTotal;
  const crossRef = nullView
    ? ` Null-potency view: this holds the ${viewTotal} measurements with no derivable pchembl_value, of ${totalCount} matching. The default potency_view: "${otherView}" holds the other ${excluded}.`
    : excluded > 0
      ? ` Ranked by potency: this view holds the ${viewTotal} measurements with a pchembl_value; ${totalCount} match in total. Re-call with potency_view: "${otherView}" for the other ${excluded} (the rest report none).`
      : '';

  const capNote = truncated
    ? ` Capped: the staged table holds ${stagedRows} rows of a larger upstream set (CHEMBL_MAX_SPILL_ROWS=${rowCap}), not the complete view — narrow with ${VIEW[view].narrowWith}, or read SQL aggregates over it as a bounded sample.`
    : '';

  if (spilled) {
    return `${stagedRows} measurements staged as table "${VIEW[view].table}" on canvas ${canvasId}. List its columns with chembl_dataframe_describe, then SQL the staged set with chembl_dataframe_query — e.g. ${VIEW[view].sqlExample}.${capNote}${crossRef}`;
  }

  /**
   * What the caller holds versus what the view holds. Both no-spill branches land
   * here: nothing was staged, so `limit` is the only bound on the rows returned
   * and everything past it needs a wider re-call.
   */
  const previewBound =
    previewCount < viewTotal
      ? `Showing ${previewCount} of the ${viewTotal} rows in this view; the rest were not returned — raise limit for more.`
      : `Showing all ${viewTotal} rows in this view.`;

  if (canvasDisabled) {
    return `Canvas disabled (CANVAS_PROVIDER_TYPE != duckdb): ${previewBound} Nothing spilled — set CANVAS_PROVIDER_TYPE=duckdb to SQL the staged set.${crossRef}`;
  }

  // Canvas enabled, everything fit inline — worth a note only when `limit` held
  // rows back, or when a second view exists.
  return `${previewCount < viewTotal ? previewBound : ''}${crossRef}`.trim() || undefined;
}

export const chemblGetBioactivities = tool('chembl_get_bioactivities', {
  title: 'chembl-get-bioactivities',
  description:
    'The flagship compound↔target bioactivity bridge: measurements for a molecule (target deconvolution / selectivity), a target (lead finding), or both together (how potently one compound hits one target). Supply at least one of molecule_chembl_id (from chembl_search_molecules) or target_chembl_id (from chembl_search_targets) — supplying both narrows to that compound–target pair, supplying neither is an error. Filter by standard_type (IC50/Ki/EC50/…), minimum potency pchembl_value_min, assay_type, and organism. Not every measurement has a derivable pchembl_value, so potency_view picks which side of that split you get: the default "potency_ranked" returns the measurements that have one, most potent first (ChEMBL sorts the rest first otherwise, which is why they are not merged), and "null_potency" returns exactly the measurements that have none. totalCount is the honest full match count across both views either way. Mixing measurement types (IC50 vs Ki) is a scientific error — set standard_type to compare like with like. A popular target carries tens of thousands of rows: results spill to a DataCanvas table (call chembl_dataframe_describe for its columns, then chembl_dataframe_query for honest aggregates across the staged set), while an inline preview answers the immediate question. Each view stages its own table (bioactivities / bioactivities_null_potency), so running both against one canvas_id lets a UNION ALL rebuild the full set. The staged table is capped at CHEMBL_MAX_SPILL_ROWS; when the cap is hit, truncated is true and the table is a bounded slice, not the complete view. The inline rows are always capped at limit, so compare that against totalCount before treating them as the whole answer. Spilling the rest requires CANVAS_PROVIDER_TYPE=duckdb; without it the inline preview is all there is.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    molecule_chembl_id: z
      .string()
      .optional()
      .describe(
        'ChEMBL molecule ID (from chembl_search_molecules), e.g. "CHEMBL941". Supply this, target_chembl_id, or both — both narrows to that compound–target pair.',
      ),
    target_chembl_id: z
      .string()
      .optional()
      .describe(
        'ChEMBL target ID (from chembl_search_targets), e.g. "CHEMBL203". Supply this, molecule_chembl_id, or both — both narrows to that compound–target pair.',
      ),
    standard_type: z
      .string()
      .optional()
      .describe(
        'Restrict to one measurement type, e.g. "IC50", "Ki", "EC50". Set this to compare potencies validly.',
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
    assay_type: z
      .string()
      .optional()
      .describe(
        'Restrict to an assay type code: "B" (binding), "F" (functional), "A" (ADMET), "T" (toxicity).',
      ),
    organism: z
      .string()
      .optional()
      .describe(
        'Restrict to a target organism, e.g. "Homo sapiens" (case-insensitive exact match).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        'Maximum rows in the inline preview. Defaults to the server default (25). The full set still spills to the canvas.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        "Optional canvas ID from a prior call to reuse the same canvas. Each potency_view re-stages its own table, so a second query of the SAME view REPLACES (overwrites) its prior rows — it does not append — while the other view's table is left intact, which is what lets both coexist on one canvas. Omit to mint a fresh canvas.",
      ),
  }),
  output: z.object({
    activities: z
      .array(ActivitySchema)
      .describe(
        'Bioactivity rows for the selected potency_view — the inline preview, or the full view when it fit without spilling.',
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
      .describe('True when the view exceeded the preview and was staged on the canvas.'),
    canvas_id: z
      .string()
      .nullable()
      .describe(
        'Canvas ID holding the staged table — pass to chembl_dataframe_describe to list its columns, then to chembl_dataframe_query to run SQL over them. Null when canvas is disabled or nothing spilled.',
      ),
    table_name: z
      .string()
      .nullable()
      .describe(
        'Canvas table name holding the staged rowset, and the FROM target for chembl_dataframe_query SQL — "bioactivities" for potency_ranked, "bioactivities_null_potency" for null_potency. Null when not spilled.',
      ),
    staged_row_count: z
      .number()
      .nullable()
      .describe(
        'Rows actually registered on the canvas table. Null when nothing spilled. Below the view total when truncated is true.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when the CHEMBL_MAX_SPILL_ROWS cap was hit before the upstream view was exhausted — the staged table is a bounded slice, NOT the complete view, so aggregates over it are a sample. Narrow the filters to bring the view under the cap.',
      ),
    canvasDisabled: z
      .boolean()
      .describe(
        'True when CANVAS_PROVIDER_TYPE is not duckdb, so large sets could not spill — the inline rows are a capped preview, not the full set.',
      ),
  }),
  enrichment: {
    appliedFilters: z
      .object({
        scope: z
          .string()
          .describe(
            'Which IDs scoped the query: the molecule, the target, or both when it narrowed to a compound–target pair.',
          ),
        standard_type: z.string().nullable().describe('The standard_type filter applied, or null.'),
        pchembl_value_min: z
          .number()
          .nullable()
          .describe('The pchembl_value_min filter applied, or null.'),
        assay_type: z.string().nullable().describe('The assay_type filter applied, or null.'),
        organism: z.string().nullable().describe('The organism filter applied, or null.'),
      })
      .describe('Filters as the server parsed them.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when no measurements matched, or how to SQL the spilled set.'),
  },
  enrichmentTrailer: {
    appliedFilters: {
      render: (f) =>
        `### Filters\n- Scope: ${f.scope}\n- standard_type: ${f.standard_type ?? '—'} | pchembl_value_min: ${f.pchembl_value_min ?? '—'} | assay_type: ${f.assay_type ?? '—'} | organism: ${f.organism ?? '—'}`,
    },
  },
  errors: [
    {
      reason: 'missing_filter',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither molecule_chembl_id nor target_chembl_id was supplied, so the query had nothing to scope to.',
      recovery:
        'Supply molecule_chembl_id (from chembl_search_molecules), target_chembl_id (from chembl_search_targets), or both to narrow to one compound–target pair.',
    },
    {
      reason: 'contradictory_potency_filter',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'pchembl_value_min was supplied alongside potency_view "null_potency", whose rows have no pchembl_value for the floor to compare against — the combination can only ever match zero measurements.',
      recovery:
        'Drop pchembl_value_min to browse the null-potency measurements, or leave potency_view at "potency_ranked" to apply the potency floor.',
    },
  ],

  async handler(input, ctx) {
    const moleculeId = input.molecule_chembl_id?.trim() || undefined;
    const targetId = input.target_chembl_id?.trim() || undefined;

    /**
     * At-least-one gate — Zod cannot express a cross-field requirement, so enforce
     * here. Both together is a legitimate query: ChEMBL ANDs the two filters, so the
     * pair resolves to the measurements of that one compound against that one target.
     */
    if (!moleculeId && !targetId) {
      throw ctx.fail('missing_filter', undefined, { ...ctx.recoveryFor('missing_filter') });
    }

    const view: PotencyView = input.potency_view;

    /**
     * A potency floor over rows defined by having no potency matches nothing. Fail
     * loudly rather than returning an empty set that reads as "ChEMBL has no such
     * measurements" — and rather than silently dropping one of the two filters.
     */
    if (view === 'null_potency' && input.pchembl_value_min !== undefined) {
      throw ctx.fail('contradictory_potency_filter', undefined, {
        ...ctx.recoveryFor('contradictory_potency_filter'),
      });
    }

    const config = getServerConfig();
    const limit = input.limit ?? config.defaultLimit;
    const service = getChemblService();
    const standardType = input.standard_type?.trim() || undefined;
    const assayType = input.assay_type?.trim() || undefined;
    const organism = input.organism?.trim() || undefined;

    ctx.enrich({
      appliedFilters: {
        // Name both sides when both narrowed the query — reporting only the molecule
        // would read as an unfiltered compound sweep the caller never asked for.
        scope:
          moleculeId && targetId
            ? `molecule ${moleculeId} × target ${targetId}`
            : moleculeId
              ? `molecule ${moleculeId}`
              : `target ${targetId}`,
        standard_type: standardType ?? null,
        pchembl_value_min: input.pchembl_value_min ?? null,
        assay_type: assayType ?? null,
        organism: organism ?? null,
      },
    });

    const filters: GetActivitiesOptions = {
      moleculeChemblId: moleculeId,
      targetChemblId: targetId,
      standardType,
      pchemblValueMin: input.pchembl_value_min,
      assayType,
      organism,
      potencyView: view,
      limit,
    };

    // Two-phase (#3): totalCount is the honest full match count from a separate
    // count call (no pchembl_value presence filter), so it spans both views; the
    // preview/spill stream carries the presence filter for the selected view.
    // viewTotal is that view's own upstream count — equal to totalCount only when
    // the split excluded nothing (e.g. a pchembl_value_min floor already had).
    const totalCount = await service.countActivities(filters, ctx);
    let viewTotal = 0;
    const activityStream = service.streamActivities(filters, ctx, (total) => {
      viewTotal = total;
    });

    const canvas = getCanvas();

    // Budget for spillover's drain buffer — what decides fit-vs-spill and feeds
    // its overflow sentinel, NOT the inline row cap. Scaled to the requested
    // limit (~600 chars/row) so the buffer always holds at least ~`limit` rows;
    // the rows actually returned are capped at `limit` below.
    const previewChars = Math.max(40_000, limit * 600);

    if (!canvas) {
      // Canvas disabled — inline up to `limit` rows, no spill. Drain manually so
      // the preview is capped at the limit rather than the spill budget. `limit`
      // maxes out at 1000, so this path is already bounded and needs no row cap.
      const preview: Activity[] = [];
      for await (const row of activityStream) {
        preview.push(row);
        if (preview.length >= limit) break;
      }
      const notice = buildNotice({
        view,
        previewCount: preview.length,
        totalCount,
        viewTotal,
        spilled: false,
        stagedRows: null,
        truncated: false,
        rowCap: config.maxSpillRows,
        canvasDisabled: true,
      });
      if (notice) ctx.enrich.notice(notice);
      return {
        activities: preview,
        totalCount,
        potency_view: view,
        spilled: false,
        canvas_id: null,
        table_name: null,
        staged_row_count: null,
        truncated: false,
        canvasDisabled: true,
      };
    }

    const instance = await canvas.acquire(input.canvas_id, ctx);
    // spillover's row type is Record<string, unknown>; an Activity is structurally
    // a string-keyed record, so widen the source for the generic constraint.
    const result = await spillover<Activity & Record<string, unknown>>({
      canvas: instance,
      source: activityStream as AsyncIterable<Activity & Record<string, unknown>>,
      previewChars,
      tableName: VIEW[view].table,
      // Bounds the spill drain, and with it the upstream page walk behind this
      // lazy stream (#14) — without it a catch-all target drains hundreds of
      // sequential ChEMBL pages in one call.
      caps: { maxRows: config.maxSpillRows },
      signal: ctx.signal,
    });

    /**
     * `limit` bounds the inline preview on every branch. spillover sizes its
     * preview buffer by the character budget, not by row count, so the returned
     * slice is capped here — never the budget itself, which is what drives the
     * fit-vs-spill decision and its overflow sentinel. Rows past the cap stay
     * reachable on the staged table when the view spilled, and are simply not
     * returned when it fit inline — the trade the canvas-disabled branch above
     * already makes.
     */
    const preview = result.previewRows.slice(0, limit);

    if (result.spilled) {
      const notice = buildNotice({
        view,
        previewCount: preview.length,
        totalCount,
        viewTotal,
        spilled: true,
        stagedRows: result.handle.rowCount,
        truncated: result.truncated,
        rowCap: config.maxSpillRows,
        canvasDisabled: false,
        canvasId: instance.canvasId,
      });
      if (notice) ctx.enrich.notice(notice);
      return {
        activities: preview,
        totalCount,
        potency_view: view,
        spilled: true,
        canvas_id: instance.canvasId,
        table_name: result.handle.tableName,
        staged_row_count: result.handle.rowCount,
        truncated: result.truncated,
        canvasDisabled: false,
      };
    }

    const notice = buildNotice({
      view,
      previewCount: preview.length,
      totalCount,
      viewTotal,
      spilled: false,
      stagedRows: null,
      truncated: false,
      rowCap: config.maxSpillRows,
      canvasDisabled: false,
    });
    if (notice) ctx.enrich.notice(notice);
    return {
      activities: preview,
      totalCount,
      potency_view: view,
      spilled: false,
      canvas_id: null,
      table_name: null,
      staged_row_count: null,
      truncated: false,
      canvasDisabled: false,
    };
  },

  format: (result) => {
    const spillNote = result.spilled
      ? `spilled: yes — staged on canvas \`${result.canvas_id}\` as table \`${result.table_name}\` (chembl_dataframe_describe for the columns, then chembl_dataframe_query to SQL them)`
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
        ? 'truncated: yes — the row cap was hit, so the staged table is a bounded slice of a larger upstream set, NOT the complete view'
        : 'truncated: no',
    ].join(' | ');
    const header = `**${result.totalCount}** measurements total — ${spillNote}.\n${stagingNote}`;
    if (result.activities.length === 0) {
      return [{ type: 'text', text: `${header}\n\nNo rows in preview.` }];
    }
    const rows = result.activities.map((a) => {
      const potency =
        a.standard_value != null
          ? `${a.standard_relation ?? ''}${a.standard_value} ${a.standard_units ?? ''}`.trim()
          : 'not reported';
      const pchembl = a.pchembl_value != null ? a.pchembl_value.toString() : '—';
      const raw =
        a.value != null ? `${a.relation ?? ''}${a.value} ${a.units ?? ''}`.trim() : 'not reported';
      return [
        `**${a.molecule_chembl_id}** (${a.molecule_pref_name ?? '—'}) → **${a.target_chembl_id}** (${a.target_pref_name ?? '—'}) [${a.target_organism ?? '—'}]`,
        `${a.standard_type ?? '—'}: ${potency} | pChEMBL: ${pchembl} | raw ${a.type ?? '—'}: ${raw}`,
        `assay ${a.assay_chembl_id} (${a.assay_type ?? '—'}): ${a.assay_description ?? '—'} | activity_id ${a.activity_id}`,
      ].join('\n');
    });
    return [{ type: 'text', text: `${header}\n\n${rows.join('\n\n')}` }];
  },
});
