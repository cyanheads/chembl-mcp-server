/**
 * @fileoverview Tests for ChemblService request building and error-path behavior
 * against a stubbed `fetch` (no live ChEMBL call): the Django-style URL each
 * method builds, leak-free upstream-error sanitization (the pre-public security
 * fix), the unparseable-SMILES rule (#43: only an HTTP 500 carrying ChEMBL's
 * marker on a similarity or substructure search fails once as
 * `invalid_structure`), getDrugInfo's Promise.allSettled composition (a rejected
 * mechanism or indication list degrades to a per-list `failed` state with an
 * unknown count rather than an authoritative empty array, while a failed
 * molecule fetch still tanks the call), its parent-family reads (#36: lists keyed by the parent the
 * anchor record resolves, indications deduplicated across forms), the
 * mechanism/indication page envelope and its truncation signal,
 * getAssay/getTarget normalization, empty-page handling, and the one upstream time
 * budget every request of a call draws on.
 * @module tests/services/chembl-service-fetch
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALL_DEADLINE_MS,
  CallDeadline,
  ChemblService,
  sanitizeUpstreamError,
} from '@/services/chembl/chembl-service.js';
import {
  OVERLOAD_HTML_BODY,
  SIMILARITY_UNPARSEABLE_BODY,
  SUBSTRUCTURE_UNPARSEABLE_BODY,
} from '../_chembl-error-bodies.js';
import {
  drugFamilyUpstream,
  IMATINIB,
  PRODRUG,
  RAPACURONIUM,
} from '../_fake-drug-family-upstream.js';

const config = {
  apiBaseUrl: 'https://www.ebi.ac.uk/chembl/api/data',
  requestTimeoutMs: 5000,
  maxPageSize: 1000,
  defaultLimit: 25,
  maxSpillRows: 50_000,
  maxConcurrentPages: 4,
  spillDeadlineMs: 45_000,
  dataframeDropEnabled: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ctx = () => createMockContext({ tenantId: 'default' });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Pull the request URL fetchWithTimeout was called with on its Nth call. */
function calledUrl(call = 0): string {
  const arg = fetchMock.mock.calls[call]?.[0];
  return typeof arg === 'string' ? arg : (arg as Request).url;
}

// --- Leak-free error assertions (security) ------------------------------

/**
 * Keys the framework's `fetchWithTimeout` puts in a raw upstream `McpError.data`.
 * The framework ships `McpError.data` verbatim to the client, so NONE of these
 * may survive into a client-facing error after sanitization.
 */
const LEAK_KEYS = [
  'statusCode',
  'status',
  'statusText',
  'responseBody',
  'body',
  'requestId',
  'operation',
  'errorSource',
  'url',
] as const;

/** A sentinel "upstream internal" body planted in the 404/500 responses. */
const SECRET_BODY = 'INTERNAL_STACK at /srv/chembl/internal.js:42';

/** Assert a thrown client-facing error carries no upstream internals. */
function expectLeakFree(err: unknown): asserts err is McpError {
  expect(err).toBeInstanceOf(McpError);
  const mcp = err as McpError;
  const data = mcp.data ?? {};
  for (const key of LEAK_KEYS) {
    expect(data, `data must not carry "${key}"`).not.toHaveProperty(key);
  }
  // The clean contract: a machine reason + an agent recovery hint, nothing else.
  expect(data).toHaveProperty('reason');
  expect((data as { recovery?: { hint?: string } }).recovery?.hint).toBeTruthy();
  // Neither the message nor the serialized data may echo upstream internals.
  expect(mcp.message).not.toContain(SECRET_BODY);
  expect(mcp.message).not.toContain('/srv/chembl/');
  expect(JSON.stringify(data)).not.toContain(SECRET_BODY);
}

/**
 * A non-retryable upstream rejection. A 400 sanitizes to `validationError`, which
 * sits outside `withRetry`'s transient set, so a composed list reaches its
 * terminal `failed` state on the first attempt rather than after the full backoff
 * ladder. The retryable 5xx path has its own suite below.
 */
const REJECTED_STATUS = 400;

/** Run an async call expected to throw and return the thrown value. */
async function captureThrow(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw, but it resolved');
}

describe('ChemblService — request URL construction', () => {
  it('builds the molecule/search URL with q + max_phase__gte', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ molecules: [], page_meta: { total_count: 0 } }));
    await new ChemblService(config).searchMolecules(
      { query: 'aspirin', maxPhaseMin: 4, limit: 10 },
      ctx(),
    );
    const url = calledUrl();
    expect(url).toContain('/molecule/search.json');
    expect(url).toContain('q=aspirin');
    expect(url).toContain('max_phase__gte=4');
    expect(url).toContain('limit=10');
  });

  it('routes a similarity structure search to /similarity/{smiles}/{threshold}', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ molecules: [], page_meta: { total_count: 0 } }));
    await new ChemblService(config).structureSearch(
      { structure: 'CCO', searchType: 'similarity', similarityThreshold: 80, limit: 5 },
      ctx(),
    );
    expect(calledUrl()).toContain('/similarity/CCO/80.json');
  });

  it('routes a substructure search to /substructure/{smiles} and percent-encodes the SMILES', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ molecules: [], page_meta: { total_count: 0 } }));
    await new ChemblService(config).structureSearch(
      { structure: 'c1ccccc1O', searchType: 'substructure', similarityThreshold: 70, limit: 5 },
      ctx(),
    );
    expect(calledUrl()).toContain('/substructure/c1ccccc1O.json');
  });

  it('surfaces the row when an exact search returns a single molecule object (no list envelope)', async () => {
    // The exact endpoint (/molecule/{smiles}) returns a single molecule object on
    // a hit — top-level molecule_chembl_id, no `molecules` key. Without the
    // single-object branch this was parsed as an empty list and the match dropped.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        molecule_chembl_id: 'CHEMBL25',
        pref_name: 'ASPIRIN',
        max_phase: '4.0',
        molecule_structures: { canonical_smiles: 'CC(=O)Oc1ccccc1C(=O)O' },
        molecule_properties: { mw_freebase: '180.16' },
      }),
    );
    const page = await new ChemblService(config).structureSearch(
      {
        structure: 'CC(=O)Oc1ccccc1C(=O)O',
        searchType: 'exact',
        similarityThreshold: 70,
        limit: 5,
      },
      ctx(),
    );
    expect(calledUrl()).toContain('/molecule/');
    expect(page.totalCount).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.molecule_chembl_id).toBe('CHEMBL25');
    expect(page.items[0]?.max_phase).toBe(4);
  });

  it('builds the target URL with accession + gene-symbol + organism filters', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ targets: [], page_meta: { total_count: 0 } }));
    await new ChemblService(config).searchTargets(
      { accession: 'P00533', geneSymbol: 'EGFR', organism: 'Homo sapiens', limit: 25 },
      ctx(),
    );
    const url = calledUrl();
    expect(url).toContain('/target.json');
    expect(url).toContain('target_components__accession=P00533');
    expect(url).toContain(
      'target_components__target_component_synonyms__component_synonym__iexact=EGFR',
    );
    // URLSearchParams encodes a space as "+".
    expect(url).toContain('organism__iexact=Homo+sapiens');
  });

  it('ranks the activity stream by -pchembl_value and forwards the potency filter', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ activities: [], page_meta: { total_count: 0, next: null } }),
    );
    const rows = [];
    for await (const row of new ChemblService(config).streamActivities(
      { targetChemblId: 'CHEMBL203', standardType: 'IC50', pchemblValueMin: 7 },
      ctx(),
    )) {
      rows.push(row);
    }
    const url = decodeURIComponent(calledUrl());
    expect(url).toContain('/activity.json');
    expect(url).toContain('order_by=-pchembl_value');
    expect(url).toContain('target_chembl_id=CHEMBL203');
    expect(url).toContain('standard_type=IC50');
    expect(url).toContain('pchembl_value__gte=7');
    expect(rows).toHaveLength(0);
  });
});

