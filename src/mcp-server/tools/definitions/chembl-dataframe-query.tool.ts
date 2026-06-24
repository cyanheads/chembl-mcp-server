/**
 * @fileoverview chembl_dataframe_query — run a read-only SQL SELECT over the
 * bioactivity rows chembl_get_bioactivities spilled to a canvas, for ranking,
 * grouping, deduping, and aggregating across the full set (not just the inline
 * preview). Mandatory companion to the spill: a canvas_id with no query tool is
 * dead output.
 * @module mcp-server/tools/definitions/chembl-dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';

export const chemblDataframeQuery = tool('chembl_dataframe_query', {
  title: 'chembl-dataframe-query',
  description:
    "Run a read-only SQL SELECT over the bioactivity rows chembl_get_bioactivities spilled to a canvas — rank, group, dedupe, and aggregate across the FULL set, not the inline preview. Reference the staged table by the name chembl_get_bioactivities returned (bioactivities); discover columns with chembl_dataframe_describe. Compute honest aggregates here (e.g. SELECT molecule_chembl_id, MEDIAN(pchembl_value) AS med FROM bioactivities WHERE standard_type = 'IC50' GROUP BY 1 ORDER BY 2 DESC). Returns up to the canvas row cap; truncated is true when the SQL result exceeds that cap. Requires CANVAS_PROVIDER_TYPE=duckdb.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: z
      .string()
      .describe('Canvas ID returned by chembl_get_bioactivities (spilled: true).'),
    sql: z
      .string()
      .describe(
        'A read-only SELECT against the staged tables. Reference tables by the names chembl_get_bioactivities returned.',
      ),
  }),
  output: z.object({
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Result rows (capped at the canvas row limit). Each row is a column→value map.'),
    row_count: z.number().describe('Number of rows materialized in this response.'),
    truncated: z
      .boolean()
      .describe('True when the SQL result exceeded the canvas row cap and was truncated.'),
  }),
  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Called while CANVAS_PROVIDER_TYPE is not duckdb, so no canvas exists.',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb to enable the SQL path; otherwise read the inline preview from chembl_get_bioactivities.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail('canvas_disabled', undefined, { ...ctx.recoveryFor('canvas_disabled') });
    }
    // Canvas-resolution failures (unknown id, missing table, invalid SQL) are
    // thrown by the DataCanvas primitive with structured data.reason — bubble them.
    const instance = await canvas.acquire(input.canvas_id, ctx);
    const result = await instance.query(input.sql, { signal: ctx.signal });
    return {
      rows: result.rows,
      row_count: result.rows.length,
      truncated: result.truncated ?? false,
    };
  },

  format: (result) => {
    if (result.rows.length === 0) {
      return [{ type: 'text', text: 'Query returned no rows.' }];
    }
    const columns = Object.keys(result.rows[0] ?? {});
    const head = `| ${columns.join(' | ')} |`;
    const sep = `| ${columns.map(() => '---').join(' | ')} |`;
    const body = result.rows
      .slice(0, 50)
      .map((row) => `| ${columns.map((c) => String(row[c] ?? '')).join(' | ')} |`)
      .join('\n');
    const more = result.rows.length > 50 ? `\n…(${result.rows.length - 50} more rows)` : '';
    const trunc = result.truncated ? '\n\n_Result truncated at the canvas row cap._' : '';
    return [
      {
        type: 'text',
        text: `${result.row_count} rows.\n\n${head}\n${sep}\n${body}${more}${trunc}`,
      },
    ];
  },
});
