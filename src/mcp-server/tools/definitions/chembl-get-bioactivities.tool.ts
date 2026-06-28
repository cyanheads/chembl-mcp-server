/**
 * @fileoverview chembl_get_bioactivities — the flagship compound↔target↔assay
 * bridge. Returns bioactivity measurements for a molecule OR a target (exactly
 * one), filterable by standard_type, potency (pchembl_value), assay type, and
 * organism, ranked on pchembl_value. Large sets spill to a DataCanvas table
 * (bioactivities) the agent SQLs via chembl_dataframe_query for honest aggregates.
 * @module mcp-server/tools/definitions/chembl-get-bioactivities
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getChemblService } from '@/services/chembl/chembl-service.js';
import type { Activity, GetActivitiesOptions } from '@/services/chembl/types.js';

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
 * Compose the agent-facing notice for a bioactivities result. Discloses the
 * potency-ranked preview when measurements without a pchembl_value were excluded
 * (so the honest totalCount and the ranked view do not appear to contradict each
 * other), plus the spill / canvas-disabled / empty-result context. Returns
 * undefined when there is nothing worth saying (canvas enabled, fit inline,
 * nothing filtered out).
 */
function buildNotice(args: {
  previewCount: number;
  totalCount: number;
  potentTotal: number;
  limit: number;
  spilled: boolean;
  canvasDisabled: boolean;
  canvasId?: string;
}): string | undefined {
  const { previewCount, totalCount, potentTotal, limit, spilled, canvasDisabled, canvasId } = args;

  if (previewCount === 0) {
    return totalCount === 0
      ? 'No measurements matched. Broaden the filters (drop standard_type or lower pchembl_value_min), or check the ID.'
      : `All ${totalCount} matching measurements lack a derivable pchembl_value, so none appear in this potency-ranked view — the measurements exist but report no comparable potency. Inspect the raw value/type fields, or drop the potency expectation.`;
  }

  // Disclose the potency filter only when it actually narrowed the set — null-potency
  // rows were present and not already excluded by a pchembl_value_min floor.
  const potency =
    potentTotal < totalCount
      ? ` Ranked by potency: this view holds the ${potentTotal} measurements with a pchembl_value; ${totalCount} match in total (the rest report none).`
      : '';

  if (spilled) {
    return `${potentTotal} measurements staged as table "bioactivities" on canvas ${canvasId}. SQL the staged set with chembl_dataframe_query — e.g. SELECT molecule_chembl_id, MEDIAN(pchembl_value) AS med FROM bioactivities GROUP BY 1 ORDER BY 2 DESC.${potency}`;
  }

  if (canvasDisabled) {
    return `Canvas disabled (CANVAS_PROVIDER_TYPE != duckdb): showing up to ${limit} of ${potentTotal} rows with no spill. Set CANVAS_PROVIDER_TYPE=duckdb to SQL the staged set.${potency}`;
  }

  // Canvas enabled, everything fit inline — only worth a note if potency narrowed.
  return potency ? potency.trimStart() : undefined;
}

