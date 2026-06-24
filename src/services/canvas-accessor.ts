/**
 * @fileoverview Module-level holder for the optional DataCanvas wired in
 * `createApp({ setup })`. The framework attaches `core.canvas` only when
 * `CANVAS_PROVIDER_TYPE=duckdb`; `getCanvas()` returns `undefined` otherwise,
 * and the bioactivity spill + dataframe tools degrade accordingly.
 * @module services/canvas-accessor
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';

let _canvas: DataCanvas | undefined;

/** Store the framework's optional DataCanvas (or `undefined` when disabled). */
export const setCanvas = (c: DataCanvas | undefined): void => {
  _canvas = c;
};

/** Return the wired DataCanvas, or `undefined` when canvas is disabled. */
export const getCanvas = (): DataCanvas | undefined => _canvas;
