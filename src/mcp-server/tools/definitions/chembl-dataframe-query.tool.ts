/**
 * @fileoverview chembl_dataframe_query — run a read-only SQL SELECT over the
 * bioactivity rows chembl_get_bioactivities spilled to a canvas, for ranking,
 * grouping, deduping, and aggregating across the full set (not just the inline
 * preview). Mandatory companion to the spill: a canvas_id with no query tool is
 * dead output.
 *
 * Two independent bounds apply to a result, and each gets its own output field so
 * neither can be read as the other: `truncated` is the canvas engine capping the SQL
 * result set, `rendered_rows` is the character budget bounding the markdown table
 * written into content[]. SQL LIMIT/OFFSET is the retrieval path past both.
 * @module mcp-server/tools/definitions/chembl-dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';

/**
 * Character budget for the markdown table `format()` writes into `content[]` —
 * ~10k tokens at the ~4-chars-per-token heuristic, the same preview tier this
 * server already sizes its bioactivity spill against. Budgeting in characters
 * rather than rows is the point: two ID columns and a column of assay prose differ
 * by an order of magnitude at the same row count, so a row cap bounds context only
 * by accident — small results get cut for no reason and wide ones still overrun.
 */
const RENDER_CHAR_BUDGET = 40_000;

/** Whole DuckDB integer tags; ENUM labels, INTERVAL, and nested types must not match. */
const INTEGER_TYPES = new Set([
  'TINYINT',
  'SMALLINT',
  'INTEGER',
  'BIGINT',
  'HUGEINT',
  'UTINYINT',
  'USMALLINT',
  'UINTEGER',
  'UBIGINT',
  'UHUGEINT',
  'BIGNUM',
]);

/**
 * One cell as markdown-table-safe text. Structs and lists render as JSON —
 * `String()` flattens them to "[object Object]", dropping from `content[]` a value
 * `structuredContent` carries in full. Pipes are escaped and newlines folded so no
 * single cell can break the row it sits in.
 */
function renderCell(value: unknown): string {
  const text =
    typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
  return text.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');
}

/** One result row as a markdown table line, in header column order. */
function renderRow(row: Record<string, unknown>, columns: string[]): string {
  return `| ${columns.map((col) => renderCell(row[col])).join(' | ')} |`;
}

/**
 * How many leading rows the markdown table holds within {@link RENDER_CHAR_BUDGET},
 * measured on the lines `format()` actually emits. The first row always renders: a
 * header with no body is not a readable table, and a row wide enough to exhaust the
 * budget on its own still has to be shown rather than silently dropped.
 */
function rowsWithinRenderBudget(rows: Record<string, unknown>[]): number {
  const columns = Object.keys(rows[0] ?? {});
  let used = 0;
  let count = 0;
  for (const row of rows) {
    used += renderRow(row, columns).length + 1; // + the newline joining it to the next
    if (used > RENDER_CHAR_BUDGET && count > 0) break;
    count += 1;
  }
  return count;
}

/**
 * Coerce integer-valued strings in DuckDB query rows back to JS numbers.
 *
 * DuckDB-Node serializes BIGINT/large-integer columns — COUNT(*), SUM over integer
 * columns, the native activity_id — as JSON STRINGS to dodge JavaScript's 53-bit
 * precision limit, so an agent sorting or comparing aggregate counts receives "1"
 * instead of 1 (DOUBLE columns already arrive as numbers). This re-numbers them, but
 * only where it is safe and correct:
 *   - A value is coerced only when it is a canonical integer string (/^-?\d+$/) AND
 *     `Number.isSafeInteger` holds — a value beyond 2^53 stays a string so precision
 *     is never silently lost (the documented boundary).
 *   - Only integer-typed SQL projections are converted. Aliases, expressions,
 *     and casts retain the types DuckDB assigned to the result itself.
 */
function coerceIntegerStrings(
  rows: Record<string, unknown>[],
  integerColumns: ReadonlyMap<string, boolean>,
): Record<string, unknown>[] {
  return rows.map((row) => {
    let mutated: Record<string, unknown> | undefined;
    for (const [col, val] of Object.entries(row)) {
      if (!integerColumns.get(col)) continue;
      if (typeof val !== 'string' || !/^-?\d+$/.test(val)) continue;
      const num = Number(val);
      if (!Number.isSafeInteger(num)) continue; // beyond 2^53 — keep the string, never lose precision
      if (!mutated) mutated = { ...row };
      mutated[col] = num;
    }
    return mutated ?? row;
  });
}

