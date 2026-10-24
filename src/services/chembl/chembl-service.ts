/**
 * @fileoverview The single upstream client for the ChEMBL REST data API. Builds
 * Django-style filtered URLs against `https://www.ebi.ac.uk/chembl/api/data`,
 * fetches `.json`, coerces string numerics → number/null at the boundary (absent
 * → null, never 0), and flattens nested upstream structures into the flat domain
 * types. Each method wraps its full fetch+parse in `withRetry`, and every request
 * of one call draws on that call's single time budget ({@link CallDeadline}). The
 * activity stream walks a view's pages by offset for the inline page; the spill
 * walk fetches them concurrently through a service-wide page limiter and yields
 * them in offset order.
 * @module services/chembl/chembl-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  defaultIsTransient,
  fetchWithTimeout,
  type Pacer,
  requestContextService,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import type {
  Activity,
  Assay,
  DrugInfo,
  GetActivitiesOptions,
  Indication,
  ListFailure,
  ListPage,
  ListStatus,
  Mechanism,
  Molecule,
  MoleculePage,
  Page,
  SearchMoleculesOptions,
  SearchTargetsOptions,
  StructureSearchOptions,
  Target,
  TargetComponent,
} from './types.js';

/**
 * Coerce an upstream value that ChEMBL ships as a JSON string (e.g. "180.16",
 * "4.0", "7.39") to a finite `number`. A missing, null, empty, or non-numeric
 * value becomes `null` — never `0`. This is the scientific-data fidelity rule:
 * an absent potency must read as absent.
 */
export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Normalize an upstream value to a non-empty trimmed string, or `null`. */
function toStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * A search query that is itself a unique identifier: a ChEMBL ID ("CHEMBL25") or
 * a standard InChIKey ("BSYNRYMUTXBXSQ-UHFFFAOYSA-N" — uppercase 14-10-1 blocks).
 * ChEMBL resolves both through the same by-resource lookup, so one test covers
 * both shapes. Anything else — including a lowercase or truncated variant — is
 * left to the fuzzy endpoint, which matches it case-insensitively.
 */
const EXACT_MOLECULE_IDENTIFIER = /^(?:CHEMBL\d+|[A-Z]{14}-[A-Z]{10}-[A-Z])$/;

/**
 * The hit ceilings of ChEMBL's capped search routes: `/molecule/search` stops at
 * its Elasticsearch result window and `/substructure` at its hit limit. Each
 * reports the ceiling as `page_meta.total_count` and serves no row at or past it,
 * so a total equal to one is a lower bound — a true count of exactly the ceiling
 * reads the same. `/similarity`, the by-resource lookups, and the filtered
 * `/target` list (which pages past 15,000) report exact counts.
 */
const NAME_SEARCH_CEILING = 10_000;
const SUBSTRUCTURE_SEARCH_CEILING = 30_000;

/**
 * The `error_message` text ChEMBL's similarity and substructure routes answer a
 * query SMILES they cannot parse with, inside an HTTP 500 JSON body: `/similarity`
 * fails standardizing it, `/substructure` hands RDKit's sanitizer the `None` its
 * parser returned. An overloaded front end answers valid queries with a 500 too,
 * but as an HTML page carrying neither.
 */
const UNPARSEABLE_STRUCTURE_MARKERS = [
  'Problem standardizing the query molecule',
  'SanitizeMol(NoneType)',
] as const;

/**
 * Whether a raw `fetchWithTimeout` failure is an HTTP 500 naming an unparseable
 * query structure — read from the body the framework captured (`data.body`, its
 * head and tail), never from the message. Meaningful only for a request to the
 * similarity or substructure route; {@link JsonFetchOptions.structureQuery} scopes it.
 */
function isUnparseableStructure(error: unknown): boolean {
  if (!(error instanceof McpError) || error.data?.status !== 500) return false;
  const body = error.data.body;
  return (
    typeof body === 'string' &&
    UNPARSEABLE_STRUCTURE_MARKERS.some((marker) => body.includes(marker))
  );
}

/**
 * Re-throw an upstream fetch failure as a clean, leak-free domain error.
 *
 * The framework's `fetchWithTimeout` throws a status-mapped {@link McpError} on
 * any non-2xx / timeout / network failure, and its `data` carries raw upstream
 * diagnostics — `statusCode`, `statusText`, `responseBody` (up to 500 bytes of the
 * upstream's error page), and `errorSource`. The framework ships `McpError.data`
 * verbatim to the client in
 * `structuredContent.error.data`, so letting that raw error escape leaks those
 * internals on a public server.
 *
 * This maps the framework error to a clean domain error by its `code`
 * (detected STRUCTURALLY via `err.code`, never by string-matching the drift-prone
 * message), with `data` reduced to a `reason` + recovery `hint` only. The raw
 * error rides as `cause` for server-side logs — `cause` is never serialized to
 * the client.
 *
 * A request to the similarity or substructure route (`scope.structureQuery`) maps
 * a 500 naming an unparseable query SMILES ({@link isUnparseableStructure}) to the
 * caller's `invalid_structure` rather than an outage.
 *
 * Always returns an `McpError` to throw; the caller does `throw sanitize(...)`.
 */
export function sanitizeUpstreamError(
  err: unknown,
  operation: string,
  scope: { structureQuery?: boolean | undefined } = {},
): McpError {
  // Non-McpError shouldn't occur (the framework wraps everything fetch throws),
  // but this is a trust boundary: never let an unknown error's fields reach the
  // client. Collapse anything unexpected into a clean ServiceUnavailable.
  if (!(err instanceof McpError)) {
    return serviceUnavailable('ChEMBL request failed.', {
      reason: 'upstream_unavailable',
      recovery: { hint: 'The ChEMBL API is unreachable. Retry shortly.' },
    });
  }

  if (scope.structureQuery && isUnparseableStructure(err)) {
    return validationError(
      'ChEMBL could not parse the query structure.',
      {
        reason: 'invalid_structure',
        recovery: {
          hint: 'Check the SMILES for an atom over its valence (a carbon with five bonds), an unclosed ring-closure digit or parenthesis, or an aromatic ring that cannot be kekulized, then retry.',
        },
      },
      { cause: err },
    );
  }

  // `cause: err` is the THIRD factory arg (options), NOT part of `data` — it
  // lands on native `Error.cause` for server logs and is never serialized to the
  // client. Putting the raw error in `data` would re-introduce the very leak.
  switch (err.code) {
    case JsonRpcErrorCode.NotFound:
      return notFound(
        'ChEMBL has no record for that identifier.',
        {
          reason: 'not_found',
          recovery: {
            hint: 'Verify the ChEMBL ID / SMILES, or discover it via chembl_search_molecules or chembl_search_targets.',
          },
        },
        { cause: err },
      );
    case JsonRpcErrorCode.InvalidParams:
    case JsonRpcErrorCode.ValidationError:
    case JsonRpcErrorCode.InvalidRequest:
      return validationError(
        'ChEMBL rejected the request parameters.',
        {
          reason: 'invalid_query',
          recovery: { hint: 'Check the identifier format and filter values, then retry.' },
        },
        { cause: err },
      );
    case JsonRpcErrorCode.Timeout:
      return timeout(
        'The ChEMBL request timed out.',
        {
          reason: 'upstream_timeout',
          recovery: { hint: 'Retry, or narrow the query with more filters / a lower limit.' },
        },
        { cause: err },
      );
    case JsonRpcErrorCode.RateLimited:
      return rateLimited(
        'ChEMBL rate-limited the request.',
        {
          reason: 'rate_limited',
          recovery: { hint: 'Wait a few seconds and retry.' },
        },
        { cause: err },
      );
    default:
      // 5xx, auth (unexpected on a keyless API), network errors — all "the
      // upstream/connection failed; retry later" from the client's view.
      return serviceUnavailable(
        'The ChEMBL API is currently unavailable.',
        {
          reason: 'upstream_unavailable',
          recovery: { hint: `Retry shortly. If it persists, ChEMBL may be down (${operation}).` },
        },
        { cause: err },
      );
  }
}

