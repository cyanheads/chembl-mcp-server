/**
 * @fileoverview Behavior tests for chembl_get_drug_info: the composed happy path,
 * the degraded path (a research compound with no mechanisms/indications → a
 * notice, not an error), 404 propagation when the molecule itself is missing, and
 * the per-list disclosure contract — a capped list reported as truncated (#6) and
 * a rejected secondary endpoint reported as failed rather than as an authoritative
 * empty list (#11), asserted on both structuredContent and format().
 * @module tests/tools/chembl-get-drug-info.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblGetDrugInfo } from '@/mcp-server/tools/definitions/chembl-get-drug-info.tool.js';
import { initChemblService } from '@/services/chembl/chembl-service.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * Route the stubbed fetch by URL rather than by call order. `mockResolvedValueOnce`
 * queues are scrambled by a retry, and a single shared `Response` has its body
 * consumed by the first read — this hands every call a fresh one.
 */
function routeFetch(routes: Array<{ match: string; body: unknown; status?: number }>): void {
  fetchMock.mockImplementation((input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as Request).url);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) return Promise.reject(new Error(`unrouted fetch: ${url}`));
    return Promise.resolve(jsonResponse(route.body, route.status ?? 200));
  });
}

/** N synthetic indication rows, distinct by mesh_heading. */
function indicationRows(n: number): Array<Record<string, string>> {
  return Array.from({ length: n }, (_, i) => ({
    mesh_heading: `Condition ${i}`,
    efo_term: `condition-${i}`,
    max_phase_for_ind: '4',
  }));
}

beforeAll(() => {
  initChemblService(getServerConfig());
});

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ctx = () => createMockContext({ tenantId: 'default' });

describe('chembl_get_drug_info — composition', () => {
  it('joins approval + mechanisms + indications for an approved drug', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ pref_name: 'GEFITINIB', max_phase: '4', first_approval: 2003 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          mechanisms: [
            {
              target_chembl_id: 'CHEMBL203',
              mechanism_of_action: 'EGFR inhibitor',
              action_type: 'INHIBITOR',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          drug_indications: [
            {
              mesh_heading: 'Carcinoma, Non-Small-Cell Lung',
              efo_term: 'NSCLC',
              max_phase_for_ind: '4',
            },
          ],
        }),
      );
    const c = ctx();
    const result = await chemblGetDrugInfo.handler(
      chemblGetDrugInfo.input.parse({ molecule_chembl_id: 'CHEMBL939' }),
      c,
    );
    expect(result).toMatchObject({
      molecule_chembl_id: 'CHEMBL939',
      pref_name: 'GEFITINIB',
      max_phase: 4,
      first_approval: 2003,
    });
    expect(result.mechanisms[0]?.action_type).toBe('INHIBITOR');
    expect(result.indications[0]?.max_phase_for_ind).toBe(4);
    // No page_meta upstream — the total falls back to the rows returned, so both
    // lists are complete and nothing is disclosed.
    expect(result.mechanisms_status).toBe('complete');
    expect(result.indications_status).toBe('complete');
    expect(result.mechanisms_total_count).toBe(1);
    expect(result.indications_total_count).toBe(1);
    // No "research compound" notice when pharmacology exists.
    expect((getEnrichment(c) as { notice?: string }).notice).toBeUndefined();
  });

  it('emits a research-compound notice when no mechanisms or indications exist', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ pref_name: null, max_phase: '0', first_approval: null }),
      )
      .mockResolvedValueOnce(jsonResponse({ mechanisms: [] }))
      .mockResolvedValueOnce(jsonResponse({ drug_indications: [] }));
    const c = ctx();
    const result = await chemblGetDrugInfo.handler(
      chemblGetDrugInfo.input.parse({ molecule_chembl_id: 'CHEMBL999999' }),
      c,
    );
    expect(result.mechanisms).toEqual([]);
    expect(result.indications).toEqual([]);
    // Both lists were retrieved successfully and are genuinely empty — the only
    // state in which the research-compound reading is a claim the data supports.
    expect(result.mechanisms_status).toBe('complete');
    expect(result.indications_status).toBe('complete');
    const notice = (getEnrichment(c) as { notice?: string }).notice;
    expect(notice).toContain('CHEMBL999999');
    expect(notice).toContain('research compound');
  });

  it('propagates a 404 on the anchor molecule fetch', async () => {
    // All composed fetches 404; the handler re-throws the anchor molecule failure.
    fetchMock.mockResolvedValue(jsonResponse({ error_message: 'not found' }, 404));
    await expect(
      chemblGetDrugInfo.handler(
        chemblGetDrugInfo.input.parse({ molecule_chembl_id: 'CHEMBL000' }),
        ctx(),
      ),
    ).rejects.toThrow();
  });

  it('rejects an empty molecule_chembl_id at the schema boundary', () => {
    expect(() => chemblGetDrugInfo.input.parse({ molecule_chembl_id: '' })).toThrow();
  });
});

/** The molecule anchor every partial-result case resolves successfully. */
const APPROVAL = { pref_name: 'ASPIRIN', max_phase: '4', first_approval: 1950 };