describe('ChemblService — upstream error sanitization (no leak)', () => {
  // 404 → NotFound is non-retryable, so these resolve without retry backoff.
  it('sanitizes a 404 from getMolecule to a clean NotFound carrying no internals', async () => {
    fetchMock.mockResolvedValue(
      new Response(SECRET_BODY, { status: 404, statusText: 'Not Found' }),
    );
    const thrown = await captureThrow(() =>
      new ChemblService(config).getMolecule('CHEMBL000', ctx()),
    );
    expectLeakFree(thrown);
    expect((thrown as McpError).code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('sanitizes a 404 from getAssay to a clean NotFound carrying no internals', async () => {
    fetchMock.mockResolvedValue(
      new Response(SECRET_BODY, { status: 404, statusText: 'Not Found' }),
    );
    const thrown = await captureThrow(() => new ChemblService(config).getAssay('CHEMBL000', ctx()));
    expectLeakFree(thrown);
    expect((thrown as McpError).code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('sanitizes a 400 from searchTargets to a clean ValidationError carrying no internals', async () => {
    fetchMock.mockResolvedValue(
      new Response(SECRET_BODY, { status: 400, statusText: 'Bad Request' }),
    );
    const thrown = await captureThrow(() =>
      new ChemblService(config).searchTargets({ accession: 'BAD', limit: 25 }, ctx()),
    );
    expectLeakFree(thrown);
    expect((thrown as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
  });

  it('sanitizes the anchor-molecule failure surfaced by getDrugInfo', async () => {
    // All three composed fetches 404; getDrugInfo re-throws the anchor failure —
    // it must already be sanitized, not the raw framework error.
    fetchMock.mockResolvedValue(
      new Response(SECRET_BODY, { status: 404, statusText: 'Not Found' }),
    );
    const thrown = await captureThrow(() =>
      new ChemblService(config).getDrugInfo('CHEMBL000', ctx()),
    );
    expectLeakFree(thrown);
    expect((thrown as McpError).code).toBe(JsonRpcErrorCode.NotFound);
  });
});

describe('sanitizeUpstreamError — code mapping (security unit)', () => {
  /** Build an McpError shaped like fetchWithTimeout's raw throw, with leaky data. */
  function rawHttpError(code: JsonRpcErrorCode, status: number): McpError {
    return new McpError(
      code,
      `Fetch failed for https://www.ebi.ac.uk/chembl/api/data/molecule/X.json?secret=k. Status: ${status}`,
      {
        requestId: 'req-internal-xyz',
        operation: 'ChemblService.getMolecule',
        statusCode: status,
        statusText: 'err',
        responseBody: SECRET_BODY,
        errorSource: 'FetchHttpError',
        url: 'https://www.ebi.ac.uk/chembl/api/data/molecule/X.json?secret=k',
      },
    );
  }

  it.each([
    [JsonRpcErrorCode.NotFound, 404, JsonRpcErrorCode.NotFound, 'not_found'],
    [JsonRpcErrorCode.InvalidParams, 400, JsonRpcErrorCode.ValidationError, 'invalid_query'],
    [JsonRpcErrorCode.Timeout, 504, JsonRpcErrorCode.Timeout, 'upstream_timeout'],
    [JsonRpcErrorCode.RateLimited, 429, JsonRpcErrorCode.RateLimited, 'rate_limited'],
    [
      JsonRpcErrorCode.ServiceUnavailable,
      503,
      JsonRpcErrorCode.ServiceUnavailable,
      'upstream_unavailable',
    ],
    [
      JsonRpcErrorCode.InternalError,
      500,
      JsonRpcErrorCode.ServiceUnavailable,
      'upstream_unavailable',
    ],
    [JsonRpcErrorCode.Forbidden, 403, JsonRpcErrorCode.ServiceUnavailable, 'upstream_unavailable'],
  ])('maps %s → clean code with no leak', (upstream, status, expectedCode, expectedReason) => {
    const raw = rawHttpError(upstream as JsonRpcErrorCode, status as number);
    const clean = sanitizeUpstreamError(raw, 'ChemblService.getMolecule');
    expect(clean.code).toBe(expectedCode);
    expect((clean.data as { reason?: string }).reason).toBe(expectedReason);
    expectLeakFree(clean);
    // The raw error is kept as `cause` (server logs only), never serialized out.
    expect(clean.cause).toBe(raw);
    expect(JSON.stringify(clean.data)).not.toContain('secret=k');
  });

  it.each([
    ['a structure query', 500, { structureQuery: true }, 'invalid_structure'],
    ['any other request', 500, {}, 'upstream_unavailable'],
    ['a structure query answered 503', 503, { structureQuery: true }, 'upstream_unavailable'],
  ])('maps a marker 500 body on %s by its scope (#43)', (_label, status, scope, expectedReason) => {
    const body = SIMILARITY_UNPARSEABLE_BODY.slice(0, 500);
    const raw = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Fetch failed. Status: 500', {
      status,
      statusText: 'Internal Server Error',
      body,
      statusCode: status,
      responseBody: body,
    });
    const clean = sanitizeUpstreamError(raw, 'ChemblService.structureSearch.similarity', scope);
    expect((clean.data as { reason?: string }).reason).toBe(expectedReason);
    expectLeakFree(clean);
    expect(clean.cause).toBe(raw);
  });

  it('collapses a non-McpError (e.g. JSON parse failure) into a clean ServiceUnavailable', () => {
    const clean = sanitizeUpstreamError(
      new SyntaxError('Unexpected token < in JSON at position 0'),
      'ChemblService.searchMolecules',
    );
    expect(clean.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expectLeakFree(clean);
    expect(clean.message).not.toContain('Unexpected token');
  });
});

describe('ChemblService — retry classification through fetchJson', () => {
  /**
   * A 5xx is transient, so `fetchJson`'s `withRetry` boundary re-attempts it: an
   * upstream blip resolves inside one call instead of surfacing as a failure. A
   * 4xx is deterministic and fails on the first attempt — retrying it would only
   * burn the caller's latency on an answer that cannot change. The split is what
   * decides whether a composed list in `getDrugInfo` degrades immediately or
   * after the backoff ladder, so it is pinned here rather than inferred.
   */
  it('retries a transient upstream 500 and succeeds on the next attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error_message: 'boom' }, 500))
      .mockResolvedValueOnce(
        jsonResponse({
          mechanisms: [{ mechanism_of_action: 'COX inhibitor' }],
          page_meta: { total_count: 1 },
        }),
      );
    const page = await new ChemblService(config).getMechanisms('CHEMBL25', ctx());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(page.items).toHaveLength(1);
    expect(page.totalCount).toBe(1);
  });

  it('fails a deterministic 400 on the first attempt without retrying', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error_message: 'bad filter' }, 400));
    const thrown = await captureThrow(() =>
      new ChemblService(config).getMechanisms('CHEMBL25', ctx()),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectLeakFree(thrown);
    expect((thrown as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
  });
});

/**
 * An upstream that accepts the request and never answers. Like real `fetch`, the
 * request settles only when its signal aborts, rejecting with the signal's reason.
 */
function neverAnswers(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });
}

/** Drive fake timers until `promise` settles; its outcome and the virtual milliseconds it took. */
async function settleUnderFakeTimers<T>(
  promise: Promise<T>,
): Promise<{ value?: T; error?: unknown; elapsedMs: number }> {
  const startedAt = Date.now();
  let outcome: { value?: T; error?: unknown } | undefined;
  promise.then(
    (value) => {
      outcome = { value };
    },
    (error: unknown) => {
      outcome = { error };
    },
  );
  while (!outcome && Date.now() - startedAt < 300_000) {
    await vi.advanceTimersByTimeAsync(250);
  }
  return { ...outcome, elapsedMs: Date.now() - startedAt };
}

describe('ChemblService — one upstream time budget per call (#33)', () => {
  /**
   * The default per-attempt timeout. With it, four 30 s attempts and their
   * backoff held one call past two minutes, well after an MCP client gave up.
   */
  const service = () => new ChemblService({ ...config, requestTimeoutMs: 30_000 });

  /** Record when each request starts, in virtual milliseconds from now. */
  function recordStarts(impl: (input: string, init?: RequestInit) => Promise<Response>) {
    const startedAt = Date.now();
    const starts: number[] = [];
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      starts.push(Date.now() - startedAt);
      return impl(input, init);
    });
    return starts;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails a never-answering request as upstream_timeout inside the budget, short of the retry budget', async () => {
    const starts = recordStarts(neverAnswers);
    const { error, elapsedMs } = await settleUnderFakeTimers(
      service().getAssay('CHEMBL674637', ctx()),
    );
    expectLeakFree(error);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'upstream_timeout' },
    });
    expect(elapsedMs).toBeLessThan(60_000);
    // The retry budget allows four attempts; the deadline ends the ladder after two.
    expect(starts).toHaveLength(2);
    expect(Math.max(...starts)).toBeLessThan(CALL_DEADLINE_MS);
    expect(elapsedMs).toBeGreaterThanOrEqual(CALL_DEADLINE_MS);
  });

  it('fails getDrugInfo inside its one budget when the anchor stalls, requesting no list', async () => {
    /**
     * The budget is shorter than the 45 s default, so a fetch that started a budget
     * of its own would outlive this one. The lists wait on the anchor's parent, so
     * a stalled anchor leaves them unrequested.
     */
    const starts = recordStarts(neverAnswers);
    const { error, elapsedMs } = await settleUnderFakeTimers(
      service().getDrugInfo('CHEMBL25', ctx(), new CallDeadline(10_000)),
    );
    expectLeakFree(error);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'upstream_timeout' },
    });
    // One attempt: the budget ended the ladder at its first timeout.
    const paths = fetchMock.mock.calls.map((_call, i) => new URL(calledUrl(i)).pathname);
    expect(paths).toEqual(['/chembl/api/data/molecule/CHEMBL25.json']);
    expect(elapsedMs).toBeGreaterThanOrEqual(10_000);
    expect(elapsedMs).toBeLessThan(11_000);
    expect(Math.max(...starts)).toBeLessThan(10_000);
  });

  it("holds getDrugInfo's lists to the budget the anchor left, starting none past it", async () => {
    /**
     * The anchor answers after 4 s and both lists then stall: they share what is
     * left of the one 10 s budget instead of starting a budget of their own, and
     * settle as failed lists, not a failed call.
     */
    const family = drugFamilyUpstream(IMATINIB);
    const starts = recordStarts((input, init) =>
      input.includes('/molecule/')
        ? new Promise((resolve) => setTimeout(() => resolve(family(input)), 4_000))
        : neverAnswers(input, init),
    );
    const { value, elapsedMs } = await settleUnderFakeTimers(
      service().getDrugInfo('CHEMBL941', ctx(), new CallDeadline(10_000)),
    );
    expect(value).toMatchObject({
      parent_molecule_chembl_id: 'CHEMBL941',
      mechanisms_status: 'failed',
      mechanisms_failure: 'timeout',
      indications_status: 'failed',
      indications_failure: 'timeout',
    });
    const paths = fetchMock.mock.calls.map((_call, i) => new URL(calledUrl(i)).pathname);
    expect(paths).toEqual([
      '/chembl/api/data/molecule/CHEMBL941.json',
      '/chembl/api/data/mechanism.json',
      '/chembl/api/data/drug_indication.json',
    ]);
    expect(starts[1]).toBeGreaterThanOrEqual(4_000);
    expect(starts[2]).toBeGreaterThanOrEqual(4_000);
    expect(Math.max(...starts)).toBeLessThan(10_000);
    expect(elapsedMs).toBeGreaterThanOrEqual(10_000);
    expect(elapsedMs).toBeLessThan(11_000);
  });

  it("surfaces a caller abort during getDrugInfo's lists as the abort, never as failed lists", async () => {
    /**
     * The anchor answers and both lists then stall until the caller cancels. The
     * lists settle through Promise.allSettled, which would otherwise read the
     * cancellation as two failed lists in a successful result.
     */
    const family = drugFamilyUpstream(IMATINIB);
    fetchMock.mockImplementation((input: string, init?: RequestInit) =>
      input.includes('/molecule/') ? family(input) : neverAnswers(input, init),
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2_000);
    const cancelled = createMockContext({ tenantId: 'default', signal: controller.signal });
    const { value, error, elapsedMs } = await settleUnderFakeTimers(
      service().getDrugInfo('CHEMBL941', cancelled),
    );
    expect(value).toBeUndefined();
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(error).not.toBeInstanceOf(McpError);
    const paths = fetchMock.mock.calls.map((_call, i) => new URL(calledUrl(i)).pathname);
    expect(paths).toEqual([
      '/chembl/api/data/molecule/CHEMBL941.json',
      '/chembl/api/data/mechanism.json',
      '/chembl/api/data/drug_indication.json',
    ]);
    expect(elapsedMs).toBeLessThan(3_000);
  });

  it('sends nothing on a budget a chained call already spent', async () => {
    const deadline = new CallDeadline(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    const thrown = await captureThrow(() => service().getAssay('CHEMBL674637', ctx(), deadline));
    expectLeakFree(thrown);
    expect(thrown).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'upstream_timeout' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('the standard_type case-variant lookup', () => {
    const opts = { targetChemblId: 'CHEMBL203', standardType: 'ic50' };

    it('gives a never-answering lookup its own 5 s budget, one attempt, and answers null', async () => {
      const starts = recordStarts(neverAnswers);
      const { value, error, elapsedMs } = await settleUnderFakeTimers(
        service().findStandardTypeSpelling(opts, ctx()),
      );
      expect(error).toBeUndefined();
      expect(value).toBeNull();
      expect(starts).toEqual([0]);
      expect(elapsedMs).toBeGreaterThanOrEqual(5_000);
      expect(elapsedMs).toBeLessThanOrEqual(5_250);
    });

    it('caps that budget at what the call deadline has left', async () => {
      const starts = recordStarts(neverAnswers);
      const { value, elapsedMs } = await settleUnderFakeTimers(
        service().findStandardTypeSpelling(opts, ctx(), new CallDeadline(2_000)),
      );
      expect(value).toBeNull();
      expect(starts).toEqual([0]);
      expect(elapsedMs).toBeGreaterThanOrEqual(2_000);
      expect(elapsedMs).toBeLessThanOrEqual(2_250);
    });

    it('answers a fast 5xx with null on its one attempt, never retrying it', async () => {
      // The budget would hold the retry ladder's first backoffs; the lookup still makes one attempt.
      fetchMock.mockImplementation(() =>
        Promise.resolve(jsonResponse({ error_message: 'boom' }, 503)),
      );
      const { value, error } = await settleUnderFakeTimers(
        service().findStandardTypeSpelling(opts, ctx()),
      );
      expect(error).toBeUndefined();
      expect(value).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rethrows a caller abort during the lookup rather than answering null', async () => {
      fetchMock.mockImplementation(neverAnswers);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 1_000);
      const cancelled = createMockContext({ tenantId: 'default', signal: controller.signal });
      const { value, error, elapsedMs } = await settleUnderFakeTimers(
        service().findStandardTypeSpelling(opts, cancelled),
      );
      expect(value).toBeUndefined();
      expect(error).toMatchObject({ name: 'AbortError' });
      expect(error).not.toBeInstanceOf(McpError);
      expect(elapsedMs).toBeLessThan(2_000);
    });
  });

  it('still retries a fast 5xx inside the budget and returns the answer unchanged', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error_message: 'boom' }, 500))
      .mockResolvedValueOnce(jsonResponse({ error_message: 'boom' }, 503))
      .mockResolvedValueOnce(
        jsonResponse({ assay_chembl_id: 'CHEMBL674637', confidence_score: '9' }),
      );
    const { value, elapsedMs } = await settleUnderFakeTimers(
      service().getAssay('CHEMBL674637', ctx()),
    );
    expect(value).toMatchObject({ assay_chembl_id: 'CHEMBL674637', confidence_score: 9 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(elapsedMs).toBeLessThan(60_000);
  });

  it.each([
    ['mid-request', neverAnswers, 5_000],
    ['mid-backoff', () => Promise.resolve(jsonResponse({ error_message: 'boom' }, 503)), 500],
  ])(
    'surfaces a caller abort %s as the abort, never as an upstream failure',
    async (_label, impl, abortAtMs) => {
      fetchMock.mockImplementation(impl);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), abortAtMs);
      const cancelled = createMockContext({ tenantId: 'default', signal: controller.signal });
      const { error, elapsedMs } = await settleUnderFakeTimers(
        service().getAssay('CHEMBL674637', cancelled),
      );
      expect(error).toMatchObject({ name: 'AbortError' });
      expect(error).not.toBeInstanceOf(McpError);
      expect(elapsedMs).toBeLessThan(abortAtMs + 1_000);
    },
  );
});

