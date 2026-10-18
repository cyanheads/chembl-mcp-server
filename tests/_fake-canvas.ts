/**
 * @fileoverview Test double for the framework `DataCanvas` that chembl's flagship
 * and dataframe tools drive. The lifecycle layer is the framework's own: a real
 * `DataCanvas` over a real `CanvasRegistry` (sweeper off) hands out real
 * `CanvasInstance` handles, so minted ids, tenancy, the per-tenant canvas cap, a
 * malformed or unknown `canvas_id`, a canvas dropped by id, and every instance
 * call after its canvas is gone fail exactly as in production. Only the DuckDB
 * provider underneath is replaced, by an in-memory one that repeats the provider
 * behavior the handlers reach — `registerTable`, `query` (scripted rows, plus the
 * `registerAs` copy of one table into a new one), `describe`, `drop` — with the
 * provider's own refusals (`async_iterable_requires_schema`, `empty_input`,
 * `invalid_query_bounds`, `missing_table`, `register_as_clash`) carrying its
 * message, reason, and recovery hint as written in its source, in its check
 * order. Pass `new FakeDataCanvas().cast()` to `setCanvas(...)`, and inspect
 * staged tables through `canvases`.
 * @module tests/_fake-canvas
 */

import {
  type AcquireOptions,
  assertValidIdentifier,
  CanvasRegistry,
  type ColumnSchema,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  type DescribeOptions,
  type IDataCanvasProvider,
  inferSchemaFromRows,
  type QueryOptions,
  type QueryResult,
  type RegisterRows,
  type RegisterTableOptions,
  type RegisterTableResult,
  type TableInfo,
} from '@cyanheads/mcp-ts-core/canvas';
import { notFound, validationError } from '@cyanheads/mcp-ts-core/errors';

/** The DuckDB provider's defaults for `CANVAS_DEFAULT_ROW_LIMIT` and `CANVAS_SCHEMA_SNIFF_ROWS`. */
const DEFAULT_ROW_LIMIT = 10_000;
const SCHEMA_SNIFF_ROWS = 100;

/**
 * The request context `DataCanvas` takes. It reads `tenantId` alone, so tests
 * pass `{ tenantId }` where a handler passes its `ctx`.
 */
type CanvasContext = Parameters<DataCanvas['acquire']>[1];

/** A staged table: its columns and the rows the appender wrote. */
interface FakeTable {
  columns: ColumnSchema[];
  rows: Record<string, unknown>[];
}

/** One canvas's tables, keyed by name. */
interface FakeCanvasState {
  tables: Map<string, FakeTable>;
}

/** The rows one `instance.query(...)` without `registerAs` returns, consumed in call order. */
export interface ScriptedQuery {
  rows: Record<string, unknown>[];
}

/**
 * The framework `DataCanvas`, over the in-memory provider below. `maxCanvasesPerTenant`
 * and `defaultRowLimit` default to the framework's own (500 and 10,000). `cast()`
 * widens it to the framework type for `setCanvas`; the `acquire`, `drop`, and
 * `countForTenant` it forwards accept a bare `{ tenantId }` for a context.
 */
export class FakeDataCanvas {
  /** The canvases the provider holds, by id — the registry adds and removes them. */
  readonly canvases = new Map<string, FakeCanvasState>();
  /** Scripted results consumed in query() call order. */
  queryResults: ScriptedQuery[] = [];
  /** An error to throw on the next query() call (e.g. a canvas SQL-gate rejection). */
  nextQueryError: unknown;
  private readonly canvas: DataCanvas;

  constructor(opts: { defaultRowLimit?: number; maxCanvasesPerTenant?: number } = {}) {
    const provider = new FakeDuckdbProvider(this, opts.defaultRowLimit ?? DEFAULT_ROW_LIMIT);
    const registry = new CanvasRegistry(provider, {
      ...DEFAULT_CANVAS_REGISTRY_OPTIONS,
      maxCanvasesPerTenant:
        opts.maxCanvasesPerTenant ?? DEFAULT_CANVAS_REGISTRY_OPTIONS.maxCanvasesPerTenant,
      sweeperIntervalMs: 0,
    });
    this.canvas = new DataCanvas(provider, registry);
  }

  /** Widen to the framework `DataCanvas` for `setCanvas(...)`. */
  cast(): DataCanvas {
    return this as unknown as DataCanvas;
  }