describe('chembl_get_drug_info — truncation disclosure (#6)', () => {
  it('discloses a capped indication list instead of presenting it as complete', async () => {
    routeFetch([
      { match: '/molecule/', body: APPROVAL },
      { match: '/mechanism.json', body: { mechanisms: [], page_meta: { total_count: 0 } } },
      {
        match: '/drug_indication.json',
        body: { drug_indications: indicationRows(100), page_meta: { total_count: 167 } },
      },
    ]);
    const c = ctx();
    const result = await chemblGetDrugInfo.handler(
      chemblGetDrugInfo.input.parse({ molecule_chembl_id: 'CHEMBL25' }),
      c,
    );
    expect(result.indications).toHaveLength(100);
    expect(result.indications_total_count).toBe(167);
    expect(result.indications_status).toBe('truncated');
    // The other list is complete-and-empty, which must not read as truncated.
    expect(result.mechanisms_status).toBe('complete');
    expect(result.mechanisms_total_count).toBe(0);

    const notice = (getEnrichment(c) as { notice?: string }).notice;
    expect(notice).toContain('100 of 167 indications');
    expect(notice).toContain('67');
    // A truncated list is not evidence the molecule lacks pharmacology.
    expect(notice).not.toContain('research compound');

    // content[] carries the same disclosure as structuredContent.
    const text = (chemblGetDrugInfo.format!(result)[0] as { text: string }).text;
    expect(text).toContain('indications_status: truncated');
    expect(text).toContain('indications_total_count: 167');
    expect(text).toContain('showing 100 of 167');
  });

  it('marks a list complete when the upstream total equals the rows returned', async () => {
    routeFetch([
      { match: '/molecule/', body: APPROVAL },
      {
        match: '/mechanism.json',
        body: {
          mechanisms: [{ mechanism_of_action: 'COX inhibitor', action_type: 'INHIBITOR' }],
          page_meta: { total_count: 1 },
        },
      },
      {
        match: '/drug_indication.json',
        body: { drug_indications: indicationRows(3), page_meta: { total_count: 3 } },
      },
    ]);
    const c = ctx();
    const result = await chemblGetDrugInfo.handler(
      chemblGetDrugInfo.input.parse({ molecule_chembl_id: 'CHEMBL25' }),
      c,
    );
    expect(result.indications_status).toBe('complete');
    expect(result.indications_total_count).toBe(3);
    expect((getEnrichment(c) as { notice?: string }).notice).toBeUndefined();
  });

  it('preserves nested row nulls inside a truncated list', async () => {
    // Sparse rows nested one level below the truncated array: absence must stay
    // null while the enclosing list still reports itself as truncated.
    routeFetch([
      { match: '/molecule/', body: APPROVAL },
      { match: '/mechanism.json', body: { mechanisms: [], page_meta: { total_count: 0 } } },
      {
        match: '/drug_indication.json',
        body: {
          drug_indications: [{ mesh_heading: 'Pain' }, {}],
          page_meta: { total_count: 900 },
        },
      },
    ]);
    const result = await chemblGetDrugInfo.handler(
      chemblGetDrugInfo.input.parse({ molecule_chembl_id: 'CHEMBL25' }),
      ctx(),
    );
    expect(result.indications_status).toBe('truncated');
    expect(result.indications[0]).toEqual({
      mesh_heading: 'Pain',
      efo_term: null,
      max_phase_for_ind: null,
    });
    expect(result.indications[1]?.mesh_heading).toBeNull();
  });
});