export const chemblGetBioactivities = tool('chembl_get_bioactivities', {
  title: 'chembl-get-bioactivities',
  description:
    'The flagship compound↔target bioactivity bridge: measurements for a molecule (target deconvolution / selectivity) OR a target (lead finding). Supply exactly one of molecule_chembl_id (from chembl_search_molecules) or target_chembl_id (from chembl_search_targets) — both or neither is an error. Filter by standard_type (IC50/Ki/EC50/…), minimum potency pchembl_value_min, assay_type, and organism. Rows are ranked by potency: the preview surfaces measurements with a derivable pchembl_value (ChEMBL sorts the null-potency rows first otherwise), while totalCount stays the honest full match count including measurements without one. Mixing measurement types (IC50 vs Ki) is a scientific error — set standard_type to compare like with like. A popular target carries tens of thousands of rows: results spill to a DataCanvas table (bioactivities) you SQL with chembl_dataframe_query for honest aggregates across the staged set, while an inline preview answers the immediate question. Spilling requires CANVAS_PROVIDER_TYPE=duckdb; otherwise the inline rows are capped at limit (a preview, not the full set).',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    molecule_chembl_id: z
      .string()
      .optional()
      .describe(
        'ChEMBL molecule ID (from chembl_search_molecules), e.g. "CHEMBL941". Supply this XOR target_chembl_id.',
      ),
    target_chembl_id: z
      .string()
      .optional()
      .describe(
        'ChEMBL target ID (from chembl_search_targets), e.g. "CHEMBL203". Supply this XOR molecule_chembl_id.',
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
        'Minimum pchembl_value (−log10 molar potency), e.g. 7 keeps sub-100 nM activities.',
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
        'Optional canvas ID from a prior call to reuse the same canvas. The bioactivities table is re-staged, so a second query REPLACES (overwrites) the prior rows on that canvas — it does not append. Omit to mint a fresh canvas.',
      ),
  }),
  output: z.object({
    activities: z
      .array(ActivitySchema)
      .describe(
        'Bioactivity rows — the potency-ranked inline preview, or the full ranked set when it fit without spilling.',
      ),
    totalCount: z
      .number()
      .describe(
        'Total matching measurements upstream — the honest full count including measurements without a derivable pchembl_value, before any preview cap. The staged/preview rows are the potency-ranked subset of this.',
      ),
    spilled: z
      .boolean()
      .describe('True when the full set exceeded the preview and was staged on the canvas.'),
    canvas_id: z
      .string()
      .nullable()
      .describe(
        'Canvas ID holding the bioactivities table — pass to chembl_dataframe_query/describe. Null when canvas is disabled or nothing spilled.',
      ),
    table_name: z
      .string()
      .nullable()
      .describe(
        'Canvas table name holding the staged rowset (always "bioactivities" when spilled). Null when not spilled.',
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
        scope: z.string().describe('Whether the query was by molecule or target, with the ID.'),
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
      when: 'Neither molecule_chembl_id nor target_chembl_id was supplied, or both were supplied.',
      recovery:
        'Supply exactly one of molecule_chembl_id (from chembl_search_molecules) or target_chembl_id (from chembl_search_targets), not both and not neither.',
    },
  ],

  async handler(input, ctx) {
    const moleculeId = input.molecule_chembl_id?.trim() || undefined;
    const targetId = input.target_chembl_id?.trim() || undefined;

    // XOR gate — Zod cannot cleanly XOR two optionals, so enforce here.
    if ((!moleculeId && !targetId) || (moleculeId && targetId)) {
      throw ctx.fail('missing_filter', undefined, { ...ctx.recoveryFor('missing_filter') });
    }

    const limit = input.limit ?? getServerConfig().defaultLimit;
    const service = getChemblService();
    const standardType = input.standard_type?.trim() || undefined;
    const assayType = input.assay_type?.trim() || undefined;
    const organism = input.organism?.trim() || undefined;

    ctx.enrich({
      appliedFilters: {
        scope: moleculeId ? `molecule ${moleculeId}` : `target ${targetId}`,
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
      limit,
    };

    // Two-phase (#3): totalCount is the honest full match count from a separate
    // count call (no pchembl_value presence filter); the preview/spill stream
    // excludes null-pchembl rows so the potency-ranked preview leads with potent
    // measurements. potentTotal is the count of that filtered subset — equal to
    // totalCount when nothing was excluded (e.g. a pchembl_value_min floor was set).
    const totalCount = await service.countActivities(filters, ctx);
    let potentTotal = 0;
    const activityStream = service.streamActivities(filters, ctx, (total) => {
      potentTotal = total;
    });

    const canvas = getCanvas();

    // Character budget for the inline preview, scaled to the requested limit:
    // ~600 chars/row for a bioactivity row, so the preview holds ~`limit` rows.
    const previewChars = Math.max(40_000, limit * 600);

    if (!canvas) {
      // Canvas disabled — inline up to `limit` rows, no spill. Drain manually so
      // the preview is capped at the limit rather than the spill budget.
      const preview: Activity[] = [];
      for await (const row of activityStream) {
        preview.push(row);
        if (preview.length >= limit) break;
      }
      const notice = buildNotice({
        previewCount: preview.length,
        totalCount,
        potentTotal,
        limit,
        spilled: false,
        canvasDisabled: true,
      });
      if (notice) ctx.enrich.notice(notice);
      return {
        activities: preview,
        totalCount,
        spilled: false,
        canvas_id: null,
        table_name: null,
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
      tableName: 'bioactivities',
      signal: ctx.signal,
    });

    if (result.spilled) {
      const notice = buildNotice({
        previewCount: result.previewRows.length,
        totalCount,
        potentTotal,
        limit,
        spilled: true,
        canvasDisabled: false,
        canvasId: instance.canvasId,
      });
      if (notice) ctx.enrich.notice(notice);
      return {
        // The staged set is on the canvas; cap the inline preview to the requested
        // limit (spillover sizes the preview by character budget, not row count).
        activities: result.previewRows.slice(0, limit),
        totalCount,
        spilled: true,
        canvas_id: instance.canvasId,
        table_name: result.handle.tableName,
        canvasDisabled: false,
      };
    }

    const notice = buildNotice({
      previewCount: result.previewRows.length,
      totalCount,
      potentTotal,
      limit,
      spilled: false,
      canvasDisabled: false,
    });
    if (notice) ctx.enrich.notice(notice);
    return {
      activities: result.previewRows,
      totalCount,
      spilled: false,
      canvas_id: null,
      table_name: null,
      canvasDisabled: false,
    };
  },

  format: (result) => {
    const spillNote = result.spilled
      ? `spilled: yes — staged on canvas \`${result.canvas_id}\` as table \`${result.table_name}\` (query with chembl_dataframe_query)`
      : result.canvasDisabled
        ? 'spilled: no — canvas disabled; these rows are a capped preview, not the complete set'
        : result.activities.length === result.totalCount
          ? 'spilled: no (preview is the full set)'
          : `spilled: no — showing ${result.activities.length} of ${result.totalCount} matching measurements (potency-ranked preview)`;
    const header = `**${result.totalCount}** measurements total — ${spillNote}.`;
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
