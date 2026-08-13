/**
 * @fileoverview The single upstream client for the ChEMBL REST data API. Builds
 * Django-style filtered URLs against `https://www.ebi.ac.uk/chembl/api/data`,
 * fetches `.json`, paginates `page_meta`, coerces string numerics → number/null
 * at the boundary (absent → null, never 0), and flattens nested upstream
 * structures into the flat domain types. Each method wraps its full fetch+parse
 * in `withRetry`; the activity stream yields pages for the DataCanvas spill.
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
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import type {
  Activity,
  Assay,
  DrugInfo,
  GetActivitiesOptions,
  Indication,
  ListStatus,
  Mechanism,
  Molecule,
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
 * Re-throw an upstream fetch failure as a clean, leak-free domain error.
 *
 * The framework's `fetchWithTimeout` throws a status-mapped {@link McpError} on
 * any non-2xx / timeout / network failure, and its `data` carries raw upstream
 * internals — `statusCode`, `statusText`, `responseBody` (up to 500 bytes of the
 * upstream's error page), the internal `requestId`, the `operation`, and
 * `errorSource`. The framework ships `McpError.data` verbatim to the client in
 * `structuredContent.error.data`, so letting that raw error escape leaks those
 * internals on a public server.
 *
 * This maps the framework error to a clean domain error by its `code`
 * (detected STRUCTURALLY via `err.code`, never by string-matching the drift-prone
 * message), with `data` reduced to a `reason` + recovery `hint` only. The raw
 * error rides as `cause` for server-side logs — `cause` is never serialized to
 * the client.
 *
 * Always returns an `McpError` to throw; the caller does `throw sanitize(...)`.
 */