describe('chembl_get_drug_info — partial-result disclosure (#11)', () => {
  it('discloses the failure when exactly one secondary endpoint fails', async () => {
    routeFetch([
      { match: '/molecule/', body: APPROVAL },
      { match: '/mechanism.json', body: { error_message: 'boom' }, status: 500 },
      {
        match: '/drug_indication.json',
        body: {
          drug_indications: [{ mesh_heading: 'Pain', efo_term: 'pain', max_phase_for_ind: '4' }],
          page_meta: { total_count: 1 },
        },
      },
    ]);
    const c = ctx();
    const result = await chemblGetDrugInfo.handler(
      chemblGetDrugInfo.input.parse({ molecule_chembl_id: 'CHEMBL25' }),
      c,
    );
    expect(result.mechanisms).toEqual([]);
    expect(result.mechanisms_status).toBe('failed');
    expect(result.mechanisms_total_count).toBeNull();
    // The list that succeeded is unaffected — a partial result, not a failed call.
    expect(result.indications).toHaveLength(1);
    expect(result.indications_status).toBe('complete');

    const notice = (getEnrichment(c) as { notice?: string }).notice;
    expect(notice).toContain('mechanisms');
    expect(notice).not.toContain('indications');
    expect(notice).not.toContain('research compound');

    const text = (chemblGetDrugInfo.format!(result)[0] as { text: string }).text;
    expect(text).toContain('mechanisms_status: failed');
    expect(text).toContain('not retrieved');
    expect(text).not.toContain('none recorded');
  });

  it('names both lists and never blames the molecule when both fail', async () => {
    routeFetch([
      { match: '/molecule/', body: APPROVAL },
      { match: '/mechanism.json', body: { error_message: 'boom' }, status: 500 },
      { match: '/drug_indication.json', body: { error_message: 'boom' }, status: 500 },
    ]);
    const c = ctx();
    const result = await chemblGetDrugInfo.handler(
      chemblGetDrugInfo.input.parse({ molecule_chembl_id: 'CHEMBL25' }),
      c,
    );
    expect(result.mechanisms_status).toBe('failed');
    expect(result.indications_status).toBe('failed');

    const notice = (getEnrichment(c) as { notice?: string }).notice;
    expect(notice).toContain('mechanisms and indications');
    expect(notice).toContain('CHEMBL25');
    // The pre-fix notice misattributed an upstream failure to the molecule.
    expect(notice).not.toContain('research compound');
  });

  it('discloses a failed list and a truncated list together in one notice', async () => {
    // Both conditions at once — the single notice writer must carry both, not let
    // one clobber the other.
    routeFetch([
      { match: '/molecule/', body: APPROVAL },
      { match: '/mechanism.json', body: { error_message: 'boom' }, status: 500 },
      {
        match: '/drug_indication.json',
        body: { drug_indications: indicationRows(100), page_meta: { total_count: 167 } },
      },
    ]);
    const c = ctx();
    const result = await chemblGetDrugInfo.handler(
      chemblGetDrugInfo.input.parse({ molecule_chembl_id: 'CHEMBL25' }),
      c,
    );
    expect(result.mechanisms_status).toBe('failed');
    expect(result.indications_status).toBe('truncated');

    const notice = (getEnrichment(c) as { notice?: string }).notice;
    expect(notice).toContain('Upstream fetch failed for mechanisms');
    expect(notice).toContain('100 of 167 indications');
  });
});

describe('chembl_get_drug_info format()', () => {
  it('renders mechanisms and indications when present', () => {
    const blocks = chemblGetDrugInfo.format!({
      molecule_chembl_id: 'CHEMBL939',
      pref_name: 'GEFITINIB',
      max_phase: 4,
      first_approval: 2003,
      mechanisms: [
        {
          target_chembl_id: 'CHEMBL203',
          mechanism_of_action: 'EGFR inhibitor',
          action_type: 'INHIBITOR',
        },
      ],
      mechanisms_total_count: 1,
      mechanisms_status: 'complete',
      indications: [{ mesh_heading: 'NSCLC', efo_term: 'nsclc', max_phase_for_ind: 4 }],
      indications_total_count: 1,
      indications_status: 'complete',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**CHEMBL939**');
    expect(text).toContain('First approval: 2003');
    expect(text).toContain('EGFR inhibitor');
    expect(text).toContain('NSCLC');
    expect(text).toContain('mechanisms_status: complete | mechanisms_total_count: 1');
    expect(text).toContain('indications_status: complete | indications_total_count: 1');
  });

  it('renders "— none recorded" for empty mechanism and indication lists', () => {
    const blocks = chemblGetDrugInfo.format!({
      molecule_chembl_id: 'CHEMBL999999',
      pref_name: null,
      max_phase: null,
      first_approval: null,
      mechanisms: [],
      mechanisms_total_count: 0,
      mechanisms_status: 'complete',
      indications: [],
      indications_total_count: 0,
      indications_status: 'complete',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('(unnamed)');
    expect(text).toContain('Max phase: —');
    expect((text.match(/— none recorded/g) ?? []).length).toBe(2);
  });

  it('renders a failed list as not-retrieved, never as "none recorded"', () => {
    const blocks = chemblGetDrugInfo.format!({
      molecule_chembl_id: 'CHEMBL25',
      pref_name: 'ASPIRIN',
      max_phase: 4,
      first_approval: 1950,
      mechanisms: [],
      mechanisms_total_count: null,
      mechanisms_status: 'failed',
      indications: [{ mesh_heading: 'Pain', efo_term: 'pain', max_phase_for_ind: 4 }],
      indications_total_count: 1,
      indications_status: 'complete',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('mechanisms_status: failed');
    expect(text).toContain('mechanisms_total_count: —');
    expect(text).toContain('not retrieved');
    // Exactly one list is empty, and it is the failed one — so no list may claim
    // "none recorded".
    expect(text).not.toContain('none recorded');
  });

  it('renders a truncated list with its shortfall so it cannot read as complete', () => {
    const blocks = chemblGetDrugInfo.format!({
      molecule_chembl_id: 'CHEMBL25',
      pref_name: 'ASPIRIN',
      max_phase: 4,
      first_approval: 1950,
      mechanisms: [],
      mechanisms_total_count: 0,
      mechanisms_status: 'complete',
      indications: [{ mesh_heading: 'Pain', efo_term: 'pain', max_phase_for_ind: 4 }],
      indications_total_count: 167,
      indications_status: 'truncated',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('indications_status: truncated | indications_total_count: 167');
    expect(text).toContain('showing 1 of 167');
    expect(text).toContain('166');
  });
});
