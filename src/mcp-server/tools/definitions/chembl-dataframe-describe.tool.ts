/**
 * @fileoverview chembl_dataframe_describe — list the tables and columns staged on
 * a canvas so the agent can write correct SQL before calling chembl_dataframe_query.
 * @module mcp-server/tools/definitions/chembl-dataframe-describe
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';

export const chemblDataframeDescribe = tool('chembl_dataframe_describe', {
  title: 'chembl-dataframe-describe',
  description:
    'List the tables and columns staged on a canvas by chembl_get_bioactivities — inspect before calling chembl_dataframe_query to write correct SQL. Returns each table with its row count, kind (table | view), and column names + types. Requires CANVAS_PROVIDER_TYPE=duckdb.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: z
      .string()
      .describe('Canvas ID returned by chembl_get_bioactivities (spilled: true).'),
  }),
  output: z.object({
    tables: z
      .array(
        z
          .object({
            name: z.string().describe('Canvas-local table name, e.g. "bioactivities".'),
            kind: z
              .enum(['table', 'view'])
              .describe('Whether the entry is a base table or a registered view.'),
            row_count: z
              .number()
              .describe('Number of rows in the table (materialized COUNT for views).'),
            columns: z
              .array(
                z
                  .object({
                    name: z.string().describe('Column name, e.g. "pchembl_value".'),
                    type: z
                      .string()
                      .describe('Column type tag, e.g. "DOUBLE", "VARCHAR", "BIGINT".'),
                  })
                  .describe('One column available for SQL.'),
              )
              .describe('Columns available for SQL on this table.'),
          })
          .describe('One staged table or view on the canvas.'),
      )
      .describe('Tables and views staged on the canvas.'),
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
    const instance = await canvas.acquire(input.canvas_id, ctx);
    const tables = await instance.describe();
    return {
      tables: tables.map((t) => ({
        name: t.name,
        kind: t.kind,
        row_count: t.rowCount,
        columns: t.columns.map((c) => ({ name: c.name, type: c.type })),
      })),
    };
  },

  format: (result) => {
    if (result.tables.length === 0) {
      return [{ type: 'text', text: 'No tables staged on this canvas.' }];
    }
    const blocks = result.tables.map((t) => {
      const cols = t.columns.map((c) => `${c.name} ${c.type}`).join(', ');
      return `**${t.name}** (${t.kind}, ${t.row_count} rows)\n${cols}`;
    });
    return [{ type: 'text', text: blocks.join('\n\n') }];
  },
});