describe('ChemblService — a query SMILES ChEMBL cannot parse (#43)', () => {
  const INVALID_STRUCTURE_HINT =
    'Check the SMILES for an atom over its valence (a carbon with five bonds), an unclosed ring-closure digit or parenthesis, or an aromatic ring that cannot be kekulized, then retry.';

  /** An HTTP 500 carrying `body` as `contentType`, a fresh Response per request. */
  const answer500 = (body: string, contentType: string) => () =>
    Promise.resolve(new Response(body, { status: 500, headers: { 'Content-Type': contentType } }));

  const structureSearch = (searchType: 'exact' | 'similarity' | 'substructure') =>
    new ChemblService(config).structureSearch(
      { structure: 'c1cccc1', searchType, similarityThreshold: 70, limit: 2 },
      ctx(),
    );

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['similarity', SIMILARITY_UNPARSEABLE_BODY],
    ['substructure', SUBSTRUCTURE_UNPARSEABLE_BODY],
  ] as const)(
    'fails a %s search on the first attempt as invalid_structure, the body withheld',
    async (searchType, body) => {
      fetchMock.mockImplementation(answer500(body, 'application/json'));
      const { error } = await settleUnderFakeTimers(structureSearch(searchType));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: 'ChEMBL could not parse the query structure.',
      });
      expect((error as McpError).data).toEqual({
        reason: 'invalid_structure',
        recovery: { hint: INVALID_STRUCTURE_HINT },
      });
      expectLeakFree(error);
      expect(JSON.stringify((error as McpError).data)).not.toContain('Traceback');
    },
  );

  it.each([
    ['the HTML error page on a similarity search', 'similarity', OVERLOAD_HTML_BODY, 'text/html'],
    [
      'JSON naming no unparseable SMILES on a substructure search',
      'substructure',
      JSON.stringify({
        error_message: "'CharField' object has no attribute 'get_related_resource'",
      }),
      'application/json',
    ],
    [
      'a marker body on the exact-structure lookup',
      'exact',
      SUBSTRUCTURE_UNPARSEABLE_BODY,
      'application/json',
    ],
  ] as const)(
    'retries %s and fails it as upstream_unavailable',
    async (_label, searchType, body, contentType) => {
      fetchMock.mockImplementation(answer500(body, contentType));
      const { error } = await settleUnderFakeTimers(structureSearch(searchType));
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expectLeakFree(error);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable' },
      });
    },
  );

  it.each<[string, () => Promise<unknown>]>([
    [
      'a target search',
      () => new ChemblService(config).searchTargets({ query: 'kinase', limit: 2 }, ctx()),
    ],
    [
      'an activity page',
      async () => {
        for await (const _row of new ChemblService(config).streamActivities(
          { targetChemblId: 'CHEMBL203' },
          ctx(),
        )) {
          // drain
        }
      },
    ],
  ])('retries a marker body on %s as an outage, like any other 500', async (_label, run) => {
    fetchMock.mockImplementation(answer500(SIMILARITY_UNPARSEABLE_BODY, 'application/json'));
    const { error } = await settleUnderFakeTimers(run());
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable' },
    });
  });

  /**
   * The rule reads the status and the body together: the marker text under any
   * status but 500 is that status's own failure, retried or not as the status
   * decides. A 500 without the marker is covered above (the HTML page and the
   * marker-free JSON); here the same marker bodies arrive under the other statuses.
   */
  it.each([
    [
      '502',
      'similarity',
      502,
      SIMILARITY_UNPARSEABLE_BODY,
      4,
      JsonRpcErrorCode.ServiceUnavailable,
      'upstream_unavailable',
    ],
    [
      '503',
      'substructure',
      503,
      SUBSTRUCTURE_UNPARSEABLE_BODY,
      4,
      JsonRpcErrorCode.ServiceUnavailable,
      'upstream_unavailable',
    ],
    [
      '504',
      'similarity',
      504,
      SIMILARITY_UNPARSEABLE_BODY,
      4,
      JsonRpcErrorCode.Timeout,
      'upstream_timeout',
    ],
    [
      '400',
      'substructure',
      400,
      SUBSTRUCTURE_UNPARSEABLE_BODY,
      1,
      JsonRpcErrorCode.ValidationError,
      'invalid_query',
    ],
    [
      '404',
      'similarity',
      404,
      SIMILARITY_UNPARSEABLE_BODY,
      1,
      JsonRpcErrorCode.NotFound,
      'not_found',
    ],
  ] as const)(
    'reads a marker body under HTTP %s on a %s search as that status, never invalid_structure',
    async (_label, searchType, status, body, attempts, code, reason) => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(body, { status, headers: { 'Content-Type': 'application/json' } }),
        ),
      );
      const { error } = await settleUnderFakeTimers(structureSearch(searchType));
      expect(fetchMock).toHaveBeenCalledTimes(attempts);
      expectLeakFree(error);
      expect(error).toMatchObject({ code, data: { reason } });
    },
  );

  it('keeps a 400 on a substructure search as invalid_query, one attempt', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error_message: 'bad query' }, 400));
    const { error } = await settleUnderFakeTimers(structureSearch('substructure'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_query' },
    });
  });

  it('keeps a 404 on an exact-structure lookup as not_found, one attempt', async () => {
    fetchMock.mockResolvedValue(new Response('Not found', { status: 404 }));
    const { error } = await settleUnderFakeTimers(structureSearch('exact'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });
});

