/**
 * @fileoverview A fake ChEMBL `/activity` endpoint over a fixed corpus, for the
 * tests of the bioactivity page walk. It behaves like the live API on the points
 * the walk depends on: the count request (no `order_by`) answers the honest total,
 * and a view request honors `offset` / `limit`, reports the view's
 * `page_meta.total_count`, and orders by its repeated `order_by` keys. Inside a
 * `-pchembl_value` tie the order is unstable across requests unless
 * `activity_id` breaks the tie, which is how ChEMBL repeats and drops tied rows at
 * page boundaries. ChEMBL reads several keys only as a repeated param: an
 * `order_by` value that is not one bare field name — the comma form, or the
 * Python list repr below — is answered with HTTP 400. `page_meta.next` and
 * `page_meta.previous` re-serialize the received order the way ChEMBL does: one
 * key passes through, several become that Python list repr. The corpus is the
 * view itself; the fake applies no filters.
 *
 * For the concurrent spill walk a view page can also answer late (so requests
 * overlap and complete out of order), never answer, or answer with an HTTP error
 * status, and `traffic` counts the view requests in flight and records the order
 * they answered in. A page that has not answered when its request is aborted
 * rejects with the signal's reason, as real `fetch` does.
 * @module tests/_fake-activity-upstream
 */

/** A raw upstream activity row: a numeric `activity_id`, and a string `pchembl_value` on ranked rows. */
type RawRow = Record<string, unknown>;

/** Live counters over the view requests a corpus has served. */
export interface CorpusTraffic {
  /** Requests aborted before their page answered. */
  aborted: number;
  /** The offset of each view request that answered, an HTTP error status included, in answer order. */
  answered: number[];
  /** View requests sent and not yet answered. */
  inFlight: number;
  /** The most view requests in flight at once. */
  maxInFlight: number;
}

/** A fresh, zeroed {@link CorpusTraffic}. */
export function corpusTraffic(): CorpusTraffic {
  return { aborted: 0, answered: [], inFlight: 0, maxInFlight: 0 };
}

export interface ActivityCorpusOptions {
  /**
   * Answer the view page at `offset` with HTTP `status` instead of its rows: its
   * first `times` answers, or every answer when `times` is omitted.
   */
  failAt?: { offset: number; status: number; times?: number };
  /** `page_meta.total_count` on the count request. Defaults to the corpus size. */
  honest?: number;
  /** Milliseconds before a view page answers, fixed or by offset. Defaults to none. */
  latencyMs?: number | ((offset: number) => number);
  /** The view's rows, in any order — the fake sorts them per request. */
  rows: RawRow[];
  /** View offsets whose requests never answer; each settles only when its request is aborted. */
  stallAt?: readonly number[];
  /** The count request never answers either; it settles only when its request is aborted. */
  stallCount?: boolean;
  /** Counters this corpus updates as it serves view requests. */
  traffic?: CorpusTraffic;
  /**
   * `page_meta.total_count` on view requests. Defaults to the corpus size. A
   * larger value models a stale count, which a short page must end; a smaller one
   * contradicts the rows and is refused.
   */
  viewTotal?: number;
}

/** ChEMBL's page size when a request names none. */
const UPSTREAM_DEFAULT_LIMIT = 20;

/** The only form of `order_by` value ChEMBL accepts: one bare field name, optionally descending. */
const ORDER_KEY = /^-?[a-z][a-z0-9_]*$/;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A per-request permutation key, so a tie group reorders whenever the offset moves. */
function tieShuffleKey(row: RawRow, offset: number): number {
  return Math.imul(Number(row.activity_id) ^ (offset + 1), 2654435761) >>> 0;
}

/** The view in the order the request's `order_by` keys produce. */
function orderView(rows: RawRow[], order: string[], offset: number): RawRow[] {
  const byId = (a: RawRow, b: RawRow) => Number(a.activity_id) - Number(b.activity_id);
  if (order[0] !== '-pchembl_value') return [...rows].sort(byId);
  const tieBroken = order[1] === 'activity_id';
  return [...rows].sort(
    (a, b) =>
      Number(b.pchembl_value) - Number(a.pchembl_value) ||
      (tieBroken ? byId(a, b) : tieShuffleKey(a, offset) - tieShuffleKey(b, offset)),
  );
}