/**
 * The time budget for one tool or resource call's upstream requests, every
 * attempt and backoff included. MCP SDK clients give up on a request at 60 s by
 * default whatever this server's per-attempt timeout is, so the budget is a fixed
 * span under that bound rather than a multiple of CHEMBL_REQUEST_TIMEOUT_MS; the
 * 15 s left over cover the handler's own work and the response's trip back. The
 * bioactivity spill has its own budget, CHEMBL_SPILL_DEADLINE_MS.
 */
export const CALL_DEADLINE_MS = 45_000;

/**
 * The budget of the best-effort `standard_type` case-variant lookup, capped by
 * what the call has left. The call it serves has already answered zero rows; a
 * healthy lookup is one `limit: 1` request, so this bounds only how long a hung
 * one can hold that answer back.
 */
const STANDARD_TYPE_SPELLING_BUDGET_MS = 5_000;

/**
 * One call's upstream time budget, as an absolute expiry. Every request the call
 * makes draws on the same instance, so chained and concurrent requests (a count
 * before a page, getDrugInfo's anchor and its two lists) share one budget rather than each
 * restarting the clock.
 */
export class CallDeadline {
  readonly budgetMs: number;
  readonly expiresAt: number;

  constructor(budgetMs: number) {
    this.budgetMs = budgetMs;
    this.expiresAt = Date.now() + budgetMs;
  }

  /** Milliseconds left, never negative. */
  get remainingMs(): number {
    return Math.max(0, this.expiresAt - Date.now());
  }

  get expired(): boolean {
    return this.remainingMs === 0;
  }
}

/** What ended a spill walk early: its first failed page, and whether the budget ended it. */
interface WalkFailure {
  atDeadline: boolean;
  error: unknown;
}

/** How {@link ChemblService.fetchJson} runs one request, beyond the call deadline every request draws on. */
interface JsonFetchOptions {
  /** Retries after the first attempt; `withRetry`'s default when omitted. */
  maxRetries?: number;
  /** Runs as each attempt starts, before the attempt queues. */
  onAttempt?: () => void;
  /** Queue each attempt on the spill-page limiter. */
  paced?: boolean;
  /** Replaces `ctx.signal`, for a walk that can abandon its own requests. */
  signal?: AbortSignal;
  /**
   * The request is a similarity or substructure search: a 500 naming an
   * unparseable query SMILES is the caller's input, so it is not retried and
   * fails as `invalid_structure`.
   */
  structureQuery?: boolean;
}

/**
 * Whether a sanitized {@link ChemblService.fetchJson} failure is `withRetry`
 * stopping its ladder for the call's budget: at the expiry, or before an
 * exponential backoff that would outlast what is left. Either way the attempt's
 * error is replaced by a `retry_deadline_exceeded` timeout, which
 * {@link sanitizeUpstreamError} keeps on `cause`. The second case lands while the
 * budget still has time left, so {@link CallDeadline.expired} alone misses it. A
 * `Retry-After` wait that would outlast the budget is not one: `withRetry`
 * rethrows the attempt's own error for it.
 */
function isRetryBudgetStop(error: unknown): boolean {
  const stop = error instanceof Error ? error.cause : undefined;
  return stop instanceof McpError && stop.data?.reason === 'retry_deadline_exceeded';
}

/** Raw upstream molecule record (sparse — every field may be absent). */
interface RawMolecule {
  max_phase?: string | number | null;
  molecule_chembl_id?: string;
  /** Null when ChEMBL records no hierarchy for the molecule. */
  molecule_hierarchy?: {
    active_chembl_id?: string | null;
    molecule_chembl_id?: string | null;
    parent_chembl_id?: string | null;
  } | null;
  molecule_properties?: {
    full_molformula?: string | null;
    mw_freebase?: string | null;
    alogp?: string | null;
    num_ro5_violations?: string | number | null;
    qed_weighted?: string | null;
  } | null;
  molecule_structures?: {
    canonical_smiles?: string | null;
    standard_inchi_key?: string | null;
  } | null;
  molecule_type?: string | null;
  pref_name?: string | null;
  similarity?: string | number | null;
}

/** Raw upstream activity record: exactly the fields {@link normalizeActivity} reads. */
export interface RawActivity {
  activity_comment?: string | null;
  activity_id?: number;
  assay_chembl_id?: string;
  assay_description?: string | null;
  assay_type?: string | null;
  assay_variant_accession?: string | null;
  assay_variant_mutation?: string | null;
  data_validity_comment?: string | null;
  document_chembl_id?: string | null;
  document_year?: number | string | null;
  molecule_chembl_id?: string;
  molecule_pref_name?: string | null;
  pchembl_value?: string | null;
  relation?: string | null;
  standard_relation?: string | null;
  standard_type?: string | null;
  standard_units?: string | null;
  standard_value?: string | null;
  target_chembl_id?: string;
  target_organism?: string | null;
  target_pref_name?: string | null;
  type?: string | null;
  units?: string | null;
  value?: string | null;
}

/**
 * Every key of {@link RawActivity}, checked in both directions by `satisfies`: a
 * field added to the type and left off here, or listed here and absent from the
 * type, fails the typecheck. An activity page carries ChEMBL's 47 fields unless
 * asked for fewer, so every page names these alone through `only=`
 * ({@link ChemblService.activityPageUrl}), about half the bytes of a whole page.
 * ChEMBL drops an `only=` name it does not know with HTTP 200 and no error, so a
 * field missing from the selection would read as a silent `null`.
 */
const ACTIVITY_FIELD_SET = {
  activity_comment: true,
  activity_id: true,
  assay_chembl_id: true,
  assay_description: true,
  assay_type: true,
  assay_variant_accession: true,
  assay_variant_mutation: true,
  data_validity_comment: true,
  document_chembl_id: true,
  document_year: true,
  molecule_chembl_id: true,
  molecule_pref_name: true,
  pchembl_value: true,
  relation: true,
  standard_relation: true,
  standard_type: true,
  standard_units: true,
  standard_value: true,
  target_chembl_id: true,
  target_organism: true,
  target_pref_name: true,
  type: true,
  units: true,
  value: true,
} satisfies Record<keyof RawActivity, true>;

/** The raw activity fields an activity page requests, in {@link RawActivity} order. */
export const ACTIVITY_FIELDS: readonly string[] = Object.keys(ACTIVITY_FIELD_SET);