describe('ChemblService.getAssay — normalization', () => {
  it('decodes confidence_score and assay_type, coercing a string score to number', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        assay_chembl_id: 'CHEMBL674637',
        description: 'Inhibition of EGFR',
        assay_type: 'B',
        assay_type_description: 'Binding',
        target_chembl_id: 'CHEMBL203',
        assay_organism: 'Homo sapiens',
        confidence_score: '9',
        confidence_description: 'Direct single protein target assigned',
      }),
    );
    const assay = await new ChemblService(config).getAssay('CHEMBL674637', ctx());
    expect(assay).toMatchObject({
      assay_chembl_id: 'CHEMBL674637',
      assay_type: 'B',
      assay_type_description: 'Binding',
      target_chembl_id: 'CHEMBL203',
      organism: 'Homo sapiens',
      confidence_score: 9,
    });
  });

  it('preserves absence as null on a sparse assay (no confidence, no target)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ assay_chembl_id: 'CHEMBL1' }));
    const assay = await new ChemblService(config).getAssay('CHEMBL1', ctx());
    expect(assay.confidence_score).toBeNull();
    expect(assay.target_chembl_id).toBeNull();
    expect(assay.assay_type).toBeNull();
    expect(assay.description).toBeNull();
  });
});

describe('ChemblService.getTarget — single fetch + flattening', () => {
  it('flattens components and gene symbols on a single-target fetch', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        target_chembl_id: 'CHEMBL203',
        pref_name: 'Epidermal growth factor receptor',
        target_type: 'SINGLE PROTEIN',
        organism: 'Homo sapiens',
        target_components: [
          {
            accession: 'P00533',
            target_component_synonyms: [{ component_synonym: 'EGFR', syn_type: 'GENE_SYMBOL' }],
          },
        ],
      }),
    );
    const target = await new ChemblService(config).getTarget('CHEMBL203', ctx());
    expect(target.target_chembl_id).toBe('CHEMBL203');
    expect(target.components[0]?.gene_symbols).toEqual(['EGFR']);
  });
});