/** How ChEMBL writes the received order back into `page_meta.next`. */
function serializeOrder(order: string[]): string {
  return order.length === 1 ? (order[0] ?? '') : `[${order.map((k) => `'${k}'`).join(', ')}]`;
}

/** A view page URL over the received order, as ChEMBL writes one into `page_meta`. */
function pageUrl(limit: number, offset: number, order: string[]): string {
  return `/chembl/api/data/activity.json?limit=${limit}&offset=${offset}&order_by=${encodeURIComponent(serializeOrder(order))}`;
}

/**
 * Deliver the view page at `offset` after `delayMs` (or never, when `stalled`),
 * counted in `traffic` while pending. An abort on `signal` first rejects with
 * its reason.
 */
function deliver(
  answer: () => Response,
  offset: number,
  delayMs: number,
  stalled: boolean,
  signal: AbortSignal | undefined,
  traffic: CorpusTraffic | undefined,
): Promise<Response> {
  if (traffic) {
    traffic.inFlight += 1;
    traffic.maxInFlight = Math.max(traffic.maxInFlight, traffic.inFlight);
  }
  const settle = () => {
    if (traffic) traffic.inFlight -= 1;
  };
  const respond = () => {
    settle();
    traffic?.answered.push(offset);
    return answer();
  };
  if (!stalled && delayMs <= 0 && !signal?.aborted) {
    return Promise.resolve(respond());
  }
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      clearTimeout(timer);
      settle();
      if (traffic) traffic.aborted += 1;
      reject(signal?.reason);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (stalled) return;
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(respond());
    }, delayMs);
  });
}

/** A `fetch` implementation answering the count request and view pages over `opts.rows`. */
export function activityCorpus(
  opts: ActivityCorpusOptions,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const viewTotal = opts.viewTotal ?? opts.rows.length;
  if (viewTotal < opts.rows.length) {
    throw new Error(
      `viewTotal ${viewTotal} is below the ${opts.rows.length} corpus rows; pass only the rows the view holds.`,
    );
  }
  const honest = opts.honest ?? opts.rows.length;
  const latency = opts.latencyMs ?? 0;
  let failuresLeft = opts.failAt?.times ?? Number.POSITIVE_INFINITY;
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const params = url.searchParams;
    const order = params.getAll('order_by');
    if (order.length === 0) {
      const count = () =>
        jsonResponse({ activities: [], page_meta: { total_count: honest, next: null } });
      return opts.stallCount
        ? deliver(count, 0, 0, true, init?.signal ?? undefined, undefined)
        : Promise.resolve(count());
    }
    const unreadable = order.find((key) => !ORDER_KEY.test(key));
    if (unreadable !== undefined) {
      return Promise.resolve(
        jsonResponse({ error_message: `No matching '${unreadable}' field for ordering on.` }, 400),
      );
    }
    const offset = Number(params.get('offset') ?? 0);
    const limit = Number(params.get('limit') ?? UPSTREAM_DEFAULT_LIMIT);
    const answer = () => {
      if (opts.failAt?.offset === offset && failuresLeft > 0) {
        failuresLeft -= 1;
        return jsonResponse({ error_message: 'upstream failure' }, opts.failAt.status);
      }
      const activities = orderView(opts.rows, order, offset).slice(offset, offset + limit);
      return jsonResponse({
        activities,
        page_meta: {
          total_count: viewTotal,
          limit,
          offset,
          // django-tastypie's paginator rules, which ChEMBL serves its lists through.
          next: offset + limit < viewTotal ? pageUrl(limit, offset + limit, order) : null,
          previous: offset - limit >= 0 ? pageUrl(limit, offset - limit, order) : null,
        },
      });
    };
    const delayMs = typeof latency === 'function' ? latency(offset) : latency;
    const stalled = opts.stallAt?.includes(offset) ?? false;
    return deliver(answer, offset, delayMs, stalled, init?.signal ?? undefined, opts.traffic);
  };
}

/** The query params of every view request (the ones carrying `order_by`), in call order. */
export function viewRequests(calls: readonly unknown[][]): URLSearchParams[] {
  return calls
    .map((call) => {
      const input = call[0];
      return new URL(input instanceof Request ? input.url : String(input)).searchParams;
    })
    .filter((params) => params.has('order_by'));
}
