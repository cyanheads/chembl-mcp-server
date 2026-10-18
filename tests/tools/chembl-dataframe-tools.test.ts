/**
 * @fileoverview Behavior tests for the three DataCanvas consumer tools
 * (chembl_dataframe_query / _describe / _drop). Covers the shared
 * canvas_disabled error contract (ctx.fail when CANVAS_PROVIDER_TYPE is not
 * duckdb), the happy paths through FakeDataCanvas (the framework DataCanvas
 * over an in-memory provider), the row_count/truncated mapping on query against
 * the provider's row cap, bubbling of canvas-primitive errors
 * (unknown canvas_id, SQL-gate rejection), drop's re-raise of canvas_not_found
 * and identifier_reserved under its own recovery while describe/query keep the
 * framework's, the dropped:true/false paths, and each tool's pure format().
 * @module tests/tools/chembl-dataframe-tools
 */

import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chemblDataframeDescribe } from '@/mcp-server/tools/definitions/chembl-dataframe-describe.tool.js';
import { chemblDataframeDrop } from '@/mcp-server/tools/definitions/chembl-dataframe-drop.tool.js';
import { chemblDataframeQuery } from '@/mcp-server/tools/definitions/chembl-dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { FakeDataCanvas } from '../_fake-canvas.js';

afterEach(() => {
  setCanvas(undefined);
});

/**
 * A `canvas_id` of the minted shape (`CanvasIdSchema`, `^[A-Za-z0-9_-]{10}$`)
 * that no canvas in these tests holds. The tools advertise that shape on their
 * `canvas_id` input, so a placeholder has to satisfy it to reach the handler at
 * all — a shorter one is rejected at argument validation and never exercises the
 * branch under test.
 */
const UNHELD_CANVAS_ID = 'Ab3_xY-9Qz';

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
    const input = chemblDataframeQuery.input.parse({
      canvas_id: UNHELD_CANVAS_ID,
      sql: 'SELECT 1',
    });
    await expect(chemblDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'canvas_disabled' },
    });
  });

  it('chembl_dataframe_describe throws ctx.fail("canvas_disabled")', async () => {
    setCanvas(undefined);
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeDescribe.errors });
    const input = chemblDataframeDescribe.input.parse({ canvas_id: UNHELD_CANVAS_ID });
    await expect(chemblDataframeDescribe.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'canvas_disabled' },
    });
  });

  it('chembl_dataframe_drop throws ctx.fail("canvas_disabled")', async () => {
    setCanvas(undefined);
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeDrop.errors });
    const input = chemblDataframeDrop.input.parse({
      canvas_id: UNHELD_CANVAS_ID,
      table_name: 'bioactivities',
    });
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
    // Under its row cap the provider leaves `truncated` off the result entirely.
    fake.queryResults = [
      { rows: [{ molecule_chembl_id: 'CHEMBL1', med: 7.4 }] },
      { rows: [{ column_types: ['VARCHAR', 'DOUBLE'] }] },
    ];
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeQuery.errors });
    const input = chemblDataframeQuery.input.parse({
      canvas_id: canvasId,
      sql: 'SELECT molecule_chembl_id, MEDIAN(pchembl_value) AS med FROM bioactivities GROUP BY 1',
    });
    const result = await chemblDataframeQuery.handler(input, ctx);
    expect(result.row_count).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.rows[0]).toMatchObject({ molecule_chembl_id: 'CHEMBL1', med: 7.4 });
    expect(renderQuery(result)).not.toContain('truncated: yes');
  });

  it('surfaces truncated:true when the canvas row cap was hit', async () => {
    const fake = new FakeDataCanvas({ defaultRowLimit: 2 });
    setCanvas(fake.cast());
    const canvasId = await seedCanvas(fake, [{ a: 1 }]);
    // One row more than the cap: the provider returns the first two and marks the cut.
    fake.queryResults = [
      { rows: [{ a: 1 }, { a: 2 }, { a: 3 }] },
      { rows: [{ column_types: ['BIGINT'] }] },
    ];
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeQuery.errors });
    const input = chemblDataframeQuery.input.parse({
      canvas_id: canvasId,
      sql: 'SELECT a FROM bioactivities',
    });
    const result = await chemblDataframeQuery.handler(input, ctx);
    expect(result.truncated).toBe(true);
    expect(result.row_count).toBe(2);
    expect(result.rows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(renderQuery(result)).toContain('truncated at the canvas row cap');
  });

  it('coerces BIGINT-string aggregates to numbers but preserves VARCHAR columns (#2)', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    // DuckDB-Node serializes BIGINT/COUNT/SUM as JSON strings; projected types
    // distinguish those strings from the raw VARCHAR value.
    const canvasId = await seedCanvas(fake, [
      { molecule_chembl_id: 'CHEMBL1', value: '500000', activity_id: 32770, pchembl_value: 7.4 },
    ]);
    fake.queryResults = [
      {
        rows: [
          {
            molecule_chembl_id: 'CHEMBL176582',
            n: '5',
            total_id: '65540',
            value: '500000',
            avg_p: 7.4,
          },
        ],
      },
      { rows: [{ column_types: ['VARCHAR', 'BIGINT', 'HUGEINT', 'VARCHAR', 'DOUBLE'] }] },
    ];
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
    fake.queryResults = [
      {
        rows: [{ big: '99999999999999999999', n: '7' }],
      },
      { rows: [{ column_types: ['HUGEINT', 'INTEGER'] }] },
    ];
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
      canvas_id: UNHELD_CANVAS_ID,
      sql: 'SELECT 1',
    });
    // The framework registry behind the fake throws NotFound for an unknown id.
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
    fake.queryResults = [
      { rows: narrowRows(60) },
      { rows: [{ column_types: ['BIGINT', 'VARCHAR'] }] },
    ];
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
    fake.queryResults = [
      { rows: wideRows(200) },
      { rows: [{ column_types: ['BIGINT', 'VARCHAR'] }] },
    ];
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
    fake.queryResults = [{ rows: [] }];
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
    fake.queryResults = [
      {
        rows: [
          {
            molecule_chembl_id: 'CHEMBL1',
            nested: { assay: { count: '5' } },
            ids: ['CHEMBL2', 'CHEMBL3'],
            n: '5',
          },
        ],
      },
      {
        rows: [
          {
            column_types: ['VARCHAR', 'STRUCT(assay STRUCT(count VARCHAR))', 'VARCHAR[]', 'BIGINT'],
          },
        ],
      },
    ];
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
    const input = chemblDataframeQuery.input.parse({
      canvas_id: UNHELD_CANVAS_ID,
      sql: 'SELECT 1',
    });
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

