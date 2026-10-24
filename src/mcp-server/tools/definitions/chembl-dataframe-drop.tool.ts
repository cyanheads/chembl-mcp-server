/**
 * @fileoverview chembl_dataframe_drop — drop a named staged table from a canvas.
 * Opt-in behind CHEMBL_DATAFRAME_DROP_ENABLED (default off) and conditionally
 * registered, so it is absent from tools/list when the flag is off. Off by
 * default because a staged table lives exactly as long as its canvas — no table
 * is registered with a TTL of its own — and the canvas expires on its sliding TTL
 * (CANVAS_TTL_MS, 24 h) or its absolute cap (CANVAS_ABSOLUTE_CAP_MS, 7 d), taking
 * its tables with it; the tool only matters when an agent wants to free a large
 * table early in a long session.
 * @module mcp-server/tools/definitions/chembl-dataframe-drop
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';

export const chemblDataframeDrop = tool('chembl_dataframe_drop', {
  title: 'chembl-dataframe-drop',
  description:
    'Drop a named staged table from a canvas to free its memory early. Returns dropped: true if the table existed and was removed, false if the canvas is live but holds no table by that name (never staged on it, or already dropped). An unknown or expired canvas_id fails as canvas_not_found instead — an expired canvas has already freed its tables. Rarely needed — a staged table lasts exactly as long as its canvas, which by default expires 24 hours after its last use and at most 7 days after it was created, freeing every table on it; reach for this only to free a large table early in a long session. Unavailable when the server sets CANVAS_PROVIDER_TYPE=none.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    canvas_id: CanvasIdSchema.describe('Canvas ID returned by chembl_get_bioactivities.'),
    table_name: z.string().describe('Name of the staged table to drop, e.g. "bioactivities".'),
  }),
  output: z.object({
    dropped: z
      .boolean()
      .describe(
        'True if the table existed and was dropped; false if the live canvas holds no table by that name.',
      ),
  }),
  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The server runs with the canvas off (CANVAS_PROVIDER_TYPE=none), so no canvas exists.',
      recovery:
        'The canvas is off on this server, so no table was ever staged and there is nothing to drop.',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id is unknown or its canvas has expired, taking every table it held with it.',
      recovery:
        'Nothing is left to drop: an expired canvas has already freed its tables. If the canvas should still be live, check that canvas_id was copied exactly from the chembl_get_bioactivities response.',
    },
    {
      reason: 'identifier_reserved',
      code: JsonRpcErrorCode.ValidationError,
      when: 'table_name is a reserved SQL keyword, which the canvas never accepts as a table name.',
      recovery:
        'No staged table can carry a reserved SQL keyword as its name, so there is nothing by that name to drop. List the staged tables with chembl_dataframe_describe and pass one of those names.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail('canvas_disabled');
    }
    /**
     * The framework sets its own recovery hint on these two failures, and a
     * throw-site hint outranks a contract entry's. Both hints are staging advice
     * (re-stage the data; pick another table name) that a drop cannot follow, so
     * they are re-raised under this tool's contract with the original on
     * `cause`. Every other canvas error passes through unchanged.
     */
    try {
      const instance = await canvas.acquire(input.canvas_id, ctx);
      return { dropped: await instance.drop(input.table_name) };
    } catch (error) {
      const reason = error instanceof McpError ? error.data?.reason : undefined;
      if (reason === 'canvas_not_found') {
        throw ctx.fail(
          'canvas_not_found',
          'Canvas not found or expired.',
          { canvasId: input.canvas_id },
          { cause: error },
        );
      }
      if (reason === 'identifier_reserved') {
        throw ctx.fail(
          'identifier_reserved',
          `Table name "${input.table_name}" is a reserved SQL keyword, so no staged table carries it.`,
          undefined,
          { cause: error },
        );
      }
      throw error;
    }
  },

  format: (result) => [
    {
      type: 'text',
      text: result.dropped ? 'Table dropped.' : 'No table by that name on this canvas (no-op).',
    },
  ],
});
