/**
 * @fileoverview Structural fakes for the framework `DataCanvas` / `CanvasInstance`
 * surface that chembl's flagship + dataframe tools drive — `acquire`,
 * `registerTable` (used by `spillover`), `query`, `describe`, and `drop`. A fake
 * at the canvas boundary exercises handler behavior end-to-end without pulling in
 * DuckDB, and lets tests script `query` rows / `truncated` and inspect staged
 * tables. Pass `new FakeDataCanvas()` to `setCanvas(...)` and the handlers run
 * their real canvas paths against it.
 * @module tests/_fake-canvas
 */

import type {
  CanvasInstance,
  QueryResult,
  RegisterRows,
  RegisterTableResult,
  TableInfo,
} from '@cyanheads/mcp-ts-core/canvas';
import { notFound } from '@cyanheads/mcp-ts-core/errors';

/** A staged table: the rows registered plus the column order. */
interface FakeTable {
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
}

/** Internal state for one fake canvas, keyed by canvasId + tenant. */
interface FakeCanvasState {
  canvasId: string;
  expiresAt: string;
  tables: Map<string, FakeTable>;
  tenantId: string;
}

/**
 * A scripted result for the next `instance.query(...)` call. When set, the fake
 * returns these rows verbatim (so the query-tool's row_count/truncated mapping is
 * testable). Cleared after one use.
 */
export interface ScriptedQuery {
  rows: Record<string, unknown>[];
  truncated?: boolean;
}

/**
 * Structural fake for `DataCanvas`. Tracks canvases by id, throws NotFound for an
 * unknown id (mirroring the real acquire), and supports the register/query/
 * describe/drop surface the chembl handlers use. `cast()` widens it to the
 * framework type for `setCanvas` (the real class has private fields).
 */
export class FakeDataCanvas {
  readonly canvases = new Map<string, FakeCanvasState>();
  /** Scripted result for the next query() call, consumed once. */
  nextQuery: ScriptedQuery | undefined;
  /** An error to throw on the next query() call (e.g. a canvas SQL-gate rejection). */
  nextQueryError: unknown;
  private idCounter = 0;

  /** Widen to the framework `DataCanvas` for `setCanvas(...)`. */
  cast(): import('@cyanheads/mcp-ts-core/canvas').DataCanvas {
    return this as unknown as import('@cyanheads/mcp-ts-core/canvas').DataCanvas;
  }

  async acquire(maybeId: string | undefined, ctx: { tenantId?: string }): Promise<CanvasInstance> {
    const tenantId = ctx.tenantId ?? 'default';
    if (maybeId !== undefined) {
      const existing = this.canvases.get(maybeId);
      if (!existing || existing.tenantId !== tenantId) {
        throw notFound(`Canvas ${maybeId} not found.`, { reason: 'canvas_not_found' });
      }
      existing.expiresAt = futureIso(24);
      return this.makeInstance(existing, false);
    }
    this.idCounter += 1;
    const canvasId = `fake_${this.idCounter.toString(36).padStart(6, '0')}`;
    const state: FakeCanvasState = {
      canvasId,
      tenantId,
      expiresAt: futureIso(24),
      tables: new Map(),
    };
    this.canvases.set(canvasId, state);
    return this.makeInstance(state, true);
  }

  async drop(canvasId: string): Promise<boolean> {
    return this.canvases.delete(canvasId);
  }

  countForTenant(ctx: { tenantId?: string }): number {
    const tenantId = ctx.tenantId ?? 'default';
    let count = 0;
    for (const state of this.canvases.values()) if (state.tenantId === tenantId) count += 1;
    return count;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async shutdown(): Promise<void> {
    this.canvases.clear();
  }

  private makeInstance(state: FakeCanvasState, isNew: boolean): CanvasInstance {
    const owner = this;
    return {
      canvasId: state.canvasId,
      tenantId: state.tenantId,
      expiresAt: state.expiresAt,
      isNew,

      async registerTable(name: string, rows: RegisterRows): Promise<RegisterTableResult> {
        const materialized = await materialize(rows);
        const columns =
          materialized.length > 0
            ? Object.keys(materialized[0] ?? {}).map((c) => ({
                name: c,
                type: inferType(materialized[0]?.[c]),
              }))
            : [];
        state.tables.set(name, { columns, rows: materialized });
        return {
          tableName: name,
          rowCount: materialized.length,
          columns: columns.map((c) => c.name),
        };
      },

      async query(_sql: string): Promise<QueryResult> {
        if (owner.nextQueryError !== undefined) {
          const err = owner.nextQueryError;
          owner.nextQueryError = undefined;
          throw err;
        }
        const scripted = owner.nextQuery;
        owner.nextQuery = undefined;
        const rows = scripted?.rows ?? [];
        return {
          rows,
          rowCount: rows.length,
          columns: rows.length > 0 ? Object.keys(rows[0] ?? {}) : [],
          truncated: scripted?.truncated ?? false,
        };
      },

      async describe(opts?: { tableName?: string }): Promise<TableInfo[]> {
        const out: TableInfo[] = [];
        for (const [name, table] of state.tables) {
          if (opts?.tableName && opts.tableName !== name) continue;
          out.push({ name, kind: 'table', rowCount: table.rows.length, columns: table.columns });
        }
        return out;
      },

      async drop(name: string): Promise<boolean> {
        return state.tables.delete(name);
      },

      async clear(): Promise<number> {
        const count = state.tables.size;
        state.tables.clear();
        return count;
      },
    } as unknown as CanvasInstance;
  }
}

async function materialize(rows: RegisterRows): Promise<Record<string, unknown>[]> {
  if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  const out: Record<string, unknown>[] = [];
  for await (const row of rows as AsyncIterable<Record<string, unknown>>) out.push(row);
  return out;
}

function inferType(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) ? 'BIGINT' : 'DOUBLE';
  return 'VARCHAR';
}

function futureIso(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}