describe('chembl_dataframe_drop — dropped:true', () => {
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
});

/** The `content[]` text of a contract result, joined. */
function resultText(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** The framework's own re-stage advice for a missing canvas. */
const RESTAGE_HINT = 'Re-run the tool that produced this canvas_id';

/** The contract recovery chembl_dataframe_drop declares for `reason`. */
function dropRecovery(reason: string): string | undefined {
  return chemblDataframeDrop.errors?.find((entry) => entry.reason === reason)?.recovery;
}

const AS_DEFAULT_TENANT = { context: { tenantId: 'default' } };

describe('missing canvas — recovery per tool (#26)', () => {
  it('chembl_dataframe_describe keeps the framework re-stage hint', async () => {
    setCanvas(new FakeDataCanvas().cast());
    const result = await runToolContract(
      chemblDataframeDescribe,
      { canvas_id: UNHELD_CANVAS_ID },
      AS_DEFAULT_TENANT,
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'canvas_not_found',
          recovery: { hint: expect.stringContaining(RESTAGE_HINT) },
        },
      },
    });
    expect(resultText(result)).toContain(`Recovery: ${RESTAGE_HINT}`);
  });

  it('chembl_dataframe_query keeps the framework re-stage hint', async () => {
    setCanvas(new FakeDataCanvas().cast());
    const result = await runToolContract(
      chemblDataframeQuery,
      { canvas_id: UNHELD_CANVAS_ID, sql: 'SELECT 1' },
      AS_DEFAULT_TENANT,
    );
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'canvas_not_found',
          recovery: { hint: expect.stringContaining(RESTAGE_HINT) },
        },
      },
    });
    expect(resultText(result)).toContain(`Recovery: ${RESTAGE_HINT}`);
  });

  it('chembl_dataframe_drop answers an unknown canvas_id with drop recovery on both surfaces', async () => {
    setCanvas(new FakeDataCanvas().cast());
    const result = await runToolContract(
      chemblDataframeDrop,
      { canvas_id: UNHELD_CANVAS_ID, table_name: 'bioactivities' },
      AS_DEFAULT_TENANT,
    );
    const hint = dropRecovery('canvas_not_found');
    expect(hint).toBeDefined();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'canvas_not_found', recovery: { hint } },
      },
    });
    const text = resultText(result);
    expect(text).toContain(`Recovery: ${hint}`);
    expect(text).toContain('(reason canvas_not_found');
    expect(JSON.stringify(result.structuredContent)).not.toContain(RESTAGE_HINT);
    expect(text).not.toContain(RESTAGE_HINT);
  });

  it('chembl_dataframe_drop re-raises a canvas that expires between acquire and drop', async () => {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    const canvasId = await seedCanvas(fake, [{ a: 1 }]);
    const acquire = fake.acquire.bind(fake);
    /**
     * The canvas goes once the handler holds its instance, so it is the
     * instance's own drop that finds the canvas missing.
     */
    const acquired = vi.spyOn(fake, 'acquire').mockImplementation(async (...args) => {
      const instance = await acquire(...args);
      await fake.drop(canvasId, { tenantId: 'default' });
      return instance;
    });
    const result = await runToolContract(
      chemblDataframeDrop,
      { canvas_id: canvasId, table_name: 'bioactivities' },
      AS_DEFAULT_TENANT,
    );
    expect(acquired).toHaveBeenCalledTimes(1);
    expect(fake.countForTenant({ tenantId: 'default' })).toBe(0);
    const hint = dropRecovery('canvas_not_found');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'canvas_not_found', canvasId, recovery: { hint } },
      },
    });
    expect(resultText(result)).toContain(`Recovery: ${hint}`);
    expect(resultText(result)).not.toContain(RESTAGE_HINT);
  });

  it('re-raises with the framework error on cause and the canvas id on data', async () => {
    setCanvas(new FakeDataCanvas().cast());
    const ctx = createMockContext({ tenantId: 'default', errors: chemblDataframeDrop.errors });
    const input = chemblDataframeDrop.input.parse({
      canvas_id: UNHELD_CANVAS_ID,
      table_name: 'bioactivities',
    });
    const error = await Promise.resolve(chemblDataframeDrop.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found', canvasId: UNHELD_CANVAS_ID },
    });
    expect((error as Error).cause).toMatchObject({
      data: {
        reason: 'canvas_not_found',
        recovery: { hint: expect.stringContaining(RESTAGE_HINT) },
      },
    });
  });
});

