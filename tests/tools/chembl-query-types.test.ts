/**
 * @fileoverview Real DuckDB regressions for projected SQL types and safe integer
 * normalization through both chembl_dataframe_query response surfaces.
 * @module tests/tools/chembl-query-types
 */

import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chemblDataframeQuery } from '@/mcp-server/tools/definitions/chembl-dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';

let canvas: DataCanvas;
let canvasId: string;
const context = { tenantId: 'query-types' };

beforeEach(async () => {
  const provider = new DuckdbProvider({
    defaultRowLimit: 1,
    exportRootPath: '.canvas-exports',
    memoryLimitMb: 64,
    schemaSniffRows: 100,
  });
  canvas = new DataCanvas(provider, new CanvasRegistry(provider));
  setCanvas(canvas);
  const instance = await canvas.acquire(undefined, createMockContext(context));
  canvasId = instance.canvasId;
  await instance.registerTable('bioactivities', [{ value: '001', activity_id: 7 }], {
    schema: [
      { name: 'value', type: 'VARCHAR' },
      { name: 'activity_id', type: 'BIGINT' },
    ],
  });
});

afterEach(async () => {
  await canvas.shutdown(createMockContext(context));
  setCanvas(undefined);
});

describe('projected SQL types (#23)', () => {
  it.each([
    ['SELECT value AS raw_value FROM bioactivities', { raw_value: '001' }],
    [
      "SELECT value || '' AS expression, CAST(activity_id AS VARCHAR) AS text_id FROM bioactivities",
      { expression: '001', text_id: '7' },
    ],
    [
      'SELECT COUNT(*) AS value, SUM(activity_id) AS total, CAST(9007199254740993 AS BIGINT) AS big FROM bioactivities',
      { value: 1, total: 7, big: '9007199254740993' },
    ],
    [
      'SELECT value AS x, activity_id AS x, value AS x_1 FROM bioactivities',
      { x: '001', 'x:1': 7, x_1: '001' },
    ],
    [
      'SELECT activity_id AS x, activity_id AS x, value AS "x:1" FROM bioactivities',
      { x: 7, 'x:1': '001' },
    ],
    ['SELECT value AS "2", activity_id AS "1" FROM bioactivities', { '2': '001', '1': 7 }],
    [
      'WITH c AS (SELECT * FROM bioactivities) SELECT value AS raw_value, activity_id FROM c; -- suffix',
      { raw_value: '001', activity_id: 7 },
    ],
    ["SELECT '001'::ENUM('001', 'INT') AS label, [7::BIGINT] AS ids", { label: '001', ids: ['7'] }],
  ])('preserves the types in %s', async (sql, expected) => {
    const result = await runToolContract(
      chemblDataframeQuery,
      { canvas_id: canvasId, sql },
      { context },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      rows: [expected],
      row_count: 1,
      truncated: false,
    });
    const text = result.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    if (Object.values(expected).includes('001')) expect(text).toContain('001');
    if ('big' in expected) expect(text).toContain('9007199254740993');
  });

  it('preserves empty results and SQL-gate refusals', async () => {
    const empty = await runToolContract(
      chemblDataframeQuery,
      { canvas_id: canvasId, sql: 'SELECT value FROM bioactivities WHERE false' },
      { context },
    );
    expect(empty.structuredContent).toMatchObject({ rows: [], row_count: 0, truncated: false });
    const refused = await runToolContract(
      chemblDataframeQuery,
      { canvas_id: canvasId, sql: 'DROP TABLE bioactivities' },
      { context },
    );
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      error: { data: { reason: 'non_select_statement' } },
    });
  });

  it('preserves the query row cap and LIMIT/OFFSET paging', async () => {
    const sql =
      "SELECT value AS raw_value, activity_id FROM bioactivities UNION ALL SELECT '002', 8";
    const first = await runToolContract(
      chemblDataframeQuery,
      { canvas_id: canvasId, sql },
      { context },
    );
    expect(first.structuredContent).toMatchObject({
      rows: [{ raw_value: '001', activity_id: 7 }],
      row_count: 1,
      truncated: true,
    });
    const second = await runToolContract(
      chemblDataframeQuery,
      { canvas_id: canvasId, sql: `${sql} LIMIT 1 OFFSET 1` },
      { context },
    );
    expect(second.structuredContent).toMatchObject({
      rows: [{ raw_value: '002', activity_id: 8 }],
      row_count: 1,
      truncated: false,
    });
  });

  it('preserves cancellation', async () => {
    const result = await runToolContract(
      chemblDataframeQuery,
      { canvas_id: canvasId, sql: 'SELECT value AS raw_value FROM bioactivities' },
      { context: { ...context, signal: AbortSignal.abort() } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: -32011 } });
  });
});
