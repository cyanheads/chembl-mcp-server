/**
 * @fileoverview chembl_dataframe_drop — drop a named staged table from a canvas.
 * Opt-in behind CHEMBL_DATAFRAME_DROP_ENABLED (default off) and conditionally
 * registered, so it is absent from tools/list when the flag is off. Off by
 * default because per-table/canvas TTL already reclaims staged tables; the tool
 * only matters when an agent wants to free a large table early in a long session.
 * @module mcp-server/tools/definitions/chembl-dataframe-drop
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';

export const chemblDataframeDrop = tool('chembl_dataframe_drop', {
  title: 'chembl-dataframe-drop',
  description:
    'Drop a named staged table from a canvas to free its memory early. Returns dropped: true if the table existed and was removed, false if it was already gone (TTL or a prior drop). Rarely needed — per-table and per-canvas TTL reclaim staged tables automatically; reach for this only to free a large table early in a long session. Requires CANVAS_PROVIDER_TYPE=duckdb.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    canvas_id: z.string().describe('Canvas ID returned by chembl_get_bioactivities.'),
    table_name: z.string().describe('Name of the staged table to drop, e.g. "bioactivities".'),
  }),
  output: z.object({
    dropped: z
      .boolean()
      .describe('True if the table existed and was dropped; false if it was already gone.'),
  }),
  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Called while CANVAS_PROVIDER_TYPE is not duckdb, so no canvas exists.',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb to enable the canvas; otherwise there is nothing to drop.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail('canvas_disabled', undefined, { ...ctx.recoveryFor('canvas_disabled') });
    }
    const instance = await canvas.acquire(input.canvas_id, ctx);
    const dropped = await instance.drop(input.table_name);
    return { dropped };
  },

  format: (result) => [
    { type: 'text', text: result.dropped ? 'Table dropped.' : 'Table was already gone (no-op).' },
  ],
});