describe('chembl_dataframe_drop — table-name rejections (#26)', () => {
  /** Seed a live canvas on a fresh fake and return its id. */
  async function liveCanvas(): Promise<string> {
    const fake = new FakeDataCanvas();
    setCanvas(fake.cast());
    return await seedCanvas(fake, [{ a: 1 }]);
  }

  it('answers a reserved SQL keyword with drop recovery and no naming advice', async () => {
    const canvasId = await liveCanvas();
    const result = await runToolContract(
      chemblDataframeDrop,
      { canvas_id: canvasId, table_name: 'select' },
      AS_DEFAULT_TENANT,
    );
    const hint = dropRecovery('identifier_reserved');
    expect(hint).toBeDefined();
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'identifier_reserved', recovery: { hint } },
      },
    });
    const surfaces = `${JSON.stringify(result.structuredContent)}\n${resultText(result)}`;
    expect(resultText(result)).toContain(`Recovery: ${hint}`);
    expect(surfaces).not.toContain('Choose a name');
    expect(surfaces).not.toContain('Choose another name');
  });

  it('passes the shape rejection through with the framework hint', async () => {
    const canvasId = await liveCanvas();
    const result = await runToolContract(
      chemblDataframeDrop,
      { canvas_id: canvasId, table_name: 'not-a-table' },
      AS_DEFAULT_TENANT,
    );
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'identifier_shape',
          recovery: { hint: expect.stringContaining('Use a name of letters, digits') },
        },
      },
    });
  });

  it('passes the empty-name rejection through with the framework hint', async () => {
    const canvasId = await liveCanvas();
    const result = await runToolContract(
      chemblDataframeDrop,
      { canvas_id: canvasId, table_name: '' },
      AS_DEFAULT_TENANT,
    );
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'identifier_empty',
          recovery: { hint: expect.stringContaining('Use a name of letters, digits') },
        },
      },
    });
  });

  it('reports a missing table on a live canvas as dropped:false on both surfaces', async () => {
    const canvasId = await liveCanvas();
    const result = await runToolContract(
      chemblDataframeDrop,
      { canvas_id: canvasId, table_name: 'never_existed' },
      AS_DEFAULT_TENANT,
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ dropped: false });
    expect(resultText(result)).toContain('No table by that name on this canvas');
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
      'No table by that name on this canvas',
    );
  });
});