  acquire(maybeId: string | undefined, ctx: { tenantId?: string }, options?: AcquireOptions) {
    return this.canvas.acquire(maybeId, ctx as CanvasContext, options);
  }

  drop(canvasId: string, ctx: { tenantId?: string }) {
    return this.canvas.drop(canvasId, ctx as CanvasContext);
  }

  countForTenant(ctx: { tenantId?: string }) {
    return this.canvas.countForTenant(ctx as CanvasContext);
  }
}

/**
 * In-memory stand-in for the DuckDB provider. The registry resolves the canvas
 * before every call reaches it, so each method finds its canvas's state, then
 * repeats the provider's own checks in the provider's order.
 */
class FakeDuckdbProvider implements IDataCanvasProvider {
  readonly name = 'fake-duckdb';

  constructor(
    private readonly owner: FakeDataCanvas,
    private readonly defaultRowLimit: number,
  ) {}

  async initCanvas(canvasId: string): Promise<void> {
    this.owner.canvases.set(canvasId, { tables: new Map() });
  }

  async destroyCanvas(canvasId: string): Promise<void> {
    this.owner.canvases.delete(canvasId);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async shutdown(): Promise<void> {
    this.owner.canvases.clear();
  }

  /**
   * As in the DuckDB provider: the table name is gated, then the schema is
   * settled — the explicit one, or the framework's inference from the first 100
   * rows of a sync source (an async source without a schema, or an empty one,
   * is refused) — and every column name gated, all before an existing table
   * under the name is dropped. The empty table is then created before any
   * further row is read, and rows are appended as the source yields them,
   * checking the signal between rows, so a registration that fails part-way
   * leaves a partial table behind the name — never the rows it held before. The
   * appender writes the schema's columns alone, a missing value as null.
   */
  async registerTable(
    canvasId: string,
    name: string,
    rows: RegisterRows,
    _context: unknown,
    options?: RegisterTableOptions,
  ): Promise<RegisterTableResult> {
    const state = this.held(canvasId);
    assertValidIdentifier(name, 'table');
    options?.signal?.throwIfAborted();
    const sync =
      typeof (rows as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
        ? undefined
        : (rows as Iterable<Record<string, unknown>>)[Symbol.iterator]();
    const sniffed: Record<string, unknown>[] = [];
    let schema = options?.schema;
    if (!schema) {
      if (!sync) {
        throw validationError(
          'Schema must be provided explicitly when registering rows from an AsyncIterable.',
          { reason: 'async_iterable_requires_schema', tableName: name },
        );
      }
      while (sniffed.length < SCHEMA_SNIFF_ROWS) {
        const next = sync.next();
        if (next.done) break;
        sniffed.push(next.value);
      }
      schema = inferSchemaFromRows(sniffed);
    }
    const columns = schema;
    for (const col of columns) assertValidIdentifier(col.name, 'column');

    const stored: Record<string, unknown>[] = [];
    state.tables.set(name, { columns, rows: stored });
    options?.signal?.throwIfAborted();
    const append = (row: Record<string, unknown>) => {
      options?.signal?.throwIfAborted();
      stored.push(Object.fromEntries(columns.map((col) => [col.name, row[col.name] ?? null])));
    };
    for (const row of sniffed) append(row);
    if (sync) {
      for (let next = sync.next(); !next.done; next = sync.next()) append(next.value);
    } else {
      for await (const row of rows as AsyncIterable<Record<string, unknown>>) append(row);
    }
    return { tableName: name, rowCount: stored.length, columns: columns.map((col) => col.name) };
  }

  /**
   * The row bounds are validated first, as in the DuckDB provider. `registerAs`
   * then runs the copy the handlers issue ({@link copyTable}); any other SQL
   * answers with the next scripted rows, capped at `rowLimit`: `rowCount` counts
   * the capped rows, `truncated` is present only when rows past the cap were
   * cut, and `preview` slices what is returned.
   */
  async query(
    canvasId: string,
    sql: string,
    _context: unknown,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const state = this.held(canvasId);
    const rowLimit = options?.rowLimit ?? this.defaultRowLimit;
    if (!Number.isSafeInteger(rowLimit) || rowLimit < 1 || rowLimit > this.defaultRowLimit) {
      throw validationError(
        `rowLimit must be a positive safe integer no greater than ${this.defaultRowLimit}.`,
        { reason: 'invalid_query_bounds', field: 'rowLimit' },
      );
    }
    const preview = options?.preview ?? rowLimit;
    if (!Number.isSafeInteger(preview) || preview < 0 || preview > rowLimit) {
      throw validationError(
        'preview must be a non-negative safe integer no greater than rowLimit.',
        { reason: 'invalid_query_bounds', field: 'preview' },
      );
    }
    if (this.owner.nextQueryError !== undefined) {
      const err = this.owner.nextQueryError;
      this.owner.nextQueryError = undefined;
      throw err;
    }
    if (options?.registerAs !== undefined) {
      return copyTable(state, sql, options.registerAs, preview);
    }
    const fetched = this.owner.queryResults.shift()?.rows ?? [];
    const rows = fetched.slice(0, rowLimit);
    return {
      rows: rows.slice(0, preview),
      columns: Object.keys(fetched[0] ?? {}),
      rowCount: rows.length,
      ...(fetched.length > rowLimit && { truncated: true }),
    };
  }

  /**
   * Tables in name order (the provider's `ORDER BY table_name`), each column
   * nullable unless its schema declared it NOT NULL. The fake registers no views.
   */
  async describe(
    canvasId: string,
    _context: unknown,
    options?: DescribeOptions,
  ): Promise<TableInfo[]> {
    const state = this.held(canvasId);
    if (options?.tableName !== undefined) assertValidIdentifier(options.tableName, 'table');
    if (options?.kind === 'view') return [];
    return [...state.tables]
      .filter(([name]) => !options?.tableName || name === options.tableName)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, table]) => ({
        name,
        kind: 'table',
        rowCount: table.rows.length,
        columns: table.columns.map((col) => ({
          name: col.name,
          type: col.type,
          nullable: col.nullable !== false,
        })),
      }));
  }

  /** Runs the framework's identifier gate first, as the DuckDB provider's drop does. */
  async drop(canvasId: string, name: string): Promise<boolean> {
    const state = this.held(canvasId);
    assertValidIdentifier(name, 'table');
    return state.tables.delete(name);
  }

  async clear(canvasId: string): Promise<number> {
    const state = this.held(canvasId);
    const count = state.tables.size;
    state.tables.clear();
    return count;
  }

  async registerView(): Promise<never> {
    throw new Error('FakeDataCanvas does not register views.');
  }

  async importFrom(): Promise<never> {
    throw new Error('FakeDataCanvas does not import tables.');
  }

  async export(): Promise<never> {
    throw new Error('FakeDataCanvas does not export tables.');
  }

  private held(canvasId: string): FakeCanvasState {
    const state = this.owner.canvases.get(canvasId);
    if (!state) throw new Error(`FakeDataCanvas holds no canvas ${canvasId}.`);
    return state;
  }
}