export const chemblDataframeQuery = tool('chembl_dataframe_query', {
  title: 'chembl-dataframe-query',
  description:
    "Run a read-only SQL SELECT over the bioactivity rows chembl_get_bioactivities spilled to a canvas — rank, group, dedupe, and aggregate across the FULL set, not the inline preview. Reference each staged table by the name chembl_get_bioactivities returned — bioactivities for its potency_ranked view, bioactivities_null_potency for null_potency; discover the staged tables and their columns with chembl_dataframe_describe. Compute honest aggregates here (e.g. SELECT molecule_chembl_id, MEDIAN(pchembl_value) AS med FROM bioactivities WHERE standard_type = 'IC50' GROUP BY 1 ORDER BY 2 DESC). Two independent bounds apply, each reported on its own field: truncated is true when the SQL result exceeded the canvas row cap, and rendered_rows says how many of the returned rows the markdown table holds once its character budget is reached (below row_count on a wide or long result). Page past either bound with SQL LIMIT/OFFSET — append e.g. LIMIT 500 OFFSET 500 and re-call; offsets reach rows beyond the canvas row cap. Requires CANVAS_PROVIDER_TYPE=duckdb.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas ID returned by chembl_get_bioactivities (spilled: true).',
    ),
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
    rendered_rows: z
      .number()
      .describe(
        'How many of those rows the markdown table in content[] holds. Below row_count when the rendered table reached its character budget — a rendering bound, INDEPENDENT of truncated: a response can be truncated:false and still render fewer rows than row_count. Re-run the same SQL with LIMIT/OFFSET to read the rows past it.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when the SQL result exceeded the canvas row cap and was truncated — the engine bounding the result set itself, not the rendering. Independent of rendered_rows; page past it with LIMIT/OFFSET.',
      ),
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
      throw ctx.fail('canvas_disabled', undefined, ctx.recoveryFor('canvas_disabled'));
    }
    // Canvas-resolution failures (unknown id, missing table, invalid SQL) are
    // thrown by the DataCanvas primitive with structured data.reason — bubble them.
    const instance = await canvas.acquire(input.canvas_id, ctx);

    const result = await instance.query(input.sql, { signal: ctx.signal });
    const integerColumns = new Map<string, boolean>();
    if (result.rows.length > 0) {
      /**
       * DESCRIBE binds the already-gated query without executing or materializing
       * it. A single aggregate row keeps metadata complete even with rowLimit=1.
       * query() accepts the original SQL as a literal, including trailing comments
       * and semicolons; only the metadata query is wrapped, never the data query.
       */
      const metadata = await instance.query(
        `SELECT list(column_type) AS column_types FROM (DESCRIBE SELECT * FROM query('${input.sql.replaceAll("'", "''")}'))`,
        { rowLimit: 1, signal: ctx.signal },
      );
      const columnTypes = z
        .array(z.string())
        .length(result.columns.length)
        .parse(metadata.rows[0]?.column_types);
      const occurrences = new Map<string, number>();
      for (const [index, name] of result.columns.entries()) {
        /**
         * DuckDB-Node's row objects suffix repeated names with :1, :2, ...;
         * query() uses different suffixes, so map by position, not metadata name.
         * A later explicit alias can overwrite a generated key; its type wins too.
         */
        const occurrence = occurrences.get(name) ?? 0;
        occurrences.set(name, occurrence + 1);
        const key = occurrence === 0 ? name : `${name}:${occurrence}`;
        // The parsed metadata array has exactly result.columns.length entries.
        integerColumns.set(key, INTEGER_TYPES.has(columnTypes[index] as string));
      }
    }
    const rows = coerceIntegerStrings(result.rows, integerColumns);
    return {
      rows,
      row_count: rows.length,
      rendered_rows: rowsWithinRenderBudget(rows),
      truncated: result.truncated ?? false,
    };
  },

  /**
   * The table is bounded by `rendered_rows` — the character budget the handler
   * already resolved — so both surfaces agree on exactly how much of the rowset
   * `content[]` holds. Both bounds are disclosed above the table, never below it: a
   * note under a 40,000-character table is the first thing a reader loses.
   */
  format: (result) => {
    if (result.rows.length === 0) {
      return [{ type: 'text', text: 'Query returned no rows.' }];
    }
    const columns = Object.keys(result.rows[0] ?? {});
    const head = `| ${columns.join(' | ')} |`;
    const sep = `| ${columns.map(() => '---').join(' | ')} |`;
    const body = result.rows
      .slice(0, result.rendered_rows)
      .map((row) => renderRow(row, columns))
      .join('\n');
    const renderNote =
      result.rendered_rows < result.row_count
        ? `rendered_rows: ${result.rendered_rows} of ${result.row_count} — the render budget bounded the table below, NOT the data; the rest are in structuredContent.rows. Re-run the same SQL with LIMIT/OFFSET to read them here (e.g. append \`LIMIT ${result.rendered_rows} OFFSET ${result.rendered_rows}\`).`
        : `rendered_rows: ${result.rendered_rows} — every row is in the table below.`;
    const trunc = result.truncated
      ? '\ntruncated: yes — the SQL result was truncated at the canvas row cap, so these rows are a bounded slice of a larger result set; page past it with LIMIT/OFFSET.'
      : '';
    return [
      {
        type: 'text',
        text: `${result.row_count} rows.\n${renderNote}${trunc}\n\n${head}\n${sep}\n${body}`,
      },
    ];
  },
});
