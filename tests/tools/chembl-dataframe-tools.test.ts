/**
 * @fileoverview Behavior tests for the three DataCanvas consumer tools
 * (chembl_dataframe_query / _describe / _drop). Covers the shared
 * canvas_disabled error contract (ctx.fail when CANVAS_PROVIDER_TYPE is not
 * duckdb), the happy paths through a structural FakeDataCanvas, the
 * row_count/truncated mapping on query, bubbling of canvas-primitive errors
 * (unknown canvas_id, SQL-gate rejection), the dropped:true/false paths, and
 * each tool's pure format().
 * @module tests/tools/chembl-dataframe-tools
 */

import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { chemblDataframeDescribe } from '@/mcp-server/tools/definitions/chembl-dataframe-describe.tool.js';
import { chemblDataframeDrop } from '@/mcp-server/tools/definitions/chembl-dataframe-drop.tool.js';
import { chemblDataframeQuery } from '@/mcp-server/tools/definitions/chembl-dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { FakeDataCanvas } from '../_fake-canvas.js';

afterEach(() => {
  setCanvas(undefined);
});

/** Acquire a fresh canvas, register a `bioactivities` table on it, return the id. */
async function seedCanvas(fake: FakeDataCanvas, rows: Record<string, unknown>[]): Promise<string> {
  const instance = await fake.acquire(undefined, { tenantId: 'default' });
  await instance.registerTable('bioactivities', rows);
  return instance.canvasId;
}

describe('canvas_disabled error contract (all three tools)', () => {
  it('chembl_dataframe_query throws ctx.fail("canvas_disabled") with InvalidParams', async () => {
    setCanvas(undefined);
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeQuery.errors });
    const input = chemblDataframeQuery.input.parse({ canvas_id: 'x', sql: 'SELECT 1' });
    await expect(chemblDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'canvas_disabled' },
    });
  });

  it('chembl_dataframe_describe throws ctx.fail("canvas_disabled")', async () => {
    setCanvas(undefined);
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeDescribe.errors });
    const input = chemblDataframeDescribe.input.parse({ canvas_id: 'x' });
    await expect(chemblDataframeDescribe.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'canvas_disabled' },
    });
  });

  it('chembl_dataframe_drop throws ctx.fail("canvas_disabled")', async () => {
    setCanvas(undefined);
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeDrop.errors });
    const input = chemblDataframeDrop.input.parse({ canvas_id: 'x', table_name: 'bioactivities' });
    await expect(chemblDataframeDrop.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'canvas_disabled' },
    });
  });
});

describe('chembl_dataframe_query — happy + boundary', () => {
  it('returns scripted rows with row_count and truncated:false', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const canvasId = await seedCanvas(fake, [{ molecule_chembl_id: 'CHEMBL1', med: 7.4 }]);
    fake.nextQuery = { rows: [{ molecule_chembl_id: 'CHEMBL1', med: 7.4 }], truncated: false };
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeQuery.errors });
    const input = chemblDataframeQuery.input.parse({
      canvas_id: canvasId,
      sql: 'SELECT molecule_chembl_id, MEDIAN(pchembl_value) AS med FROM bioactivities GROUP BY 1',
    });
    const result = await chemblDataframeQuery.handler(input, ctx);
    expect(result.row_count).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.rows[0]).toMatchObject({ molecule_chembl_id: 'CHEMBL1', med: 7.4 });
  });

  it('surfaces truncated:true when the canvas row cap was hit', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const canvasId = await seedCanvas(fake, [{ a: 1 }]);
    fake.nextQuery = { rows: [{ a: 1 }, { a: 2 }], truncated: true };
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeQuery.errors });
    const input = chemblDataframeQuery.input.parse({
      canvas_id: canvasId,
      sql: 'SELECT a FROM bioactivities',
    });
    const result = await chemblDataframeQuery.handler(input, ctx);
    expect(result.truncated).toBe(true);
    expect(result.row_count).toBe(2);
  });

  it('bubbles an unknown-canvas error from the canvas primitive (not re-wrapped)', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeQuery.errors });
    const input = chemblDataframeQuery.input.parse({
      canvas_id: 'fake_doesnotexist',
      sql: 'SELECT 1',
    });
    // The fake throws NotFound for an unknown id, mirroring the real acquire.
    await expect(chemblDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('bubbles a SQL-gate rejection from the canvas primitive', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const canvasId = await seedCanvas(fake, [{ a: 1 }]);
    fake.nextQueryError = validationError('Canvas query must be read-only.', {
      reason: 'non_select_statement',
    });
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeQuery.errors });
    const input = chemblDataframeQuery.input.parse({
      canvas_id: canvasId,
      sql: 'DROP TABLE bioactivities',
    });
    await expect(chemblDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'non_select_statement' },
    });
  });
});

