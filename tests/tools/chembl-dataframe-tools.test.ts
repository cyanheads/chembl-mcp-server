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

  it('coerces BIGINT-string aggregates to numbers but preserves VARCHAR columns (#2)', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    // Seed so describe() reports column types: value is VARCHAR (raw passthrough),
    // activity_id is BIGINT. DuckDB-Node serializes BIGINT/COUNT/SUM as JSON strings.
    const canvasId = await seedCanvas(fake, [
      { molecule_chembl_id: 'CHEMBL1', value: '500000', activity_id: 32770, pchembl_value: 7.4 },
    ]);
    fake.nextQuery = {
      rows: [
        {
          molecule_chembl_id: 'CHEMBL176582',
          n: '5',
          total_id: '65540',
          value: '500000',
          avg_p: 7.4,
        },
      ],
      truncated: false,
    };
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeQuery.errors });
    const input = chemblDataframeQuery.input.parse({
      canvas_id: canvasId,
      sql: 'SELECT molecule_chembl_id, COUNT(*) AS n, SUM(activity_id) AS total_id, value FROM bioactivities GROUP BY 1, value',
    });
    const result = await chemblDataframeQuery.handler(input, ctx);
    const row = result.rows[0] as Record<string, unknown>;
    // Aggregate projections (no base-table entry) coerce string → number.
    expect(row.n).toBe(5);
    expect(row.total_id).toBe(65540);
    // DOUBLE already arrives as a number — untouched.
    expect(row.avg_p).toBe(7.4);
    // VARCHAR base column with an integer-looking string is preserved as a string.
    expect(row.value).toBe('500000');
    // A real ChEMBL ID is not an integer string — untouched.
    expect(row.molecule_chembl_id).toBe('CHEMBL176582');
  });

  it('keeps an out-of-safe-range integer string as a string to preserve precision (#2)', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const canvasId = await seedCanvas(fake, [{ a: 1 }]);
    fake.nextQuery = {
      rows: [{ big: '99999999999999999999', n: '7' }],
      truncated: false,
    };
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeQuery.errors });
    const input = chemblDataframeQuery.input.parse({
      canvas_id: canvasId,
      sql: 'SELECT 99999999999999999999 AS big, 7 AS n',
    });
    const result = await chemblDataframeQuery.handler(input, ctx);
    const row = result.rows[0] as Record<string, unknown>;
    // Beyond Number.MAX_SAFE_INTEGER → preserved as a string (no silent precision loss).
    expect(row.big).toBe('99999999999999999999');
    // A safe integer alongside it still coerces.
    expect(row.n).toBe(7);
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

/** Narrow two-column rows — 200 of these still sit far under the render budget. */
function narrowRows(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    activity_id: 1000 + i,
    molecule_chembl_id: `CHEMBL${i}`,
  }));
}

/** ~1 KB of assay text per row — a few dozen of these exhaust the render budget. */
function wideRows(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    activity_id: 2000 + i,
    assay_description: `Inhibition of EGFR ${'x'.repeat(1000)}`,
  }));
}

/** Data lines of the markdown table format() rendered — header and separator excluded. */
function tableDataLines(text: string): string[] {
  const lines = text.split('\n');
  const sep = lines.findIndex((line) => line.startsWith('| ---'));
  return lines.slice(sep + 1).filter((line) => line.startsWith('|'));
}

/** Render one query result and return the single text block's text. */
function renderQuery(
  result: Parameters<NonNullable<typeof chemblDataframeQuery.format>>[0],
): string {
  return (chemblDataframeQuery.format!(result)[0] as { text: string }).text;
}