/** One raw activity row as the flat domain {@link Activity}. Reads every field of {@link RawActivity} and no other. */
export function normalizeActivity(raw: RawActivity): Activity {
  return {
    activity_id: raw.activity_id ?? 0,
    molecule_chembl_id: raw.molecule_chembl_id ?? '',
    molecule_pref_name: toStringOrNull(raw.molecule_pref_name),
    target_chembl_id: raw.target_chembl_id ?? '',
    target_pref_name: toStringOrNull(raw.target_pref_name),
    target_organism: toStringOrNull(raw.target_organism),
    assay_chembl_id: raw.assay_chembl_id ?? '',
    assay_type: toStringOrNull(raw.assay_type),
    assay_description: toStringOrNull(raw.assay_description),
    standard_type: toStringOrNull(raw.standard_type),
    standard_relation: toStringOrNull(raw.standard_relation),
    standard_value: toNumberOrNull(raw.standard_value),
    standard_units: toStringOrNull(raw.standard_units),
    pchembl_value: toNumberOrNull(raw.pchembl_value),
    type: toStringOrNull(raw.type),
    value: toStringOrNull(raw.value),
    units: toStringOrNull(raw.units),
    relation: toStringOrNull(raw.relation),
    activity_comment: toStringOrNull(raw.activity_comment),
    data_validity_comment: toStringOrNull(raw.data_validity_comment),
    assay_variant_mutation: toStringOrNull(raw.assay_variant_mutation),
    assay_variant_accession: toStringOrNull(raw.assay_variant_accession),
    document_chembl_id: toStringOrNull(raw.document_chembl_id),
    document_year: toNumberOrNull(raw.document_year),
  };
}

/** Raw upstream target record. */
interface RawTarget {
  organism?: string | null;
  pref_name?: string | null;
  target_chembl_id?: string;
  target_components?: Array<{
    accession?: string | null;
    target_component_synonyms?: Array<{
      component_synonym?: string | null;
      syn_type?: string | null;
    }> | null;
  }> | null;
  target_type?: string | null;
}

/** Raw upstream page_meta — only `total_count` is read. */
interface RawPageMeta {
  total_count?: number;
}

/**
 * The ChEMBL upstream client. Holds the resolved config values and the spill-page
 * limiter; methods take the handler `Context` for correlated logging,
 * cancellation, and retry bindings, and an optional {@link CallDeadline} a caller
 * chaining several methods passes to keep them on one budget. Without one, each
 * method starts its own {@link CALL_DEADLINE_MS} budget at entry.
 */