describe('ChemblService.getDrugInfo — Promise.allSettled composition', () => {
  /** Gefitinib's record: ChEMBL files no other form under it. */
  const GEFITINIB = {
    molecule_chembl_id: 'CHEMBL939',
    pref_name: 'GEFITINIB',
    max_phase: '4',
    first_approval: 2003,
    molecule_hierarchy: { parent_chembl_id: 'CHEMBL939' },
  };

  it('degrades both secondary lists to an explicit failed state when they fail', async () => {
    // The molecule record answers; every list request is rejected. A fresh
    // Response per call: a shared one has its body consumed by the first read.
    fetchMock.mockImplementation((input: string) =>
      Promise.resolve(
        input.includes('/molecule/')
          ? jsonResponse(GEFITINIB)
          : jsonResponse({ error_message: 'boom' }, REJECTED_STATUS),
      ),
    );
    const info = await new ChemblService(config).getDrugInfo('CHEMBL939', ctx());
    expect(info).toMatchObject({
      molecule_chembl_id: 'CHEMBL939',
      pref_name: 'GEFITINIB',
      max_phase: 4,
      first_approval: 2003,
    });
    // A failed list degrades rather than tanking the call — but it is reported as
    // failed with an unknown count, never as an authoritative empty result.
    expect(info.mechanisms).toEqual([]);
    expect(info.indications).toEqual([]);
    expect(info.mechanisms_status).toBe('failed');
    expect(info.indications_status).toBe('failed');
    expect(info.mechanisms_total_count).toBeNull();
    expect(info.indications_total_count).toBeNull();
    // ChEMBL answered with an error, so neither failure is a timeout.
    expect(info.mechanisms_failure).toBe('upstream_error');
    expect(info.indications_failure).toBe('upstream_error');
    expect(info.indications_rows_fetched).toBeNull();
  });

  it("returns a one-form family's mechanism and indication, each naming the form it is recorded on", async () => {
    fetchMock.mockImplementation(
      drugFamilyUpstream({
        molecules: { CHEMBL939: GEFITINIB },
        mechanisms: [
          {
            molecule_chembl_id: 'CHEMBL939',
            parent_molecule_chembl_id: 'CHEMBL939',
            target_chembl_id: 'CHEMBL203',
            mechanism_of_action: 'EGFR inhibitor',
            action_type: 'INHIBITOR',
          },
        ],
        indications: [
          {
            molecule_chembl_id: 'CHEMBL939',
            parent_molecule_chembl_id: 'CHEMBL939',
            mesh_id: 'D002289',
            mesh_heading: 'Carcinoma, Non-Small-Cell Lung',
            efo_id: 'EFO:0003060',
            efo_term: 'non-small cell lung carcinoma',
            max_phase_for_ind: '4',
          },
        ],
      }),
    );
    const info = await new ChemblService(config).getDrugInfo('CHEMBL939', ctx());
    expect(info).toMatchObject({
      molecule_chembl_id: 'CHEMBL939',
      parent_molecule_chembl_id: 'CHEMBL939',
      mechanisms_status: 'complete',
      mechanisms_total_count: 1,
      indications_status: 'complete',
      indications_total_count: 1,
      indications_rows_fetched: 1,
    });
    expect(info.mechanisms).toEqual([
      {
        molecule_chembl_id: 'CHEMBL939',
        target_chembl_id: 'CHEMBL203',
        mechanism_of_action: 'EGFR inhibitor',
        action_type: 'INHIBITOR',
      },
    ]);
    expect(info.indications).toEqual([
      {
        mesh_id: 'D002289',
        mesh_heading: 'Carcinoma, Non-Small-Cell Lung',
        efo_id: 'EFO:0003060',
        efo_term: 'non-small cell lung carcinoma',
        max_phase_for_ind: 4,
        forms: [{ molecule_chembl_id: 'CHEMBL939', max_phase_for_ind: 4 }],
      },
    ]);
  });
});

