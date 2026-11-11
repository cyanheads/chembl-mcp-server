/**
 * @fileoverview chembl_dataframe_query — run a read-only SQL SELECT over the
 * bioactivity rows chembl_get_bioactivities staged on a canvas, for ranking,
 * grouping, deduping, and aggregating across the full set (not just the inline
 * preview). Mandatory companion to the spill: a canvas_id with no query tool is
 * dead output.
 *
 * One bound applies to a result: the canvas engine's row cap, disclosed as
 * `truncated`. Both surfaces carry every row the SQL returns, so the caller sizes
 * the result in the SQL itself (projected columns, LIMIT) and pages a truncated
 * result with ORDER BY a unique column and LIMIT/OFFSET written into the query.
 * @module mcp-server/tools/definitions/chembl-dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { mdInline } from '@/mcp-server/markdown-text.js';
import { getCanvas } from '@/services/canvas-accessor.js';

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
 * `structuredContent` carries in full. Cells hold upstream text (assay
 * descriptions, comments), so each takes the shared escape, which also writes a
 * line break as a character reference; pipes are escaped after it, so no single
 * cell can break the row it sits in.
 */
function renderCell(value: unknown): string {
  const text =
    typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
  return mdInline(text).replaceAll('|', '\\|');
}

/** One result row as a markdown table line, in header column order. */
function renderRow(row: Record<string, unknown>, columns: string[]): string {
  return `| ${columns.map((col) => renderCell(row[col])).join(' | ')} |`;
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
    "Run a read-only SQL SELECT over the bioactivity rows chembl_get_bioactivities staged on a canvas — rank, group, dedupe, and aggregate across the FULL set, not the inline preview. Reference each staged table by the name chembl_get_bioactivities returned — bioactivities for its potency_ranked view, bioactivities_null_potency for null_potency; discover the staged tables and their columns with chembl_dataframe_describe. Compute honest aggregates here (e.g. SELECT parent_molecule_chembl_id, MEDIAN(pchembl_value) AS med FROM bioactivities WHERE standard_type = 'IC50' AND potential_duplicate IS NOT TRUE GROUP BY 1 ORDER BY 2 DESC, which merges a drug with its salts and drops likely repeat citations). Every row the SQL returns comes back on both structuredContent and content[], so bound the result in the SQL itself: project only the columns you need and set a LIMIT. truncated is true when the result exceeded the canvas row cap; page past it with ORDER BY a unique column (e.g. activity_id) and LIMIT/OFFSET written into the query, in place of any LIMIT it already has — offsets reach rows beyond the cap. Unavailable when the server sets CANVAS_PROVIDER_TYPE=none.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas ID returned by chembl_get_bioactivities — non-null whenever that call staged a table.',
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
    truncated: z
      .boolean()
      .describe(
        'True when the SQL result exceeded the canvas row cap, so rows is a bounded slice of the result set. Page past it with ORDER BY a unique column (e.g. activity_id) and LIMIT/OFFSET written into the query.',
      ),
  }),
  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The server runs with the canvas off (CANVAS_PROVIDER_TYPE=none), so no canvas exists.',
      recovery:
        'The SQL path is off on this server; read the inline rows from chembl_get_bioactivities and page with its nextCursor.',
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
      truncated: result.truncated ?? false,
    };
  },

  /**
   * Every row the handler returned renders, in order, so content[] carries the same
   * rowset as structuredContent. The truncated note sits above the table, never
   * below it, where a reader of a long table would miss it.
   */
  format: (result) => {
    if (result.rows.length === 0) {
      return [{ type: 'text', text: 'Query returned no rows.' }];
    }
    const columns = Object.keys(result.rows[0] ?? {});
    const head = `| ${columns.join(' | ')} |`;
    const sep = `| ${columns.map(() => '---').join(' | ')} |`;
    const body = result.rows.map((row) => renderRow(row, columns)).join('\n');
    const trunc = result.truncated
      ? '\ntruncated: yes — the SQL result was truncated at the canvas row cap, so these rows are a bounded slice of a larger result set. To read the rest, page with ORDER BY a unique column (e.g. activity_id) and LIMIT/OFFSET written into the query, in place of any LIMIT it already has.'
      : '';
    return [
      {
        type: 'text',
        text: `${result.row_count} rows.${trunc}\n\n${head}\n${sep}\n${body}`,
      },
    ];
  },
});