export class ChemblService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxPageSize: number;
  private readonly maxConcurrentPages: number;
  /**
   * Shared by every spill walk on this service, so CHEMBL_MAX_CONCURRENT_PAGES
   * bounds the page requests in flight across concurrent calls, not per call. It
   * sets only `maxConcurrent`, so it arms no timer and needs no teardown.
   */
  private readonly pagePacer: Pacer;

  constructor(config: ServerConfig) {
    // Strip a trailing slash so URL joins are predictable.
    this.baseUrl = config.apiBaseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.requestTimeoutMs;
    this.maxPageSize = config.maxPageSize;
    this.maxConcurrentPages = config.maxConcurrentPages;
    this.pagePacer = createPacer({
      name: 'chembl-spill-pages',
      maxConcurrent: config.maxConcurrentPages,
    });
  }

  // --- URL + fetch primitives -------------------------------------------

  /**
   * Build a `.json` resource URL with Django-style query params. An array value
   * repeats its key once per element, in order — the form ChEMBL reads a
   * multi-key `order_by` from.
   */
  private buildUrl(
    resource: string,
    params: Record<string, string | number | readonly string[] | undefined>,
  ): string {
    const url = new URL(`${this.baseUrl}/${resource}.json`);
    for (const [key, raw] of Object.entries(params)) {
      if (raw === undefined || raw === '') continue;
      if (typeof raw === 'object') {
        for (const value of raw) url.searchParams.append(key, value);
      } else {
        url.searchParams.set(key, String(raw));
      }
    }
    return url.toString();
  }

  /**
   * Fetch a single JSON resource through the full retry+parse pipeline.
   *
   * Wraps the fetch so any upstream failure is re-thrown as a clean, leak-free
   * domain error ({@link sanitizeUpstreamError}). Without this catch the raw
   * framework `McpError` — carrying `statusCode`, `responseBody`,
   * and the upstream URL in its `data` — would propagate to the client on a
   * public server. This is the single chokepoint for every ChEMBL call.
   *
   * Every attempt draws on `deadline`: no request starts once it is spent, each
   * attempt's timeout is CHEMBL_REQUEST_TIMEOUT_MS or what the budget has left,
   * whichever is less, and `withRetry` stops its ladder at the expiry, or before an
   * exponential backoff that would outlast it — either surfacing as the retryable
   * `upstream_timeout`, its `retry_deadline_exceeded` cause kept for
   * {@link isRetryBudgetStop}. A `Retry-After` wait that would outlast the budget
   * rethrows the attempt's own error instead (e.g. `rate_limited`), since waiting
   * out the window the upstream named is still the caller's move. A `paced`
   * request queues on the spill-page limiter inside each attempt, so a retry
   * re-queues and the wait is charged to the budget; `signal` replaces
   * `ctx.signal` for a walk that can abandon its own requests; `onAttempt` runs as
   * each attempt starts, so a walk can time a page's final attempt; `maxRetries`
   * replaces the retry count; `structureQuery` marks a similarity or substructure
   * search, whose 500 for an unparseable query SMILES is neither retried nor
   * reported as an outage ({@link sanitizeUpstreamError}). A caller abort is
   * rethrown as the caller's reason, never sanitized into an upstream failure.
   */
  private async fetchJson<T>(
    url: string,
    operation: string,
    ctx: Context,
    deadline: CallDeadline,
    request: JsonFetchOptions = {},
  ): Promise<T> {
    /**
     * `Context extends RequestContext`, so the handler ctx is the parent directly —
     * a hand-copied field list would silently drop `sessionId` and the `extra`
     * correlation bag as the shape grows. The derived context exists only to label
     * `operation` for this fetch; the framework's log and error sinks project any
     * context down to the declared `RequestContext` fields before serializing, so
     * no handler machinery rides along.
     */
    const reqCtx = requestContextService.createRequestContext({
      operation,
      parentContext: ctx,
    });
    const send = async (signal: AbortSignal): Promise<T> => {
      const response = await fetchWithTimeout(
        url,
        Math.min(this.timeoutMs, deadline.remainingMs),
        reqCtx,
        {
          signal,
          headers: { Accept: 'application/json', 'User-Agent': 'chembl-mcp-server' },
        },
      );
      return (await response.json()) as T;
    };
    try {
      if (deadline.expired) {
        throw timeout('The call spent its upstream time budget before this request started.', {
          budgetMs: deadline.budgetMs,
        });
      }
      return await withRetry(
        ({ signal }) => {
          request.onAttempt?.();
          return request.paced ? this.pagePacer.run(send, { signal }) : send(signal);
        },
        {
          operation,
          context: reqCtx,
          // ChEMBL is generous but unspecified — be a good citizen on 429/5xx.
          baseDelayMs: 1500,
          signal: request.signal ?? ctx.signal,
          deadlineMs: deadline.remainingMs,
          ...(request.maxRetries !== undefined && { maxRetries: request.maxRetries }),
          // An unparseable query SMILES fails the same way on every attempt.
          isTransient: (error) =>
            !(request.structureQuery && isUnparseableStructure(error)) && defaultIsTransient(error),
        },
      );
    } catch (err) {
      ctx.signal.throwIfAborted();
      throw sanitizeUpstreamError(err, operation, { structureQuery: request.structureQuery });
    }
  }

  // --- Molecules ---------------------------------------------------------

  /**
   * Name / ChEMBL ID / InChIKey search, routed by the shape of the query.
   *
   * A query that IS a unique identifier ({@link EXACT_MOLECULE_IDENTIFIER}) goes
   * to {@link lookupMoleculeByIdentifier}. Everything else goes to the ChEMBL
   * Elasticsearch-backed `/molecule/search` endpoint, which matches names,
   * synonyms, and IDs in one query. Routing identifiers away from it is what
   * makes the count honest: an InChIKey there ranks its one real hit first and
   * then pads with unrelated compounds, reporting the 10000 `max_result_window`
   * as the total.
   *
   * `max_phase_min` keeps even an exact-shaped query on the fuzzy path. The
   * filter belongs to the search endpoint; the by-resource lookup is a fetch, and
   * routing a filtered query there would stake the filter on undocumented
   * behavior of that route — silently returning an unfiltered record if it ever
   * stopped applying it. Dropping a caller's filter is the failure to avoid.
   *
   * `opts.offset` is the caller's window into the match set — the tool derives it
   * from a redeemed pagination cursor. Validate it before it gets here: ChEMBL
   * answers 200 with page one for an offset it rejects rather than erroring, so a
   * bad offset would return page one labelled as some later page.
   *
   * A fuzzy-path total equal to {@link NAME_SEARCH_CEILING} is flagged
   * `totalCountCapped`, and passed through unchanged.
   */
  async searchMolecules(
    opts: SearchMoleculesOptions,
    ctx: Context,
    deadline = new CallDeadline(CALL_DEADLINE_MS),
  ): Promise<MoleculePage> {
    if (opts.maxPhaseMin === undefined && EXACT_MOLECULE_IDENTIFIER.test(opts.query)) {
      return await this.lookupMoleculeByIdentifier(opts, ctx, deadline);
    }
    const params: Record<string, string | number | undefined> = {
      q: opts.query,
      limit: opts.limit,
      offset: opts.offset ?? 0,
    };
    if (opts.maxPhaseMin !== undefined) {
      params.max_phase__gte = opts.maxPhaseMin;
    }
    const url = this.buildUrl('molecule/search', params);
    const raw = await this.fetchJson<{ molecules?: RawMolecule[]; page_meta?: RawPageMeta }>(
      url,
      'ChemblService.searchMolecules',
      ctx,
      deadline,
    );
    const items = (raw.molecules ?? []).map((m) => this.normalizeMolecule(m));
    const totalCount = raw.page_meta?.total_count ?? items.length;
    return { items, totalCount, totalCountCapped: totalCount === NAME_SEARCH_CEILING };
  }

  /**
   * Resolve a query that is itself an identifier through `/molecule/{id}.json` —
   * the by-resource lookup ChEMBL serves for a ChEMBL ID and an InChIKey alike,
   * both answering with the same single molecule object, so {@link getMolecule}
   * covers the fetch and the parse for either shape.
   *
   * A well-formed identifier ChEMBL does not hold 404s, which `fetchJson` raises
   * as a sanitized `notFound`. A search reports "nothing matched" as an empty
   * page rather than a failed call, so the miss is absorbed into that shape and
   * the tool's empty-result notice fires exactly as it does for a fuzzy search
   * with no hits. Any other failure is a real one and still propagates.
   *
   * The hit is the entire result set, so the caller's window is applied to a
   * one-row list: the record at offset 0, an empty page over a total of 1 past
   * it. That reads as an exhausted walk instead of serving the same record again
   * under a later offset — the answer a redeemed cursor cannot be misled by.
   */
  private async lookupMoleculeByIdentifier(
    opts: SearchMoleculesOptions,
    ctx: Context,
    deadline: CallDeadline,
  ): Promise<MoleculePage> {
    const offset = opts.offset ?? 0;
    try {
      const molecule = await this.getMolecule(opts.query, ctx, deadline);
      return {
        items: [molecule].slice(offset, offset + opts.limit),
        totalCount: 1,
        totalCountCapped: false,
      };
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        return { items: [], totalCount: 0, totalCountCapped: false };
      }
      throw err;
    }
  }

  /**
   * Structure search routed by mode to the matching ChEMBL endpoint:
   * `/molecule/{smiles}` (exact), `/similarity/{smiles}/{threshold}` (similarity),
   * `/substructure/{smiles}` (substructure). The SMILES is path-segment encoded.
   * `opts.offset` windows the similarity/substructure list the same way it does in
   * {@link searchMolecules}, and carries the same caller-validates constraint.
   *
   * The similarity/substructure endpoints return a `{ molecules, page_meta }`
   * list envelope. The exact endpoint (`/molecule/{smiles}`) is the by-resource
   * fetch: on a hit it returns a single molecule object at the top level (no
   * `molecules` key); on a miss it 404s (the framework classifies that as
   * NotFound). Detect the single-object shape so an exact match is not silently
   * dropped.
   *
   * A substructure total equal to {@link SUBSTRUCTURE_SEARCH_CEILING} is flagged
   * `totalCountCapped`, and passed through unchanged.
   */
  async structureSearch(
    opts: StructureSearchOptions,
    ctx: Context,
    deadline = new CallDeadline(CALL_DEADLINE_MS),
  ): Promise<MoleculePage> {
    const smiles = encodeURIComponent(opts.structure);
    let resource: string;
    if (opts.searchType === 'exact') {
      resource = `molecule/${smiles}`;
    } else if (opts.searchType === 'similarity') {
      resource = `similarity/${smiles}/${opts.similarityThreshold}`;
    } else {
      resource = `substructure/${smiles}`;
    }
    const url = this.buildUrl(resource, { limit: opts.limit, offset: opts.offset ?? 0 });
    const raw = await this.fetchJson<
      { molecules?: RawMolecule[]; page_meta?: RawPageMeta } & RawMolecule
    >(url, `ChemblService.structureSearch.${opts.searchType}`, ctx, deadline, {
      // The exact lookup answers a SMILES it cannot read with 404, not 500.
      structureQuery: opts.searchType !== 'exact',
    });

    // Exact match returns a single molecule object (top-level molecule_chembl_id),
    // not a list envelope. Wrap it so the row is surfaced.
    if (raw.molecules === undefined && raw.molecule_chembl_id !== undefined) {
      const item = this.normalizeMolecule(raw);
      return { items: [item], totalCount: 1, totalCountCapped: false };
    }

    const items = (raw.molecules ?? []).map((m) => this.normalizeMolecule(m));
    const totalCount = raw.page_meta?.total_count ?? items.length;
    return {
      items,
      totalCount,
      totalCountCapped:
        opts.searchType === 'substructure' && totalCount === SUBSTRUCTURE_SEARCH_CEILING,
    };
  }

  /** Fetch a single molecule by ChEMBL ID. */
  async getMolecule(
    id: string,
    ctx: Context,
    deadline = new CallDeadline(CALL_DEADLINE_MS),
  ): Promise<Molecule> {
    const url = this.buildUrl(`molecule/${encodeURIComponent(id)}`, {});
    const raw = await this.fetchJson<RawMolecule>(url, 'ChemblService.getMolecule', ctx, deadline);
    return this.normalizeMolecule(raw);
  }

  /** The molecule record with its first_approval year — the anchor of {@link getDrugInfo}. */
  async getMoleculeApproval(
    id: string,
    ctx: Context,
    deadline = new CallDeadline(CALL_DEADLINE_MS),
  ): Promise<Molecule & { first_approval: number | null }> {
    const url = this.buildUrl(`molecule/${encodeURIComponent(id)}`, {});
    const raw = await this.fetchJson<RawMolecule & { first_approval?: number | null }>(
      url,
      'ChemblService.getMoleculeApproval',
      ctx,
      deadline,
    );
    return { ...this.normalizeMolecule(raw), first_approval: toNumberOrNull(raw.first_approval) };
  }

  /**
   * The one place the parent rule lives ({@link Molecule.parent_chembl_id}): every
   * molecule surface and both family-keyed reads (drug info, bioactivities across
   * alternate forms) take the parent from here.
   */
  private normalizeMolecule(raw: RawMolecule): Molecule {
    const structures = raw.molecule_structures ?? {};
    const props = raw.molecule_properties ?? {};
    const moleculeChemblId = raw.molecule_chembl_id ?? '';
    const molecule: Molecule = {
      molecule_chembl_id: moleculeChemblId,
      parent_chembl_id:
        toStringOrNull(raw.molecule_hierarchy?.parent_chembl_id) ?? moleculeChemblId,
      pref_name: toStringOrNull(raw.pref_name),
      canonical_smiles: toStringOrNull(structures.canonical_smiles),
      standard_inchi_key: toStringOrNull(structures.standard_inchi_key),
      full_molformula: toStringOrNull(props.full_molformula),
      mw_freebase: toNumberOrNull(props.mw_freebase),
      alogp: toNumberOrNull(props.alogp),
      num_ro5_violations: toNumberOrNull(props.num_ro5_violations),
      qed_weighted: toNumberOrNull(props.qed_weighted),
      max_phase: toNumberOrNull(raw.max_phase),
      molecule_type: toStringOrNull(raw.molecule_type),
    };
    // Only the similarity endpoint supplies a Tanimoto percent; every other
    // search mode omits the key, so absent stays absent rather than becoming null.
    if (raw.similarity != null) {
      molecule.similarity = toNumberOrNull(raw.similarity);
    }
    return molecule;
  }

  // --- Targets -----------------------------------------------------------

  /**
   * Resolve a protein/gene/UniProt accession → ChEMBL target. Accession and
   * gene-symbol filters traverse the nested `target_components`; free-text `query`
   * matches `pref_name`. `opts.offset` windows the match set as in
   * {@link searchMolecules}, and carries the same caller-validates constraint.
   */
  async searchTargets(
    opts: SearchTargetsOptions,
    ctx: Context,
    deadline = new CallDeadline(CALL_DEADLINE_MS),
  ): Promise<Page<Target>> {
    const params: Record<string, string | number | undefined> = {
      limit: opts.limit,
      offset: opts.offset ?? 0,
    };
    if (opts.accession) params.target_components__accession = opts.accession;
    if (opts.geneSymbol) {
      params.target_components__target_component_synonyms__component_synonym__iexact =
        opts.geneSymbol;
    }
    if (opts.query) params.pref_name__icontains = opts.query;
    if (opts.organism) params.organism__iexact = opts.organism;
    if (opts.targetType) params.target_type = opts.targetType;

    const url = this.buildUrl('target', params);
    const raw = await this.fetchJson<{ targets?: RawTarget[]; page_meta?: RawPageMeta }>(
      url,
      'ChemblService.searchTargets',
      ctx,
      deadline,
    );
    const items = (raw.targets ?? []).map((t) => this.normalizeTarget(t));
    return { items, totalCount: raw.page_meta?.total_count ?? items.length };
  }

  /** Fetch a single target by ChEMBL target ID. */
  async getTarget(
    id: string,
    ctx: Context,
    deadline = new CallDeadline(CALL_DEADLINE_MS),
  ): Promise<Target> {
    const url = this.buildUrl(`target/${encodeURIComponent(id)}`, {});
    const raw = await this.fetchJson<RawTarget>(url, 'ChemblService.getTarget', ctx, deadline);
    return this.normalizeTarget(raw);
  }

  private normalizeTarget(raw: RawTarget): Target {
    const components: TargetComponent[] = (raw.target_components ?? []).map((component) => {
      const geneSymbols = (component.target_component_synonyms ?? [])
        .filter((syn) => typeof syn.syn_type === 'string' && syn.syn_type.startsWith('GENE_SYMBOL'))
        .map((syn) => toStringOrNull(syn.component_synonym))
        .filter((s): s is string => s !== null);
      return {
        accession: toStringOrNull(component.accession),
        gene_symbols: geneSymbols,
      };
    });
    return {
      target_chembl_id: raw.target_chembl_id ?? '',
      pref_name: toStringOrNull(raw.pref_name),
      target_type: toStringOrNull(raw.target_type),
      organism: toStringOrNull(raw.organism),
      components,
    };
  }

  // --- Activities (bioactivity, the flagship) ---------------------------

  /**
   * Build the shared Django-style filter params for an activity query from the
   * caller's options. The page walks ({@link activityPageUrl}) and
   * {@link countActivities} (honest total) start here; a page layers on the
   * ordering + pchembl_value presence filter, the count layers on `limit: 1`.
   */
  private activityFilterParams(
    opts: GetActivitiesOptions,
  ): Record<string, string | number | undefined> {
    const params: Record<string, string | number | undefined> = {};
    if (opts.molecule?.scope === 'form') params.molecule_chembl_id = opts.molecule.id;
    if (opts.molecule?.scope === 'family') params.parent_molecule_chembl_id = opts.molecule.id;
    if (opts.targetChemblId) params.target_chembl_id = opts.targetChemblId;
    if (opts.standardType) params.standard_type = opts.standardType;
    if (opts.pchemblValueMin !== undefined) params.pchembl_value__gte = opts.pchemblValueMin;
    if (opts.assayType) params.assay_type = opts.assayType;
    if (opts.organism) params.target_organism__iexact = opts.organism;
    /**
     * ChEMBL answers `contains`, `icontains`, `startswith`, and `regex` on the variant
     * field with HTTP 400, so a mutation matches the whole recorded string through `iexact`.
     */
    if (opts.variant?.kind === 'wild_type') params.assay_variant_mutation__isnull = 'true';
    if (opts.variant?.kind === 'mutation') {
      params.assay_variant_mutation__iexact = opts.variant.mutation;
    }
    return params;
  }

  /**
   * Count measurements matching the caller's filters via `page_meta.total_count`,
   * WITHOUT the pchembl_value presence filter {@link streamActivities} applies — so
   * the result is the honest full total (measurements with AND without a derivable
   * pchembl_value). One `limit: 1` request; only `page_meta` is read. The handler
   * reports this as `totalCount`, so the preview's potency filter never silently
   * redefines what the total represents.
   */
  async countActivities(
    opts: GetActivitiesOptions,
    ctx: Context,
    deadline = new CallDeadline(CALL_DEADLINE_MS),
  ): Promise<number> {
    const url = this.buildUrl('activity', {
      ...this.activityFilterParams(opts),
      limit: 1,
      offset: 0,
    });
    const raw = await this.fetchJson<{ page_meta?: RawPageMeta }>(
      url,
      'ChemblService.countActivities',
      ctx,
      deadline,
    );
    return raw.page_meta?.total_count ?? 0;
  }

  /**
   * The spelling ChEMBL records for `opts.standardType` under the caller's other
   * filters, matched case-insensitively — for a type the exact filter found no
   * rows for. Best effort: one `standard_type__iexact` request for one row, with no
   * retry, on a budget of its own ({@link STANDARD_TYPE_SPELLING_BUDGET_MS}, capped
   * by what `deadline` has left), so a hung lookup cannot hold an already-answered
   * zero-row call for the rest of the call's budget. Null when no case variant
   * matches, or when the request fails or its budget is spent; a caller abort
   * rethrows.
   */
  async findStandardTypeSpelling(
    opts: GetActivitiesOptions,
    ctx: Context,
    deadline = new CallDeadline(CALL_DEADLINE_MS),
  ): Promise<string | null> {
    const url = this.buildUrl('activity', {
      ...this.activityFilterParams({ ...opts, standardType: undefined }),
      standard_type__iexact: opts.standardType,
      limit: 1,
      offset: 0,
    });
    const budget = new CallDeadline(
      Math.min(STANDARD_TYPE_SPELLING_BUDGET_MS, deadline.remainingMs),
    );
    try {
      const raw = await this.fetchJson<{ activities?: RawActivity[] }>(
        url,
        'ChemblService.findStandardTypeSpelling',
        ctx,
        budget,
        { maxRetries: 0 },
      );
      return toStringOrNull(raw.activities?.[0]?.standard_type);
    } catch (error) {
      ctx.signal.throwIfAborted();
      ctx.log.debug(
        'standard_type case-variant lookup failed — keeping the plain zero-hit notice.',
        {
          reason: error instanceof McpError ? error.data?.reason : undefined,
        },
      );
      return null;
    }
  }

  /**
   * The URL of one page of an activity view: the caller's filters, the view's
   * `pchembl_value` presence filter and total order, the window
   * `[offset, offset + pageSize)`, and the {@link ACTIVITY_FIELDS} selection. A
   * function of its arguments alone, so every walk over a view requests exactly the
   * same pages whatever order it issues them in. The inline page, cursor pages,
   * and every spill page are built here; the count reads only `page_meta` and
   * selects nothing.
   */
  private activityPageUrl(opts: GetActivitiesOptions, offset: number, pageSize: number): string {
    const nullPotency = opts.potencyView === 'null_potency';
    return this.buildUrl('activity', {
      ...this.activityFilterParams(opts),
      limit: pageSize,
      offset,
      only: ACTIVITY_FIELDS.join(','),
      /**
       * Potency-ranked view: most potent first, ties broken on the unique
       * `activity_id`. ChEMBL's order inside a `-pchembl_value` tie is not stable
       * from one request to the next, so without the second key a tie group that
       * straddles a page edge repeats some rows and drops others. ChEMBL reads the
       * two keys only as a repeated param — the comma form is HTTP 400.
       * Null-potency view: every pchembl_value is null, so only the primary key
       * orders it.
       */
      order_by: nullPotency ? ['activity_id'] : ['-pchembl_value', 'activity_id'],
      /**
       * ChEMBL sorts NULLs first for a descending sort, so an unfiltered preview is
       * dominated by measurements with no derivable pchembl_value. The default view
       * excludes them so the potency ranking is meaningful; the null-potency view is
       * the explicit, opt-in way to reach exactly those excluded rows. The honest
       * full count (which spans both) is recovered separately by countActivities,
       * leaving totalCount intact either way.
       */
      pchembl_value__isnull: nullPotency ? 'true' : 'false',
    });
  }

  /**
   * One page of an activity view ({@link activityPageUrl}): its raw rows and the
   * view's `page_meta.total_count` (0 when page_meta is absent).
   */
  private async fetchActivityPage(
    opts: GetActivitiesOptions,
    offset: number,
    pageSize: number,
    ctx: Context,
    deadline: CallDeadline,
    operation: string,
    request?: JsonFetchOptions,
  ): Promise<{ rows: RawActivity[]; total: number }> {
    const raw = await this.fetchJson<{ activities?: RawActivity[]; page_meta?: RawPageMeta }>(
      this.activityPageUrl(opts, offset, pageSize),
      operation,
      ctx,
      deadline,
      request,
    );
    return { rows: raw.activities ?? [], total: raw.page_meta?.total_count ?? 0 };
  }

  /**
   * Stream bioactivity rows as an async iterable, walking the view by offset from
   * `opts.offset` (default 0) in pages of `opts.pageSize` rows (default and cap
   * `CHEMBL_MAX_PAGE_SIZE`), one page at a time, until a short page or the view's
   * `page_meta.total_count` ends it. Feeds the tool's inline page drain, which
   * pulls only the page it returns; the stream is lazy, so it advances only as far
   * as the consumer pulls. A cancellation or a spent `deadline` throws rather than
   * ending the stream early, so a partial page never passes for a whole one. The
   * DataCanvas spill walks the view with {@link spillActivities} instead.
   *
   * Each page is built by {@link activityPageUrl}, never taken from
   * `page_meta.next`: ChEMBL writes the two-key ranked order back into `next` as a
   * Python list (`order_by=['-pchembl_value', 'activity_id']`), which it then
   * answers with HTTP 400.
   *
   * `opts.potencyView` selects which side of the `pchembl_value` presence split
   * is streamed; the two views partition the match set exactly and are never
   * merged (see {@link PotencyView}). The first page's `page_meta.total_count` is
   * reported via the `onTotal` callback — this is the count of the *selected
   * view*, not the full match count; the handler sources the honest total from
   * {@link countActivities}.
   */
  async *streamActivities(
    opts: GetActivitiesOptions,
    ctx: Context,
    onTotal?: (total: number) => void,
    deadline = new CallDeadline(CALL_DEADLINE_MS),
  ): AsyncGenerator<Activity> {
    const pageSize = Math.min(opts.pageSize ?? this.maxPageSize, this.maxPageSize);
    let offset = opts.offset ?? 0;

    for (let first = true; ; first = false) {
      const { rows, total } = await this.fetchActivityPage(
        opts,
        offset,
        pageSize,
        ctx,
        deadline,
        'ChemblService.streamActivities',
      );
      if (first) onTotal?.(total);
      for (const row of rows) {
        yield normalizeActivity(row);
      }
      offset += pageSize;
      if (rows.length < pageSize || offset >= total) return;
    }
  }

  /**
   * Walk a whole view for the DataCanvas spill, in CHEMBL_MAX_PAGE_SIZE pages:
   * the first page alone (it carries the view total, reported through
   * `walk.onTotal`), then every remaining offset below both the view total and
   * `walk.maxRows`, through an ordered window of at most
   * CHEMBL_MAX_CONCURRENT_PAGES pending pages. Rows yield in offset order whatever
   * order the pages land in, and every row of a fetched page is yielded, so the
   * consumer's own row cap stays the staging bound; no page is requested at or
   * past either bound. Each page request queues on the service-wide page limiter
   * inside its retry, so concurrent spills share one in-flight ceiling.
   *
   * Every request draws on `walk.deadline`, and no page starts unless more of it is
   * left than the latest page to land took on its final attempt, queueing
   * included: a page the budget would not hold would only be abandoned at the
   * deadline, after ChEMBL had computed it. A landed page's failed attempts and
   * their backoff are left out, since a fresh page does not wait them out. Once
   * the budget would not hold another page, the walk ends after the pages already
   * in flight and calls `walk.onDeadline`. The first page that fails abandons the
   * walk's other pages, queued or in flight. When the deadline caused that
   * failure — it expired, or a page's retries stopped short of an exponential
   * backoff it would outlast — the walk ends after the contiguous prefix it has
   * yielded and calls `walk.onDeadline`, unless that is the first page, which
   * throws `upstream_timeout` because nothing was fetched. Any other failure
   * throws its sanitized error (a `Retry-After` wait the budget cannot hold
   * included), and a caller abort throws its reason, however the walk was ending.
   * A consumer that stops pulling early must call `return()` so in-flight pages
   * are released.
   */
  async *spillActivities(
    opts: GetActivitiesOptions,
    ctx: Context,
    walk: {
      deadline: CallDeadline;
      maxRows: number;
      onTotal: (total: number) => void;
      onDeadline: () => void;
    },
  ): AsyncGenerator<Activity> {
    const pageSize = this.maxPageSize;
    const abandon = new AbortController();
    const request = { paced: true, signal: AbortSignal.any([ctx.signal, abandon.signal]) };
    /** How long the latest page to land took on its final attempt, queueing included. */
    let latestPageMs = 0;
    const fetchPage = async (offset: number) => {
      let attemptedAt = Date.now();
      const page = await this.fetchActivityPage(
        opts,
        offset,
        pageSize,
        ctx,
        walk.deadline,
        'ChemblService.spillActivities',
        {
          ...request,
          onAttempt: () => {
            attemptedAt = Date.now();
          },
        },
      );
      latestPageMs = Date.now() - attemptedAt;
      return page;
    };
    const budgetHoldsAPage = () => walk.deadline.remainingMs > latestPageMs;
    const state: { failure?: WalkFailure } = {};
    /** Settles with the page's rows, or with `undefined` once it failed — never rejects. */
    const pending: Promise<RawActivity[] | undefined>[] = [];
    try {
      const first = await fetchPage(0);
      walk.onTotal(first.total);
      const end = Math.min(first.total, walk.maxRows);
      let next = pageSize;
      const refill = () => {
        while (
          !state.failure &&
          next < end &&
          pending.length < this.maxConcurrentPages &&
          budgetHoldsAPage()
        ) {
          pending.push(
            fetchPage(next).then(
              (page) => page.rows,
              (error: unknown): undefined => {
                state.failure ??= {
                  atDeadline: walk.deadline.expired || isRetryBudgetStop(error),
                  error,
                };
                abandon.abort();
              },
            ),
          );
          next += pageSize;
        }
      };

      let rows: RawActivity[] | undefined = first.rows;
      while (rows) {
        const short = rows.length < pageSize;
        if (!short) refill();
        for (const row of rows) {
          yield normalizeActivity(row);
        }
        if (short) return;
        rows = await pending.shift();
        // A failed page, or a budget that stopped dispatch with pages still to request.
        const endedShort = rows === undefined && (state.failure !== undefined || next < end);
        if (endedShort) {
          ctx.signal.throwIfAborted();
          if (state.failure && !state.failure.atDeadline) throw state.failure.error;
          walk.onDeadline();
        }
      }
    } finally {
      abandon.abort();
    }
  }

  // --- Drug pharmacology -------------------------------------------------

  /**
   * Fetch the mechanism-of-action rows recorded across a family: every form filed
   * under `parentChemblId`, each row naming the form it is recorded on. One request
   * at the configured page size — see {@link getIndications} for why that is
   * enough here.
   */
  async getMechanisms(
    parentChemblId: string,
    ctx: Context,
    deadline = new CallDeadline(CALL_DEADLINE_MS),
  ): Promise<ListPage<Mechanism>> {
    const url = this.buildUrl('mechanism', {
      parent_molecule_chembl_id: parentChemblId,
      limit: this.maxPageSize,
    });
    const raw = await this.fetchJson<{
      mechanisms?: Array<{
        molecule_chembl_id?: string | null;
        target_chembl_id?: string | null;
        mechanism_of_action?: string | null;
        action_type?: string | null;
      }>;
      page_meta?: RawPageMeta;
    }>(url, 'ChemblService.getMechanisms', ctx, deadline);
    const items = (raw.mechanisms ?? []).map((m) => ({
      molecule_chembl_id: toStringOrNull(m.molecule_chembl_id),
      target_chembl_id: toStringOrNull(m.target_chembl_id),
      mechanism_of_action: toStringOrNull(m.mechanism_of_action),
      action_type: toStringOrNull(m.action_type),
    }));
    return {
      items,
      rowCount: items.length,
      totalCount: raw.page_meta?.total_count ?? items.length,
    };
  }

  /**
   * Fetch the clinical indications recorded across a family: every form filed
   * under `parentChemblId`. A family records an indication once per form, often at
   * different phases, so rows sharing a (`mesh_id`, `efo_id`) pair merge into one
   * at the highest phase, listing each form it is recorded on at that form's own
   * highest phase — the family maximum would hand a deuterated analog its
   * parent's approvals. A row carrying neither ID has nothing to match on and
   * stays its own.
   *
   * One request at the configured page size, not a page walk: a family's
   * indication rows run to the low hundreds at the extreme (211 for metformin's,
   * the largest observed), two to three orders of magnitude under the activity
   * sets {@link streamActivities} paginates. The page size covers that whole range
   * in a single round trip, and `page_meta.total_count` rides back so a list that
   * still overflows it is reported as truncated instead of passing itself off as
   * complete.
   */
  async getIndications(
    parentChemblId: string,
    ctx: Context,
    deadline = new CallDeadline(CALL_DEADLINE_MS),
  ): Promise<ListPage<Indication>> {
    const url = this.buildUrl('drug_indication', {
      parent_molecule_chembl_id: parentChemblId,
      limit: this.maxPageSize,
    });
    const raw = await this.fetchJson<{
      drug_indications?: Array<{
        efo_id?: string | null;
        efo_term?: string | null;
        max_phase_for_ind?: string | null;
        mesh_heading?: string | null;
        mesh_id?: string | null;
        molecule_chembl_id?: string | null;
      }>;
      page_meta?: RawPageMeta;
    }>(url, 'ChemblService.getIndications', ctx, deadline);
    const rows = raw.drug_indications ?? [];
    /** The higher of two phases, an unknown phase yielding to a known one. */
    const higher = (a: number | null, b: number | null) =>
      a === null ? b : b === null ? a : Math.max(a, b);
    const byPair = new Map<string, Indication>();
    const items: Indication[] = [];
    for (const row of rows) {
      const meshId = toStringOrNull(row.mesh_id);
      const efoId = toStringOrNull(row.efo_id);
      const form = toStringOrNull(row.molecule_chembl_id);
      const phase = toNumberOrNull(row.max_phase_for_ind);
      const key = meshId === null && efoId === null ? undefined : `${meshId} ${efoId}`;
      let indication = key === undefined ? undefined : byPair.get(key);
      if (indication) {
        indication.max_phase_for_ind = higher(indication.max_phase_for_ind, phase);
      } else {
        indication = {
          mesh_id: meshId,
          mesh_heading: toStringOrNull(row.mesh_heading),
          efo_id: efoId,
          efo_term: toStringOrNull(row.efo_term),
          max_phase_for_ind: phase,
          forms: [],
        };
        if (key !== undefined) byPair.set(key, indication);
        items.push(indication);
      }
      if (form === null) continue;
      const recorded = indication.forms.find((f) => f.molecule_chembl_id === form);
      if (recorded) {
        recorded.max_phase_for_ind = higher(recorded.max_phase_for_ind, phase);
      } else {
        indication.forms.push({ molecule_chembl_id: form, max_phase_for_ind: phase });
      }
    }
    return {
      items,
      rowCount: rows.length,
      totalCount: raw.page_meta?.total_count ?? rows.length,
    };
  }

  /**
   * Resolve one settled secondary list into the three states a caller has to tell
   * apart. A rejection is a partial result, never an authoritative empty one: the
   * array stays empty, but the status says `failed` and the count stays `null` —
   * unknown, never 0, the same fidelity rule {@link toNumberOrNull} follows. The
   * sanitized reason is logged rather than discarded; it carries no upstream
   * internals ({@link sanitizeUpstreamError}) and no client-facing recovery beyond
   * "re-call to retry", which the tool's notice already states.
   *
   * A failure is classed by its sanitized code: a `Timeout` — the attempt's own
   * timeout, or the call's budget spent before, during, or between attempts — ran
   * out of time, and anything else is ChEMBL answering with an error or being
   * unreachable. The two are worded differently to the caller, since a list that
   * ran out of time was never turned away.
   *
   * The list is truncated exactly when the upstream total exceeds the rows fetched.
   * A complete list counts its own items — after deduplication, fewer than the
   * rows; a truncated one reports the upstream row total, an upper bound on them.
   */
  private settleList<T>(
    settled: PromiseSettledResult<ListPage<T>>,
    operation: string,
    ctx: Context,
  ): {
    failure: ListFailure | null;
    items: T[];
    rowCount: number | null;
    status: ListStatus;
    totalCount: number | null;
  } {
    if (settled.status === 'rejected') {
      const error = settled.reason;
      ctx.log.warning(`${operation} failed — reporting the list as failed, not empty.`, {
        reason: error instanceof McpError ? error.data : undefined,
      });
      const failure =
        error instanceof McpError && error.code === JsonRpcErrorCode.Timeout
          ? 'timeout'
          : 'upstream_error';
      return { failure, items: [], rowCount: null, status: 'failed', totalCount: null };
    }
    const { items, rowCount, totalCount } = settled.value;
    return totalCount > rowCount
      ? { failure: null, items, rowCount, status: 'truncated', totalCount }
      : { failure: null, items, rowCount, status: 'complete', totalCount: items.length };
  }

  /**
   * Compose drug pharmacology for a molecule and its family. The molecule record
   * is the anchor: its failure (e.g. 404) fails the call, and it supplies the
   * canonical ID and the family parent ({@link Molecule.parent_chembl_id}) both
   * lists are requested by, never the caller's string — ChEMBL often records a
   * drug's mechanisms and approved indications on a salt rather than the parent.
   * The lists follow concurrently through `Promise.allSettled`, so a rejected one
   * degrades to a disclosed partial result rather than tanking the call — except a
   * caller cancellation, which `allSettled` would otherwise read as two failed
   * lists in a successful result, so it is rethrown as the cancellation. Every
   * request draws on the one deadline, so the call settles inside it.
   */
  async getDrugInfo(
    moleculeChemblId: string,
    ctx: Context,
    deadline = new CallDeadline(CALL_DEADLINE_MS),
  ): Promise<DrugInfo> {
    const molecule = await this.getMoleculeApproval(moleculeChemblId, ctx, deadline);
    const parent = molecule.parent_chembl_id;
    const [mechanisms, indications] = await Promise.allSettled([
      this.getMechanisms(parent, ctx, deadline),
      this.getIndications(parent, ctx, deadline),
    ]);
    ctx.signal.throwIfAborted();

    const mechanismList = this.settleList(mechanisms, 'ChemblService.getMechanisms', ctx);
    const indicationList = this.settleList(indications, 'ChemblService.getIndications', ctx);

    return {
      molecule_chembl_id: molecule.molecule_chembl_id,
      parent_molecule_chembl_id: parent,
      pref_name: molecule.pref_name,
      max_phase: molecule.max_phase,
      first_approval: molecule.first_approval,
      mechanisms: mechanismList.items,
      mechanisms_status: mechanismList.status,
      mechanisms_total_count: mechanismList.totalCount,
      mechanisms_failure: mechanismList.failure,
      indications: indicationList.items,
      indications_status: indicationList.status,
      indications_total_count: indicationList.totalCount,
      indications_rows_fetched: indicationList.rowCount,
      indications_failure: indicationList.failure,
    };
  }

  // --- Assay -------------------------------------------------------------

  /** Fetch a single assay by ChEMBL assay ID. */
  async getAssay(
    id: string,
    ctx: Context,
    deadline = new CallDeadline(CALL_DEADLINE_MS),
  ): Promise<Assay> {
    const url = this.buildUrl(`assay/${encodeURIComponent(id)}`, {});
    const raw = await this.fetchJson<{
      assay_chembl_id?: string;
      description?: string | null;
      assay_type?: string | null;
      assay_type_description?: string | null;
      target_chembl_id?: string | null;
      assay_organism?: string | null;
      confidence_score?: number | string | null;
      confidence_description?: string | null;
    }>(url, 'ChemblService.getAssay', ctx, deadline);
    return {
      assay_chembl_id: raw.assay_chembl_id ?? id,
      description: toStringOrNull(raw.description),
      assay_type: toStringOrNull(raw.assay_type),
      assay_type_description: toStringOrNull(raw.assay_type_description),
      target_chembl_id: toStringOrNull(raw.target_chembl_id),
      organism: toStringOrNull(raw.assay_organism),
      confidence_score: toNumberOrNull(raw.confidence_score),
      confidence_description: toStringOrNull(raw.confidence_description),
    };
  }
}

// --- Init/accessor pattern ----------------------------------------------

let _service: ChemblService | undefined;

/** Construct the singleton ChemblService from config. Call in `createApp` setup(). */
export function initChemblService(config: ServerConfig): void {
  _service = new ChemblService(config);
}

/** Return the initialized ChemblService, throwing if setup() never ran. */
export function getChemblService(): ChemblService {
  if (!_service) {
    throw new Error('ChemblService not initialized — call initChemblService() in setup()');
  }
  return _service;
}