describe('ChemblService.getMechanisms / getIndications — page envelope (#6)', () => {
  it('requests the full page size and carries page_meta.total_count forward', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        drug_indications: Array.from({ length: 100 }, (_, i) => ({ mesh_heading: `C${i}` })),
        page_meta: { total_count: 167 },
      }),
    );
    const page = await new ChemblService(config).getIndications('CHEMBL25', ctx());
    // The upstream row count is bounded by what `limit` asks for: at limit=100 ChEMBL
    // returns 100 of 167 rows and a page_meta.next; at the configured page size it
    // returns all 167 and next: null. Read the param rather than substring-matching
    // the URL — "limit=1000" contains "limit=100".
    expect(new URL(calledUrl()).searchParams.get('limit')).toBe(String(config.maxPageSize));
    expect(new URL(calledUrl()).searchParams.get('parent_molecule_chembl_id')).toBe('CHEMBL25');
    expect(page.items).toHaveLength(100);
    expect(page.rowCount).toBe(100);
    expect(page.totalCount).toBe(167);
  });

  it('returns a mechanism page carrying the upstream total', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        mechanisms: [{ target_chembl_id: 'CHEMBL221', mechanism_of_action: 'COX inhibitor' }],
        page_meta: { total_count: 1 },
      }),
    );
    const page = await new ChemblService(config).getMechanisms('CHEMBL25', ctx());
    expect(new URL(calledUrl()).searchParams.get('limit')).toBe(String(config.maxPageSize));
    expect(page.items).toHaveLength(1);
    expect(page.totalCount).toBe(1);
  });

  it('falls back totalCount to the row count when page_meta is absent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ mechanisms: [{ action_type: 'INHIBITOR' }] }));
    const page = await new ChemblService(config).getMechanisms('CHEMBL25', ctx());
    expect(page.totalCount).toBe(1);
  });
});

describe('ChemblService.getDrugInfo — per-list state (#6, #11)', () => {
  /** Route by URL so a retry cannot scramble a call-order queue. */
  function route(mechanisms: () => Response, indications: () => Response): void {
    fetchMock.mockImplementation((input: unknown) => {
      const url = typeof input === 'string' ? input : String((input as Request).url);
      if (url.includes('/mechanism.json')) return Promise.resolve(mechanisms());
      if (url.includes('/drug_indication.json')) return Promise.resolve(indications());
      return Promise.resolve(
        jsonResponse({ molecule_chembl_id: 'CHEMBL25', pref_name: 'ASPIRIN', max_phase: '4' }),
      );
    });
  }

  it('reports a rejected list as failed with an unknown count, not as empty', async () => {
    route(
      () => jsonResponse({ error_message: 'boom' }, REJECTED_STATUS),
      () =>
        jsonResponse({
          drug_indications: [{ mesh_heading: 'Pain' }],
          page_meta: { total_count: 1 },
        }),
    );
    const info = await new ChemblService(config).getDrugInfo('CHEMBL25', ctx());
    expect(info.mechanisms).toEqual([]);
    expect(info.mechanisms_status).toBe('failed');
    // Unknown, never 0 — the same fidelity rule the numeric coercion follows.
    expect(info.mechanisms_total_count).toBeNull();
    expect(info.mechanisms_failure).toBe('upstream_error');
    expect(info.indications_status).toBe('complete');
    expect(info.indications_total_count).toBe(1);
    expect(info.indications_failure).toBeNull();
  });

  it('marks a list truncated when the upstream total exceeds the rows returned', async () => {
    route(
      () => jsonResponse({ mechanisms: [], page_meta: { total_count: 0 } }),
      () =>
        jsonResponse({
          drug_indications: Array.from({ length: 100 }, (_, i) => ({ mesh_heading: `C${i}` })),
          page_meta: { total_count: 167 },
        }),
    );
    const info = await new ChemblService(config).getDrugInfo('CHEMBL25', ctx());
    expect(info.indications_status).toBe('truncated');
    expect(info.indications_total_count).toBe(167);
    expect(info.indications_rows_fetched).toBe(100);
    expect(info.mechanisms_status).toBe('complete');
    expect(info.mechanisms_total_count).toBe(0);
    expect(info.mechanisms_failure).toBeNull();
  });

  it('marks a list complete when the upstream total equals the rows returned', async () => {
    route(
      () =>
        jsonResponse({
          mechanisms: [{ mechanism_of_action: 'COX inhibitor' }],
          page_meta: { total_count: 1 },
        }),
      () =>
        jsonResponse({
          drug_indications: [{ mesh_heading: 'Pain' }],
          page_meta: { total_count: 1 },
        }),
    );
    const info = await new ChemblService(config).getDrugInfo('CHEMBL25', ctx());
    expect(info.mechanisms_status).toBe('complete');
    expect(info.indications_status).toBe('complete');
  });
});