export function sanitizeUpstreamError(err: unknown, operation: string): McpError {
  // Non-McpError shouldn't occur (the framework wraps everything fetch throws),
  // but this is a trust boundary: never let an unknown error's fields reach the
  // client. Collapse anything unexpected into a clean ServiceUnavailable.
  if (!(err instanceof McpError)) {
    return serviceUnavailable('ChEMBL request failed.', {
      reason: 'upstream_unavailable',
      recovery: { hint: 'The ChEMBL API is unreachable. Retry shortly.' },
    });
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

/** Raw upstream molecule record (sparse — every field may be absent). */
interface RawMolecule {
  max_phase?: string | number | null;
  molecule_chembl_id?: string;
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

/** Raw upstream activity record. */
interface RawActivity {
  activity_id?: number;
  assay_chembl_id?: string;
  assay_description?: string | null;
  assay_type?: string | null;
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

/** Raw upstream page_meta. */
interface RawPageMeta {
  next?: string | null;
  total_count?: number;
}

/**
 * The ChEMBL upstream client. Stateless apart from the resolved base URL +
 * timeout from config; methods take the handler `Context` for correlated
 * logging, cancellation, and retry bindings.
 */
export class ChemblService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxPageSize: number;

  constructor(config: ServerConfig) {
    // Strip a trailing slash so URL joins are predictable.
    this.baseUrl = config.apiBaseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.requestTimeoutMs;
    this.maxPageSize = config.maxPageSize;
  }

  // --- URL + fetch primitives -------------------------------------------

  /** Build a `.json` resource URL with Django-style query params. */
  private buildUrl(resource: string, params: Record<string, string | number | undefined>): string {
    const url = new URL(`${this.baseUrl}/${resource}.json`);
    for (const [key, raw] of Object.entries(params)) {
      if (raw === undefined || raw === '') continue;
      url.searchParams.set(key, String(raw));
    }
    return url.toString();
  }

  /**
   * Fetch a single JSON resource through the full retry+parse pipeline.
   *
   * Wraps the fetch so any upstream failure is re-thrown as a clean, leak-free
   * domain error ({@link sanitizeUpstreamError}). Without this catch the raw
   * framework `McpError` — carrying `statusCode`, `responseBody`, `requestId`,
   * and the internal URL in its `data` — would propagate to the client on a
   * public server. This is the single chokepoint for every ChEMBL call.
   */
  private async fetchJson<T>(url: string, operation: string, ctx: Context): Promise<T> {
    // The framework's network utils take a RequestContext (an open context bag);
    // build one from the handler Context so logs stay correlated to the request.
    const reqCtx = requestContextService.createRequestContext({
      operation,
      parentContext: { requestId: ctx.requestId, traceId: ctx.traceId, tenantId: ctx.tenantId },
    });
    try {
      return await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, this.timeoutMs, reqCtx, {
            signal: ctx.signal,
            headers: { Accept: 'application/json', 'User-Agent': 'chembl-mcp-server' },
          });
          return (await response.json()) as T;
        },
        {
          operation,
          context: reqCtx,
          // ChEMBL is generous but unspecified — be a good citizen on 429/5xx.
          baseDelayMs: 1500,
          signal: ctx.signal,
        },
      );
    } catch (err) {
      throw sanitizeUpstreamError(err, operation);
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
   */
  async searchMolecules(opts: SearchMoleculesOptions, ctx: Context): Promise<Page<Molecule>> {
    if (opts.maxPhaseMin === undefined && EXACT_MOLECULE_IDENTIFIER.test(opts.query)) {
      return await this.lookupMoleculeByIdentifier(opts, ctx);
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
    );
    const items = (raw.molecules ?? []).map((m) => this.normalizeMolecule(m));
    return { items, totalCount: raw.page_meta?.total_count ?? items.length };
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
  ): Promise<Page<Molecule>> {
    const offset = opts.offset ?? 0;
    try {
      const molecule = await this.getMolecule(opts.query, ctx);
      return { items: [molecule].slice(offset, offset + opts.limit), totalCount: 1 };
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        return { items: [], totalCount: 0 };
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
   */
  async structureSearch(opts: StructureSearchOptions, ctx: Context): Promise<Page<Molecule>> {
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
    >(url, `ChemblService.structureSearch.${opts.searchType}`, ctx);

    // Exact match returns a single molecule object (top-level molecule_chembl_id),
    // not a list envelope. Wrap it so the row is surfaced.
    if (raw.molecules === undefined && raw.molecule_chembl_id !== undefined) {
      const item = this.normalizeMolecule(raw);
      return { items: [item], totalCount: 1 };
    }

    const items = (raw.molecules ?? []).map((m) => this.normalizeMolecule(m));
    return { items, totalCount: raw.page_meta?.total_count ?? items.length };
  }

  /** Fetch a single molecule by ChEMBL ID. */
  async getMolecule(id: string, ctx: Context): Promise<Molecule> {
    const url = this.buildUrl(`molecule/${encodeURIComponent(id)}`, {});
    const raw = await this.fetchJson<RawMolecule>(url, 'ChemblService.getMolecule', ctx);
    return this.normalizeMolecule(raw);
  }

  /** Read first_approval from the molecule record (carried into DrugInfo). */
  async getMoleculeApproval(
    id: string,
    ctx: Context,
  ): Promise<{
    pref_name: string | null;
    max_phase: number | null;
    first_approval: number | null;
  }> {
    const url = this.buildUrl(`molecule/${encodeURIComponent(id)}`, {});
    const raw = await this.fetchJson<RawMolecule & { first_approval?: number | null }>(
      url,
      'ChemblService.getMoleculeApproval',
      ctx,
    );
    return {
      pref_name: toStringOrNull(raw.pref_name),
      max_phase: toNumberOrNull(raw.max_phase),
      first_approval: toNumberOrNull(raw.first_approval),
    };
  }

  private normalizeMolecule(raw: RawMolecule): Molecule {
    const structures = raw.molecule_structures ?? {};
    const props = raw.molecule_properties ?? {};
    const molecule: Molecule = {
      molecule_chembl_id: raw.molecule_chembl_id ?? '',
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
  async searchTargets(opts: SearchTargetsOptions, ctx: Context): Promise<Page<Target>> {
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
    );
    const items = (raw.targets ?? []).map((t) => this.normalizeTarget(t));
    return { items, totalCount: raw.page_meta?.total_count ?? items.length };
  }

  /** Fetch a single target by ChEMBL target ID. */
  async getTarget(id: string, ctx: Context): Promise<Target> {
    const url = this.buildUrl(`target/${encodeURIComponent(id)}`, {});
    const raw = await this.fetchJson<RawTarget>(url, 'ChemblService.getTarget', ctx);
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
   * caller's options. Both {@link streamActivities} (preview/spill) and
   * {@link countActivities} (honest total) start here; the stream layers on the
   * ordering + pchembl_value presence filter, the count layers on `limit: 1`.
   */
  private activityFilterParams(
    opts: GetActivitiesOptions,
  ): Record<string, string | number | undefined> {
    const params: Record<string, string | number | undefined> = {};
    if (opts.moleculeChemblId) params.molecule_chembl_id = opts.moleculeChemblId;
    if (opts.targetChemblId) params.target_chembl_id = opts.targetChemblId;
    if (opts.standardType) params.standard_type = opts.standardType;
    if (opts.pchemblValueMin !== undefined) params.pchembl_value__gte = opts.pchemblValueMin;
    if (opts.assayType) params.assay_type = opts.assayType;
    if (opts.organism) params.target_organism__iexact = opts.organism;
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
  async countActivities(opts: GetActivitiesOptions, ctx: Context): Promise<number> {
    const url = this.buildUrl('activity', {
      ...this.activityFilterParams(opts),
      limit: 1,
      offset: 0,
    });
    const raw = await this.fetchJson<{ page_meta?: RawPageMeta }>(
      url,
      'ChemblService.countActivities',
      ctx,
    );
    return raw.page_meta?.total_count ?? 0;
  }

  /**
   * Stream bioactivity rows as an async iterable, paginating `page_meta.next`
   * until exhausted (or the source is cancelled). Designed to feed `spillover()`:
   * the preview drain pulls only what fits the budget, and the spill drain
   * registers rows up to the caller's `caps.maxRows`. The stream itself is
   * unbounded by design — it is lazy, so it advances only as far as the consumer
   * pulls, and bounding the drain is the consumer's call.
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
  ): AsyncGenerator<Activity> {
    const nullPotency = opts.potencyView === 'null_potency';
    const params: Record<string, string | number | undefined> = {
      ...this.activityFilterParams(opts),
      limit: Math.min(this.maxPageSize, 1000),
      offset: 0,
      /**
       * Potency-ranked view: order by pchembl_value descending so the preview leads
       * with the most potent measurements. Null-potency view: every row's
       * pchembl_value is null, so that ordering is meaningless — walk the stable
       * primary key instead, which keeps the page sequence deterministic.
       */
      order_by: nullPotency ? 'activity_id' : '-pchembl_value',
      /**
       * ChEMBL sorts NULLs first for a descending sort, so an unfiltered preview is
       * dominated by measurements with no derivable pchembl_value. The default view
       * excludes them so the potency ranking is meaningful; the null-potency view is
       * the explicit, opt-in way to reach exactly those excluded rows. The honest
       * full count (which spans both) is recovered separately by countActivities,
       * leaving totalCount intact either way.
       */
      pchembl_value__isnull: nullPotency ? 'true' : 'false',
    };

    let nextUrl: string | null = this.buildUrl('activity', params);
    let reportedTotal = false;

    while (nextUrl) {
      if (ctx.signal.aborted) return;
      const raw: { activities?: RawActivity[]; page_meta?: RawPageMeta } = await this.fetchJson(
        nextUrl,
        'ChemblService.streamActivities',
        ctx,
      );
      if (!reportedTotal) {
        onTotal?.(raw.page_meta?.total_count ?? 0);
        reportedTotal = true;
      }
      for (const row of raw.activities ?? []) {
        yield this.normalizeActivity(row);
      }
      const next = raw.page_meta?.next;
      // page_meta.next is a relative path ("/chembl/api/data/activity.json?...");
      // resolve it against the configured origin so a base-URL override is honored.
      nextUrl = next ? new URL(next, this.baseUrl).toString() : null;
    }
  }

  private normalizeActivity(raw: RawActivity): Activity {
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
    };
  }

  // --- Drug pharmacology -------------------------------------------------

  /**
   * Fetch mechanism-of-action rows for a molecule. One request at the configured
   * page size — see {@link getIndications} for why that is enough here.
   */
  async getMechanisms(moleculeChemblId: string, ctx: Context): Promise<Page<Mechanism>> {
    const url = this.buildUrl('mechanism', {
      molecule_chembl_id: moleculeChemblId,
      limit: this.maxPageSize,
    });
    const raw = await this.fetchJson<{
      mechanisms?: Array<{
        target_chembl_id?: string | null;
        mechanism_of_action?: string | null;
        action_type?: string | null;
      }>;
      page_meta?: RawPageMeta;
    }>(url, 'ChemblService.getMechanisms', ctx);
    const items = (raw.mechanisms ?? []).map((m) => ({
      target_chembl_id: toStringOrNull(m.target_chembl_id),
      mechanism_of_action: toStringOrNull(m.mechanism_of_action),
      action_type: toStringOrNull(m.action_type),
    }));
    return { items, totalCount: raw.page_meta?.total_count ?? items.length };
  }

  /**
   * Fetch clinical-indication rows for a molecule.
   *
   * One request at the configured page size, not a `page_meta.next` walk: an
   * indication list runs to the low hundreds at the extreme (167 for aspirin, the
   * largest observed), two to three orders of magnitude under the activity sets
   * {@link streamActivities} paginates. The page size covers that whole range in a
   * single round trip, and `page_meta.total_count` rides back so a list that still
   * overflows it is reported as truncated instead of passing itself off as
   * complete.
   */
  async getIndications(moleculeChemblId: string, ctx: Context): Promise<Page<Indication>> {
    const url = this.buildUrl('drug_indication', {
      molecule_chembl_id: moleculeChemblId,
      limit: this.maxPageSize,
    });
    const raw = await this.fetchJson<{
      drug_indications?: Array<{
        mesh_heading?: string | null;
        efo_term?: string | null;
        max_phase_for_ind?: string | null;
      }>;
      page_meta?: RawPageMeta;
    }>(url, 'ChemblService.getIndications', ctx);
    const items = (raw.drug_indications ?? []).map((i) => ({
      mesh_heading: toStringOrNull(i.mesh_heading),
      efo_term: toStringOrNull(i.efo_term),
      max_phase_for_ind: toNumberOrNull(i.max_phase_for_ind),
    }));
    return { items, totalCount: raw.page_meta?.total_count ?? items.length };
  }

  /**
   * Resolve one settled secondary list into the three states a caller has to tell
   * apart. A rejection is a partial result, never an authoritative empty one: the
   * array stays empty, but the status says `failed` and the count stays `null` —
   * unknown, never 0, the same fidelity rule {@link toNumberOrNull} follows. The
   * sanitized reason is logged rather than discarded; it carries no upstream
   * internals ({@link sanitizeUpstreamError}) and no client-facing recovery beyond
   * "re-call to retry", which the tool's notice already states.
   */
  private settleList<T>(
    settled: PromiseSettledResult<Page<T>>,
    operation: string,
    ctx: Context,
  ): { items: T[]; status: ListStatus; totalCount: number | null } {
    if (settled.status === 'rejected') {
      ctx.log.warning(`${operation} failed — reporting the list as failed, not empty.`, {
        reason: settled.reason instanceof McpError ? settled.reason.data : undefined,
      });
      return { items: [], status: 'failed', totalCount: null };
    }
    const { items, totalCount } = settled.value;
    return { items, status: totalCount > items.length ? 'truncated' : 'complete', totalCount };
  }

  /**
   * Compose drug pharmacology from molecule approval + mechanisms + indications.
   * `Promise.allSettled` so a rejected mechanism or indication list degrades to a
   * disclosed partial result rather than tanking the whole call.
   */
  async getDrugInfo(moleculeChemblId: string, ctx: Context): Promise<DrugInfo> {
    const [approval, mechanisms, indications] = await Promise.allSettled([
      this.getMoleculeApproval(moleculeChemblId, ctx),
      this.getMechanisms(moleculeChemblId, ctx),
      this.getIndications(moleculeChemblId, ctx),
    ]);

    // The molecule fetch is the anchor — if it failed (e.g. 404), surface that.
    if (approval.status === 'rejected') throw approval.reason;

    const mechanismList = this.settleList(mechanisms, 'ChemblService.getMechanisms', ctx);
    const indicationList = this.settleList(indications, 'ChemblService.getIndications', ctx);

    return {
      molecule_chembl_id: moleculeChemblId,
      pref_name: approval.value.pref_name,
      max_phase: approval.value.max_phase,
      first_approval: approval.value.first_approval,
      mechanisms: mechanismList.items,
      mechanisms_status: mechanismList.status,
      mechanisms_total_count: mechanismList.totalCount,
      indications: indicationList.items,
      indications_status: indicationList.status,
      indications_total_count: indicationList.totalCount,
    };
  }

  // --- Assay -------------------------------------------------------------

  /** Fetch a single assay by ChEMBL assay ID. */
  async getAssay(id: string, ctx: Context): Promise<Assay> {
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
    }>(url, 'ChemblService.getAssay', ctx);
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