/**
 * `query(sql, { registerAs })` for the one statement the handlers issue with it,
 * `SELECT * FROM <table>`: a new table with the source's columns and types, as
 * DuckDB's CTAS keeps them. The provider runs its SQL gate first, so a missing
 * source (`missing_table`) is reported before the target name is gated or found
 * taken (`register_as_clash`) — `registerAs` never replaces a table.
 */
function copyTable(
  state: FakeCanvasState,
  sql: string,
  target: string,
  preview: number,
): QueryResult {
  const sourceName = /^SELECT \* FROM ([A-Za-z_][A-Za-z0-9_]*)$/i.exec(sql.trim())?.[1];
  if (sourceName === undefined) {
    throw new Error(`FakeDataCanvas copies only "SELECT * FROM <table>"; got: ${sql}`);
  }
  const source = state.tables.get(sourceName);
  if (!source) {
    throw notFound(
      `Canvas table "${sourceName}" does not exist. The table may have expired, been dropped, or the name may be mistyped.`,
      {
        reason: 'missing_table',
        tableName: sourceName,
        recovery: {
          hint: "Re-run the tool that produced this table to stage it again, or list the currently staged tables with this server's dataframe-describe tool.",
        },
      },
    );
  }
  assertValidIdentifier(target, 'table');
  if (state.tables.has(target)) {
    throw validationError(
      `Canvas table "${target}" already exists. Drop it before reusing the name.`,
      { reason: 'register_as_clash', tableName: target },
    );
  }
  state.tables.set(target, { columns: [...source.columns], rows: [...source.rows] });
  return {
    rows: source.rows.slice(0, preview),
    rowCount: source.rows.length,
    columns: source.columns.map((col) => col.name),
    tableName: target,
  };
}