describe('ChemblService.getDrugInfo — the parent family (#36)', () => {
  /** The query params of every request to `resource` (e.g. "mechanism.json"), in call order. */
  function paramsOf(resource: string): URLSearchParams[] {
    return fetchMock.mock.calls
      .map((_call, i) => new URL(calledUrl(i)))
      .filter((url) => url.pathname.endsWith(`/${resource}`))
      .map((url) => url.searchParams);
  }

  /**
   * The CML indication imatinib's fixture records on both forms, at phases 2 and 4:
   * the family's highest phase on the row, and each form's own phase in `forms`.
   */
  const CML = {
    mesh_id: 'D015464',
    mesh_heading: 'Leukemia, Myelogenous, Chronic, BCR-ABL Positive',
    efo_id: 'EFO:0000339',
    efo_term: 'chronic myelogenous leukemia',
    max_phase_for_ind: 4,
    forms: [
      { molecule_chembl_id: 'CHEMBL941', max_phase_for_ind: 2 },
      { molecule_chembl_id: 'CHEMBL1642', max_phase_for_ind: 4 },
    ],
  };

  it('queries both lists by the parent a salt resolves to, never by the salt', async () => {
    fetchMock.mockImplementation(drugFamilyUpstream(IMATINIB));
    const info = await new ChemblService(config).getDrugInfo('CHEMBL1642', ctx());

    expect(info.molecule_chembl_id).toBe('CHEMBL1642');
    expect(info.parent_molecule_chembl_id).toBe('CHEMBL941');
    expect(info.pref_name).toBe('IMATINIB MESYLATE');
    for (const params of [...paramsOf('mechanism.json'), ...paramsOf('drug_indication.json')]) {
      expect(params.get('parent_molecule_chembl_id')).toBe('CHEMBL941');
      expect(params.has('molecule_chembl_id')).toBe(false);
    }
    expect(paramsOf('mechanism.json')).toHaveLength(1);
    expect(paramsOf('drug_indication.json')).toHaveLength(1);
  });

  it('answers a parent and its salt with the same family pharmacology', async () => {
    fetchMock.mockImplementation(drugFamilyUpstream(IMATINIB));
    const service = new ChemblService(config);
    const parent = await service.getDrugInfo('CHEMBL941', ctx());
    const salt = await service.getDrugInfo('CHEMBL1642', ctx());

    expect(parent.parent_molecule_chembl_id).toBe('CHEMBL941');
    expect(salt.mechanisms).toEqual(parent.mechanisms);
    expect(salt.indications).toEqual(parent.indications);
    // The parent ID alone records no mechanism; the family records two, on the salt.
    expect(parent.mechanisms).toEqual([
      {
        molecule_chembl_id: 'CHEMBL1642',
        target_chembl_id: 'CHEMBL1862',
        mechanism_of_action: 'Tyrosine-protein kinase ABL inhibitor',
        action_type: 'INHIBITOR',
      },
      {
        molecule_chembl_id: 'CHEMBL1642',
        target_chembl_id: 'CHEMBL1936',
        mechanism_of_action: 'Stem cell growth factor receptor inhibitor',
        action_type: 'INHIBITOR',
      },
    ]);
    expect(parent.mechanisms_status).toBe('complete');
    expect(parent.mechanisms_total_count).toBe(2);
  });

  it('returns an indication recorded on two forms once, at the higher phase, naming both forms', async () => {
    fetchMock.mockImplementation(drugFamilyUpstream(IMATINIB));
    const info = await new ChemblService(config).getDrugInfo('CHEMBL941', ctx());

    expect(info.indications).toEqual([
      CML,
      {
        mesh_id: 'D046152',
        mesh_heading: 'Gastrointestinal Stromal Tumors',
        efo_id: 'EFO:0000703',
        efo_term: 'gastrointestinal stromal tumor',
        max_phase_for_ind: 4,
        forms: [{ molecule_chembl_id: 'CHEMBL1642', max_phase_for_ind: 4 }],
      },
      {
        mesh_id: 'D001249',
        mesh_heading: 'Asthma',
        efo_id: 'EFO:0000270',
        efo_term: 'asthma',
        max_phase_for_ind: 2,
        forms: [{ molecule_chembl_id: 'CHEMBL941', max_phase_for_ind: 2 }],
      },
      {
        mesh_id: null,
        mesh_heading: 'Unmapped condition',
        efo_id: null,
        efo_term: null,
        max_phase_for_ind: 1,
        forms: [{ molecule_chembl_id: 'CHEMBL1642', max_phase_for_ind: 1 }],
      },
    ]);
    // Five upstream rows, four distinct: complete reports the deduplicated length.
    expect(info.indications_status).toBe('complete');
    expect(info.indications_total_count).toBe(4);
    expect(info.indications_rows_fetched).toBe(5);
  });

  it('keeps the higher phase whichever form lists it first', async () => {
    const [lower, higher, ...rest] = IMATINIB.indications;
    fetchMock.mockImplementation(
      drugFamilyUpstream({ ...IMATINIB, indications: [higher!, lower!, ...rest] }),
    );
    const info = await new ChemblService(config).getDrugInfo('CHEMBL941', ctx());
    expect(info.indications[0]).toEqual({
      ...CML,
      forms: [
        { molecule_chembl_id: 'CHEMBL1642', max_phase_for_ind: 4 },
        { molecule_chembl_id: 'CHEMBL941', max_phase_for_ind: 2 },
      ],
    });
  });

  it("keeps each form's own highest phase, never handing a form the family's", async () => {
    /**
     * A sorafenib-shaped family: hepatocellular carcinoma at phase 4 on one form and
     * at phase 2 on donafenib, a deuterated analog filed under the same parent. The
     * analog is listed twice for it, at phases 1 and 2, and keeps the higher of its own.
     */
    const HCC = {
      parent_molecule_chembl_id: 'CHEMBL1336',
      mesh_id: 'D006528',
      mesh_heading: 'Carcinoma, Hepatocellular',
      efo_id: 'EFO:0000182',
      efo_term: 'hepatocellular carcinoma',
    };
    fetchMock.mockImplementation(
      drugFamilyUpstream({
        molecules: {
          CHEMBL1336: {
            molecule_chembl_id: 'CHEMBL1336',
            pref_name: 'SORAFENIB',
            max_phase: '4.0',
            molecule_hierarchy: { parent_chembl_id: 'CHEMBL1336' },
          },
        },
        mechanisms: [],
        indications: [
          { ...HCC, molecule_chembl_id: 'CHEMBL4297490', max_phase_for_ind: '1.0' },
          { ...HCC, molecule_chembl_id: 'CHEMBL1336', max_phase_for_ind: '4.0' },
          { ...HCC, molecule_chembl_id: 'CHEMBL4297490', max_phase_for_ind: '2.0' },
        ],
      }),
    );
    const info = await new ChemblService(config).getDrugInfo('CHEMBL1336', ctx());
    expect(info.indications).toHaveLength(1);
    expect(info.indications[0]).toMatchObject({
      max_phase_for_ind: 4,
      forms: [
        { molecule_chembl_id: 'CHEMBL4297490', max_phase_for_ind: 2 },
        { molecule_chembl_id: 'CHEMBL1336', max_phase_for_ind: 4 },
      ],
    });
    expect(info.indications_rows_fetched).toBe(3);
  });

  it('never merges two rows that carry neither a MeSH nor an EFO ID', async () => {
    fetchMock.mockImplementation(
      drugFamilyUpstream({
        ...IMATINIB,
        indications: [
          {
            parent_molecule_chembl_id: 'CHEMBL941',
            molecule_chembl_id: 'CHEMBL941',
            mesh_heading: 'A',
          },
          {
            parent_molecule_chembl_id: 'CHEMBL941',
            molecule_chembl_id: 'CHEMBL941',
            mesh_heading: 'B',
          },
        ],
      }),
    );
    const info = await new ChemblService(config).getDrugInfo('CHEMBL941', ctx());
    expect(info.indications.map((i) => i.mesh_heading)).toEqual(['A', 'B']);
    expect(info.indications_total_count).toBe(2);
  });

  it('merges rows that share one ID and lack the other', async () => {
    fetchMock.mockImplementation(
      drugFamilyUpstream({
        ...IMATINIB,
        indications: [
          {
            parent_molecule_chembl_id: 'CHEMBL941',
            molecule_chembl_id: 'CHEMBL941',
            mesh_id: 'D1',
            max_phase_for_ind: '3.0',
          },
          {
            parent_molecule_chembl_id: 'CHEMBL941',
            molecule_chembl_id: 'CHEMBL1642',
            mesh_id: 'D1',
            max_phase_for_ind: null,
          },
        ],
      }),
    );
    const info = await new ChemblService(config).getDrugInfo('CHEMBL941', ctx());
    expect(info.indications).toHaveLength(1);
    expect(info.indications[0]).toMatchObject({
      mesh_id: 'D1',
      efo_id: null,
      max_phase_for_ind: 3,
      forms: [
        { molecule_chembl_id: 'CHEMBL941', max_phase_for_ind: 3 },
        { molecule_chembl_id: 'CHEMBL1642', max_phase_for_ind: null },
      ],
    });
  });

  it('reports a truncated family list by its upstream row total, an upper bound (#6)', async () => {
    // A three-row page over the family's five rows: the first three dedupe to two.
    fetchMock.mockImplementation(drugFamilyUpstream(IMATINIB));
    const info = await new ChemblService({ ...config, maxPageSize: 3 }).getDrugInfo(
      'CHEMBL941',
      ctx(),
    );
    expect(info.indications).toHaveLength(2);
    expect(info.indications_status).toBe('truncated');
    expect(info.indications_total_count).toBe(5);
    // Two of the five rows were never fetched, so at most two indications are missing.
    expect(info.indications_rows_fetched).toBe(3);
  });

  it('marks a page that held every row complete even when dedup shrinks it below the total', async () => {
    fetchMock.mockImplementation(drugFamilyUpstream(IMATINIB));
    const info = await new ChemblService({ ...config, maxPageSize: 5 }).getDrugInfo(
      'CHEMBL941',
      ctx(),
    );
    expect(info.indications_status).toBe('complete');
    expect(info.indications_total_count).toBe(4);
  });

  it('takes a molecule with no recorded hierarchy as its own parent', async () => {
    fetchMock.mockImplementation(drugFamilyUpstream(RAPACURONIUM));
    const info = await new ChemblService(config).getDrugInfo('CHEMBL1201352', ctx());
    expect(info.parent_molecule_chembl_id).toBe('CHEMBL1201352');
    expect(info.mechanisms).toEqual([
      {
        molecule_chembl_id: 'CHEMBL1200549',
        target_chembl_id: 'CHEMBL2362997',
        mechanism_of_action: 'Muscle-type nicotinic acetylcholine receptor antagonist',
        action_type: 'ANTAGONIST',
      },
    ]);
    expect(info.mechanisms_status).toBe('complete');
  });

  it('follows the parent, never the active metabolite', async () => {
    fetchMock.mockImplementation(drugFamilyUpstream(PRODRUG));
    const info = await new ChemblService(config).getDrugInfo('CHEMBL900001', ctx());
    expect(info.parent_molecule_chembl_id).toBe('CHEMBL900002');
    expect(info.mechanisms.map((m) => m.mechanism_of_action)).toEqual(['Prodrug family mechanism']);
    const sent = fetchMock.mock.calls.map((_call, i) => calledUrl(i));
    expect(sent.some((url) => url.includes('CHEMBL900003'))).toBe(false);
  });

  it('keys the lists and the echoed ID off the record, not the caller string', async () => {
    fetchMock.mockImplementation(drugFamilyUpstream(IMATINIB));
    const info = await new ChemblService(config).getDrugInfo('chembl1642', ctx());
    expect(info.molecule_chembl_id).toBe('CHEMBL1642');
    expect(info.parent_molecule_chembl_id).toBe('CHEMBL941');
    expect(paramsOf('mechanism.json')[0]?.get('parent_molecule_chembl_id')).toBe('CHEMBL941');
  });

  it('requests no list until the anchor record has resolved the parent', async () => {
    const family = drugFamilyUpstream(IMATINIB);
    const order: string[] = [];
    fetchMock.mockImplementation(async (input: string) => {
      const path = new URL(input).pathname.split('/').pop() ?? '';
      order.push(`start ${path}`);
      const response = await family(input);
      order.push(`end ${path}`);
      return response;
    });
    await new ChemblService(config).getDrugInfo('CHEMBL941', ctx());
    expect(order.slice(0, 2)).toEqual(['start CHEMBL941.json', 'end CHEMBL941.json']);
    expect(order).toHaveLength(6);
  });

  it('throws the anchor failure and requests neither list', async () => {
    fetchMock.mockImplementation(drugFamilyUpstream(IMATINIB));
    const thrown = await captureThrow(() =>
      new ChemblService(config).getDrugInfo('CHEMBL000', ctx()),
    );
    expectLeakFree(thrown);
    expect(thrown).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(calledUrl()).pathname).toBe('/chembl/api/data/molecule/CHEMBL000.json');
  });
});

describe('ChemblService — empty upstream pages', () => {
  it('falls back totalCount to item length when page_meta is absent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ targets: [] }));
    const page = await new ChemblService(config).searchTargets(
      { accession: 'P99999', limit: 25 },
      ctx(),
    );
    expect(page.items).toEqual([]);
    expect(page.totalCount).toBe(0);
  });
});