describe('chembl_dataframe_describe — happy path', () => {
  it('lists the staged bioactivities table with its columns', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const canvasId = await seedCanvas(fake, [
      { molecule_chembl_id: 'CHEMBL1', pchembl_value: 7.4, standard_type: 'IC50' },
    ]);
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeDescribe.errors });
    const result = await chemblDataframeDescribe.handler(
      chemblDataframeDescribe.input.parse({ canvas_id: canvasId }),
      ctx,
    );
    const bio = result.tables.find((t) => t.name === 'bioactivities');
    expect(bio).toBeDefined();
    expect(bio?.kind).toBe('table');
    expect(bio?.row_count).toBe(1);
    expect(bio?.columns.map((col) => col.name)).toContain('pchembl_value');
  });
});

describe('chembl_dataframe_drop — dropped true/false', () => {
  it('returns dropped:true when the table existed', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const canvasId = await seedCanvas(fake, [{ a: 1 }]);
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeDrop.errors });
    const result = await chemblDataframeDrop.handler(
      chemblDataframeDrop.input.parse({ canvas_id: canvasId, table_name: 'bioactivities' }),
      ctx,
    );
    expect(result.dropped).toBe(true);
  });

  it('returns dropped:false (idempotent) for a table that was already gone', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const canvasId = await seedCanvas(fake, [{ a: 1 }]);
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeDrop.errors });
    const result = await chemblDataframeDrop.handler(
      chemblDataframeDrop.input.parse({ canvas_id: canvasId, table_name: 'never_existed' }),
      ctx,
    );
    expect(result.dropped).toBe(false);
  });
});

describe('dataframe tools — format()', () => {
  it('query renders a markdown table with the row count', () => {
    const blocks = chemblDataframeQuery.format!({
      rows: [{ molecule_chembl_id: 'CHEMBL1', med: 7.4 }],
      row_count: 1,
      truncated: false,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('1 rows');
    expect(text).toContain('| molecule_chembl_id | med |');
    expect(text).toContain('CHEMBL1');
  });

  it('query renders the truncation note when truncated', () => {
    const blocks = chemblDataframeQuery.format!({
      rows: [{ a: 1 }],
      row_count: 1,
      truncated: true,
    });
    expect((blocks[0] as { text: string }).text).toContain('truncated at the canvas row cap');
  });

  it('query renders the empty marker for no rows', () => {
    const blocks = chemblDataframeQuery.format!({ rows: [], row_count: 0, truncated: false });
    expect((blocks[0] as { text: string }).text).toContain('no rows');
  });

  it('describe renders each table with its columns', () => {
    const blocks = chemblDataframeDescribe.format!({
      tables: [
        {
          name: 'bioactivities',
          kind: 'table',
          row_count: 120,
          columns: [
            { name: 'pchembl_value', type: 'DOUBLE' },
            { name: 'standard_type', type: 'VARCHAR' },
          ],
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**bioactivities**');
    expect(text).toContain('120 rows');
    expect(text).toContain('pchembl_value DOUBLE');
  });

  it('describe renders the empty marker for no tables', () => {
    const blocks = chemblDataframeDescribe.format!({ tables: [] });
    expect((blocks[0] as { text: string }).text).toContain('No tables staged');
  });

  it('drop renders distinct markers for dropped vs no-op', () => {
    expect((chemblDataframeDrop.format!({ dropped: true })[0] as { text: string }).text).toContain(
      'Table dropped',
    );
    expect((chemblDataframeDrop.format!({ dropped: false })[0] as { text: string }).text).toContain(
      'already gone',
    );
  });
});