describe('chembl_dataframe_query — content[] render budget (#10)', () => {
  it('renders every row of an under-budget result, past the old 50-row cut', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const canvasId = await seedCanvas(fake, [{ activity_id: 1000, molecule_chembl_id: 'CHEMBL0' }]);
    fake.nextQuery = { rows: narrowRows(60), truncated: false };
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeQuery.errors });
    const input = chemblDataframeQuery.input.parse({
      canvas_id: canvasId,
      sql: 'SELECT activity_id, molecule_chembl_id FROM bioactivities ORDER BY activity_id LIMIT 60',
    });
    const result = await chemblDataframeQuery.handler(input, ctx);
    expect(result.row_count).toBe(60);
    expect(result.rendered_rows).toBe(60);
    expect(result.truncated).toBe(false);

    const text = renderQuery(result);
    expect(tableDataLines(text)).toHaveLength(60);
    // The rows the fixed 50-row slice used to drop.
    expect(text).toContain('CHEMBL50');
    expect(text).toContain('CHEMBL59');
    expect(text).not.toContain('more rows');
  });

  it('bounds a large result by the character budget and names the LIMIT/OFFSET path', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const canvasId = await seedCanvas(fake, [{ activity_id: 2000, assay_description: 'seed' }]);
    fake.nextQuery = { rows: wideRows(200), truncated: false };
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeQuery.errors });
    const input = chemblDataframeQuery.input.parse({
      canvas_id: canvasId,
      sql: 'SELECT activity_id, assay_description FROM bioactivities',
    });
    const result = await chemblDataframeQuery.handler(input, ctx);
    expect(result.row_count).toBe(200);
    expect(result.rendered_rows).toBeGreaterThan(0);
    expect(result.rendered_rows).toBeLessThan(200);
    // The renderer's budget, not the engine's row cap — the two are independent.
    expect(result.truncated).toBe(false);

    const text = renderQuery(result);
    const dataLines = tableDataLines(text);
    expect(dataLines).toHaveLength(result.rendered_rows);
    expect(dataLines.join('\n').length).toBeLessThanOrEqual(40_000);
    expect(text).toContain(`rendered_rows: ${result.rendered_rows} of 200`);
    expect(text).toContain('LIMIT');
    expect(text).toContain('OFFSET');
    // The canvas-cap disclosure must not fire for a render-budget cap.
    expect(text).not.toContain('canvas row cap');
  });

  it('discloses the canvas row cap without a render note when the table fits', () => {
    const text = renderQuery({
      rows: narrowRows(60),
      row_count: 60,
      rendered_rows: 60,
      truncated: true,
    });
    expect(tableDataLines(text)).toHaveLength(60);
    expect(text).toContain('truncated at the canvas row cap');
    expect(text).not.toContain('render budget');
  });

  it('discloses both caps independently when the engine and the renderer each capped', () => {
    const text = renderQuery({
      rows: narrowRows(200),
      row_count: 200,
      rendered_rows: 12,
      truncated: true,
    });
    expect(tableDataLines(text)).toHaveLength(12);
    expect(text).toContain('rendered_rows: 12 of 200');
    expect(text).toContain('render budget');
    expect(text).toContain('truncated at the canvas row cap');
  });

  it('returns an empty result when OFFSET runs past the end of the table', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const canvasId = await seedCanvas(fake, [{ activity_id: 1000 }]);
    fake.nextQuery = { rows: [], truncated: false };
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeQuery.errors });
    const input = chemblDataframeQuery.input.parse({
      canvas_id: canvasId,
      sql: 'SELECT activity_id FROM bioactivities ORDER BY activity_id LIMIT 10 OFFSET 999999',
    });
    const result = await chemblDataframeQuery.handler(input, ctx);
    expect(result.row_count).toBe(0);
    expect(result.rendered_rows).toBe(0);
    expect(result.truncated).toBe(false);
    expect(renderQuery(result)).toContain('Query returned no rows.');
  });

  it('carries a nested cell into content[] as JSON and leaves it uncoerced (#2 boundary)', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const canvasId = await seedCanvas(fake, [{ molecule_chembl_id: 'CHEMBL1', n: 5 }]);
    fake.nextQuery = {
      rows: [
        {
          molecule_chembl_id: 'CHEMBL1',
          nested: { assay: { count: '5' } },
          ids: ['CHEMBL2', 'CHEMBL3'],
          n: '5',
        },
      ],
      truncated: false,
    };
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeQuery.errors });
    const input = chemblDataframeQuery.input.parse({
      canvas_id: canvasId,
      sql: "SELECT molecule_chembl_id, {'assay': {'count': '5'}} AS nested, ['CHEMBL2','CHEMBL3'] AS ids, COUNT(*) AS n FROM bioactivities GROUP BY 1",
    });
    const result = await chemblDataframeQuery.handler(input, ctx);
    const row = result.rows[0] as Record<string, unknown>;
    // Coercion is top-level only — the integer string two levels down is untouched.
    expect(row.nested).toEqual({ assay: { count: '5' } });
    // …while the top-level aggregate still coerces (#2).
    expect(row.n).toBe(5);

    const text = renderQuery(result);
    expect(text).toContain('{"assay":{"count":"5"}}');
    expect(text).toContain('CHEMBL3');
    expect(text).not.toContain('[object Object]');
  });

  it('keeps a pipe or newline inside a cell from breaking the table', () => {
    const text = renderQuery({
      rows: [{ assay_description: 'Inhibition of EGFR | mutant\nsecond line' }],
      row_count: 1,
      rendered_rows: 1,
      truncated: false,
    });
    expect(tableDataLines(text)).toHaveLength(1);
    expect(text).toContain('Inhibition of EGFR \\| mutant second line');
  });

  it('carries the declared recovery hint on canvas_disabled', async () => {
    setCanvas(undefined);
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeQuery.errors });
    const input = chemblDataframeQuery.input.parse({ canvas_id: 'x', sql: 'SELECT 1' });
    await expect(chemblDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      data: { recovery: { hint: expect.stringContaining('CANVAS_PROVIDER_TYPE=duckdb') } },
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
      rendered_rows: 1,
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
      rendered_rows: 1,
      truncated: true,
    });
    expect((blocks[0] as { text: string }).text).toContain('truncated at the canvas row cap');
  });

  it('query renders the empty marker for no rows', () => {
    const blocks = chemblDataframeQuery.format!({
      rows: [],
      row_count: 0,
      rendered_rows: 0,
      truncated: false,
    });
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
