/**
 * @fileoverview Behavior tests for chembl_get_drug_info: the composed happy path,
 * the degraded path (a research compound with no mechanisms/indications → a
 * notice, not an error), 404 propagation when the molecule itself is missing, and
 * the per-list disclosure contract — a capped list reported as truncated (#6) and
 * a rejected secondary endpoint reported as failed rather than as an authoritative
 * empty list (#11), and the parent-family read (#36: a salt answers with its
 * family, mechanisms and indications naming their forms, an unknown phase
 * yielding to a known one), asserted on both structuredContent and format().
 * @module tests/tools/chembl-get-drug-info.tool
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblGetDrugInfo } from '@/mcp-server/tools/definitions/chembl-get-drug-info.tool.js';
import { initChemblService } from '@/services/chembl/chembl-service.js';
import { markupNodes, parseMarkdown } from '../_commonmark.js';
import { drugFamilyUpstream, IMATINIB, RAPACURONIUM } from '../_fake-drug-family-upstream.js';

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

const ctx = () => createMockContext({ tenantId: 'default', errors: chemblGetDrugInfo.errors });

describe('chembl_get_drug_info — composition', () => {
  it('joins approval + mechanisms + indications for an approved drug', async () => {
    routeFetch([
      {
        match: '/molecule/',
        body: {
          molecule_chembl_id: 'CHEMBL939',
          pref_name: 'GEFITINIB',
          max_phase: '4',
          first_approval: 2003,
          molecule_hierarchy: { parent_chembl_id: 'CHEMBL939' },
        },
      },
      {
        match: '/mechanism.json?parent_molecule_chembl_id=CHEMBL939&',
        body: {
          mechanisms: [
            {
              target_chembl_id: 'CHEMBL203',
              mechanism_of_action: 'EGFR inhibitor',
              action_type: 'INHIBITOR',
            },
          ],
        },
      },
      {
        match: '/drug_indication.json?parent_molecule_chembl_id=CHEMBL939&',
        body: {
          drug_indications: [
            {
              mesh_heading: 'Carcinoma, Non-Small-Cell Lung',
              efo_term: 'NSCLC',
              max_phase_for_ind: '4',
            },
          ],
        },
      },
    ]);
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
    routeFetch([
      {
        match: '/molecule/',
        body: {
          molecule_chembl_id: 'CHEMBL999999',
          pref_name: null,
          max_phase: '0',
          first_approval: null,
          molecule_hierarchy: null,
        },
      },
      {
        match: '/mechanism.json?parent_molecule_chembl_id=CHEMBL999999&',
        body: { mechanisms: [] },
      },
      {
        match: '/drug_indication.json?parent_molecule_chembl_id=CHEMBL999999&',
        body: { drug_indications: [] },
      },
    ]);
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
    expect((getEnrichment(c) as { notice?: string }).notice).toBe(
      'No mechanisms or indications recorded for CHEMBL999999 (max_phase 0). It may be a research compound rather than an approved drug — use chembl_get_bioactivities to see what it hits.',
    );
  });

  it('propagates a 404 on the anchor molecule fetch as not_found, requesting neither list', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ error_message: 'not found' }, 404)),
    );
    await expect(
      chemblGetDrugInfo.handler(
        chemblGetDrugInfo.input.parse({ molecule_chembl_id: 'CHEMBL000' }),
        ctx(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'not_found' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty molecule_chembl_id at the schema boundary', () => {
    expect(() => chemblGetDrugInfo.input.parse({ molecule_chembl_id: '' })).toThrow();
  });
});

/** The molecule anchor every partial-result case resolves successfully. */
const APPROVAL = {
  molecule_chembl_id: 'CHEMBL25',
  pref_name: 'ASPIRIN',
  max_phase: '4',
  first_approval: 1950,
  molecule_hierarchy: { parent_chembl_id: 'CHEMBL25' },
};

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

    // 167 counts indication rows across the family (#36), so the shortfall is a bound.
    const notice = (getEnrichment(c) as { notice?: string }).notice;
    expect(notice).toBe(
      "Only 100 indications were returned — the single-request page cap fetched 100 of the 167 indication rows ChEMBL records for this family, so up to 67 more indications are not reachable through this tool, and each shown indication's max_phase_for_ind and forms are lower bounds: the rows not fetched can raise a phase or add a form.",
    );

    // content[] carries the same disclosure as structuredContent.
    const lines = (chemblGetDrugInfo.format!(result)[0] as { text: string }).text.split('\n');
    expect(lines).toContain(
      'indications_status: truncated | indications_total_count: 167 | indications_rows_fetched: 100 — showing 100; the page cap fetched 100 of the 167 rows, so up to 67 more were not returned, and the phases and forms shown are lower bounds',
    );
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
      mesh_id: null,
      mesh_heading: 'Pain',
      efo_id: null,
      efo_term: null,
      max_phase_for_ind: null,
      forms: [],
    });
    expect(result.indications[1]?.mesh_heading).toBeNull();
  });
});

/**
 * A NON-retryable upstream status, so a rejected list reaches its terminal
 * `failed` state on the first attempt — these tests are about the disclosure,
 * not about retry timing. The retryable 5xx path is pinned in
 * `chembl-service-fetch`.
 */
const REJECTED_STATUS = 400;

describe('chembl_get_drug_info — partial-result disclosure (#11)', () => {
  it('discloses the failure when exactly one secondary endpoint fails', async () => {
    routeFetch([
      { match: '/molecule/', body: APPROVAL },
      { match: '/mechanism.json', body: { error_message: 'boom' }, status: REJECTED_STATUS },
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

    expect(result.mechanisms_failure).toBe('upstream_error');
    expect(result.indications_failure).toBeNull();

    const notice = (getEnrichment(c) as { notice?: string }).notice;
    expect(notice).toContain('mechanisms');
    expect(notice).not.toContain('indications');
    expect(notice).not.toContain('research compound');
    expect(notice).toBe(
      'Upstream fetch failed for mechanisms — that array is empty because ChEMBL returned an error or could not be reached, not because CHEMBL25 has none recorded. Re-call chembl_get_drug_info to retry.',
    );

    const text = (chemblGetDrugInfo.format!(result)[0] as { text: string }).text;
    expect(text).toContain('mechanisms_status: failed');
    expect(text).toContain('not retrieved');
    expect(text).not.toContain('none recorded');
    expect(text.split('\n')).toEqual(
      expect.arrayContaining([
        'mechanisms_status: failed | mechanisms_total_count: — | mechanisms_failure: upstream_error',
        '— not retrieved: ChEMBL returned an error or could not be reached, so this list is unknown, not empty. Re-call to retry.',
      ]),
    );
  });

  it('says a list that ran out of time timed out, never that ChEMBL rejected it', async () => {
    /**
     * The anchor and the mechanism list answer; the indication request never does,
     * so it runs out of the call's time budget rather than being turned away.
     */
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const family = drugFamilyUpstream(IMATINIB);
    fetchMock.mockImplementation((input: string, init?: RequestInit) =>
      input.includes('/drug_indication.json')
        ? new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          })
        : family(input),
    );
    const c = ctx();
    let settled: Awaited<ReturnType<typeof chemblGetDrugInfo.handler>> | undefined;
    const pending = Promise.resolve(
      chemblGetDrugInfo.handler(
        chemblGetDrugInfo.input.parse({ molecule_chembl_id: 'CHEMBL941' }),
        c,
      ),
    );
    pending.then((value) => {
      settled = value;
    });
    for (let waited = 0; !settled && waited < 60_000; waited += 250) {
      await vi.advanceTimersByTimeAsync(250);
    }
    const result = settled;
    if (!result) throw new Error('The call did not settle inside 60 s.');

    expect(result.indications_status).toBe('failed');
    expect(result.indications_failure).toBe('timeout');
    expect(result.indications_total_count).toBeNull();
    expect(result.mechanisms_status).toBe('complete');
    expect(result.mechanisms_failure).toBeNull();

    const notice = (getEnrichment(c) as { notice?: string }).notice;
    expect(notice).toBe(
      'Upstream fetch timed out for indications — that array is empty because the request ran out of time before ChEMBL returned it, not because CHEMBL941 has none recorded. Re-call chembl_get_drug_info to retry.',
    );
    expect(notice).not.toContain('rejected');
    const lines = (chemblGetDrugInfo.format!(result)[0] as { text: string }).text.split('\n');
    expect(lines).toEqual(
      expect.arrayContaining([
        'indications_status: failed | indications_total_count: — | indications_rows_fetched: — | indications_failure: timeout',
        '— not retrieved: the request ran out of time before ChEMBL returned the list, so this list is unknown, not empty. Re-call to retry.',
      ]),
    );
  });

  it('names both lists and never blames the molecule when both fail', async () => {
    routeFetch([
      { match: '/molecule/', body: APPROVAL },
      { match: '/mechanism.json', body: { error_message: 'boom' }, status: REJECTED_STATUS },
      { match: '/drug_indication.json', body: { error_message: 'boom' }, status: REJECTED_STATUS },
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
    expect(notice).toBe(
      'Upstream fetch failed for mechanisms and indications — those arrays are empty because ChEMBL returned an error or could not be reached, not because CHEMBL25 has none recorded. Re-call chembl_get_drug_info to retry.',
    );
  });

  it('discloses a failed list and a truncated list together in one notice', async () => {
    // Both conditions at once — the single notice writer must carry both, not let
    // one clobber the other.
    routeFetch([
      { match: '/molecule/', body: APPROVAL },
      { match: '/mechanism.json', body: { error_message: 'boom' }, status: REJECTED_STATUS },
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

    expect((getEnrichment(c) as { notice?: string }).notice).toBe(
      "Upstream fetch failed for mechanisms — that array is empty because ChEMBL returned an error or could not be reached, not because CHEMBL25 has none recorded. Re-call chembl_get_drug_info to retry. Only 100 indications were returned — the single-request page cap fetched 100 of the 167 indication rows ChEMBL records for this family, so up to 67 more indications are not reachable through this tool, and each shown indication's max_phase_for_ind and forms are lower bounds: the rows not fetched can raise a phase or add a form.",
    );
  });
});

describe('chembl_get_drug_info — the parent family (#36)', () => {
  const textLines = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .split('\n');

  it('answers a salt with its family pharmacology on both surfaces', async () => {
    fetchMock.mockImplementation(drugFamilyUpstream(IMATINIB));
    const result = await runToolContract(
      chemblGetDrugInfo,
      { molecule_chembl_id: 'CHEMBL1642' },
      { context: { tenantId: 'default' } },
    );
    expect(result.isError).toBeFalsy();
    const structured = chemblGetDrugInfo.output.parse(result.structuredContent);
    expect(structured).toMatchObject({
      molecule_chembl_id: 'CHEMBL1642',
      parent_molecule_chembl_id: 'CHEMBL941',
      mechanisms_status: 'complete',
      mechanisms_total_count: 2,
      indications_status: 'complete',
      indications_total_count: 4,
      indications_rows_fetched: 5,
      mechanisms_failure: null,
      indications_failure: null,
    });
    expect(structured.mechanisms.map((m) => m.molecule_chembl_id)).toEqual([
      'CHEMBL1642',
      'CHEMBL1642',
    ]);
    // The row carries the family's highest phase; each form keeps its own.
    expect(structured.indications[0]).toEqual({
      mesh_id: 'D015464',
      mesh_heading: 'Leukemia, Myelogenous, Chronic, BCR-ABL Positive',
      efo_id: 'EFO:0000339',
      efo_term: 'chronic myelogenous leukemia',
      max_phase_for_ind: 4,
      forms: [
        { molecule_chembl_id: 'CHEMBL941', max_phase_for_ind: 2 },
        { molecule_chembl_id: 'CHEMBL1642', max_phase_for_ind: 4 },
      ],
    });

    const lines = textLines(result);
    expect(lines).toContain(
      'Parent: CHEMBL941 — both lists cover the parent and its alternate forms',
    );
    expect(lines).toContain(
      '- Tyrosine-protein kinase ABL inhibitor (INHIBITOR) → target CHEMBL1862 — recorded on CHEMBL1642',
    );
    expect(lines).toContain(
      '- Leukemia, Myelogenous, Chronic, BCR-ABL Positive [MeSH D015464] / EFO: chronic myelogenous leukemia [EFO:0000339] (max phase 4) — recorded on CHEMBL941 (phase 2), CHEMBL1642 (phase 4)',
    );
    expect(lines).toContain(
      '- Unmapped condition [MeSH —] / EFO: — [—] (max phase 1) — recorded on CHEMBL1642 (phase 1)',
    );
    expect(lines).toContain(
      'indications_status: complete | indications_total_count: 4 | indications_rows_fetched: 5',
    );
    expect(lines).toContain('mechanisms_status: complete | mechanisms_total_count: 2');
  });

  /**
   * ChEMBL leaves `max_phase_for_ind` null on some rows. An unknown phase yields to
   * a known one wherever the two meet, on a form and on the indication alike, and
   * stays null only where no row of it names a phase.
   */
  it('merges an unknown max_phase_for_ind under a known one, on each form and the indication, on both surfaces', async () => {
    const row = (form: string, mesh_id: string, phase: string | null) => ({
      molecule_chembl_id: form,
      parent_molecule_chembl_id: 'CHEMBL941',
      mesh_id,
      mesh_heading: `Heading ${mesh_id}`,
      efo_id: `EFO:${mesh_id}`,
      efo_term: `term ${mesh_id}`,
      max_phase_for_ind: phase,
    });
    fetchMock.mockImplementation(
      drugFamilyUpstream({
        ...IMATINIB,
        indications: [
          // One form unknown, another known: the indication takes the known phase.
          row('CHEMBL941', 'D1', null),
          row('CHEMBL1642', 'D1', '3.0'),
          // One form listed twice, unknown then known, and known then unknown.
          row('CHEMBL941', 'D2', null),
          row('CHEMBL941', 'D2', '2.0'),
          row('CHEMBL1642', 'D2', '1.0'),
          row('CHEMBL1642', 'D2', null),
          // No row names a phase.
          row('CHEMBL941', 'D3', null),
          row('CHEMBL1642', 'D3', null),
        ],
      }),
    );
    const result = await runToolContract(
      chemblGetDrugInfo,
      { molecule_chembl_id: 'CHEMBL941' },
      { context: { tenantId: 'default' } },
    );
    expect(result.isError).toBeFalsy();
    const structured = chemblGetDrugInfo.output.parse(result.structuredContent);
    expect(
      structured.indications.map(({ mesh_id, max_phase_for_ind, forms }) => ({
        mesh_id,
        max_phase_for_ind,
        forms,
      })),
    ).toEqual([
      {
        mesh_id: 'D1',
        max_phase_for_ind: 3,
        forms: [
          { molecule_chembl_id: 'CHEMBL941', max_phase_for_ind: null },
          { molecule_chembl_id: 'CHEMBL1642', max_phase_for_ind: 3 },
        ],
      },
      {
        mesh_id: 'D2',
        max_phase_for_ind: 2,
        forms: [
          { molecule_chembl_id: 'CHEMBL941', max_phase_for_ind: 2 },
          { molecule_chembl_id: 'CHEMBL1642', max_phase_for_ind: 1 },
        ],
      },
      {
        mesh_id: 'D3',
        max_phase_for_ind: null,
        forms: [
          { molecule_chembl_id: 'CHEMBL941', max_phase_for_ind: null },
          { molecule_chembl_id: 'CHEMBL1642', max_phase_for_ind: null },
        ],
      },
    ]);
    expect(structured).toMatchObject({
      indications_status: 'complete',
      indications_total_count: 3,
      indications_rows_fetched: 8,
    });

    const lines = textLines(result);
    expect(lines).toContain(
      '- Heading D1 [MeSH D1] / EFO: term D1 [EFO:D1] (max phase 3) — recorded on CHEMBL941 (phase —), CHEMBL1642 (phase 3)',
    );
    expect(lines).toContain(
      '- Heading D2 [MeSH D2] / EFO: term D2 [EFO:D2] (max phase 2) — recorded on CHEMBL941 (phase 2), CHEMBL1642 (phase 1)',
    );
    expect(lines).toContain(
      '- Heading D3 [MeSH D3] / EFO: term D3 [EFO:D3] (max phase —) — recorded on CHEMBL941 (phase —), CHEMBL1642 (phase —)',
    );
  });

  it('finds the mechanism of a drug with no recorded hierarchy, with no research-compound notice', async () => {
    fetchMock.mockImplementation(drugFamilyUpstream(RAPACURONIUM));
    const c = ctx();
    const result = await chemblGetDrugInfo.handler(
      chemblGetDrugInfo.input.parse({ molecule_chembl_id: 'CHEMBL1201352' }),
      c,
    );
    expect(result.parent_molecule_chembl_id).toBe('CHEMBL1201352');
    expect(result.mechanisms).toHaveLength(1);
    expect(result.mechanisms[0]?.molecule_chembl_id).toBe('CHEMBL1200549');
    expect((getEnrichment(c) as { notice?: string }).notice).toBeUndefined();
  });

  it('discloses a capped family indication list by its row total, an upper bound', async () => {
    // A three-row page over the family's five indication rows, which dedupe to two.
    initChemblService({ ...getServerConfig(), maxPageSize: 3 });
    onTestFinished(() => initChemblService(getServerConfig()));
    fetchMock.mockImplementation(drugFamilyUpstream(IMATINIB));
    const c = ctx();
    const result = await chemblGetDrugInfo.handler(
      chemblGetDrugInfo.input.parse({ molecule_chembl_id: 'CHEMBL941' }),
      c,
    );
    expect(result.indications).toHaveLength(2);
    expect(result.indications_status).toBe('truncated');
    expect(result.indications_total_count).toBe(5);
    expect(result.indications_rows_fetched).toBe(3);
    // Three rows fetched of five: two unfetched rows can add at most two indications.
    expect((getEnrichment(c) as { notice?: string }).notice).toBe(
      "Only 2 indications were returned — the single-request page cap fetched 3 of the 5 indication rows ChEMBL records for this family, so up to 2 more indications are not reachable through this tool, and each shown indication's max_phase_for_ind and forms are lower bounds: the rows not fetched can raise a phase or add a form.",
    );
    const lines = (chemblGetDrugInfo.format!(result)[0] as { text: string }).text.split('\n');
    expect(lines).toContain(
      'indications_status: truncated | indications_total_count: 5 | indications_rows_fetched: 3 — showing 2; the page cap fetched 3 of the 5 rows, so up to 2 more were not returned, and the phases and forms shown are lower bounds',
    );
  });
});

describe('chembl_get_drug_info — input normalization (#41)', () => {
  const firstPath = () => new URL(String(fetchMock.mock.calls[0]?.[0])).pathname;
  const run = (molecule_chembl_id: string, c = ctx()) =>
    chemblGetDrugInfo.handler(chemblGetDrugInfo.input.parse({ molecule_chembl_id }), c);

  it('answers a lowercase or padded ID with the canonical record and its family pharmacology', async () => {
    fetchMock.mockImplementation(drugFamilyUpstream(IMATINIB));
    const canonical = await run('CHEMBL1642');
    for (const raw of ['chembl1642', '  CHEMBL1642  ']) {
      fetchMock.mockClear();
      const c = ctx();
      const result = await run(raw, c);
      expect(firstPath()).toBe('/chembl/api/data/molecule/CHEMBL1642.json');
      expect(result).toEqual(canonical);
      expect(result.molecule_chembl_id).toBe('CHEMBL1642');
      expect(result.mechanisms).toHaveLength(2);
      expect((getEnrichment(c) as { notice?: string }).notice).toBeUndefined();
    }
  });

  it('sends a standard InChIKey in uppercase, the only case the record lookup matches', async () => {
    const imatinib = IMATINIB.molecules.CHEMBL941 as Record<string, unknown>;
    fetchMock.mockImplementation(
      drugFamilyUpstream({
        ...IMATINIB,
        molecules: { ...IMATINIB.molecules, 'KTUFNOKKBVMGRW-UHFFFAOYSA-N': imatinib },
      }),
    );
    const byId = await run('CHEMBL941');
    fetchMock.mockClear();
    const byKey = await run(' ktufnokkbvmgrw-uhfffaoysa-n ');
    expect(firstPath()).toBe('/chembl/api/data/molecule/KTUFNOKKBVMGRW-UHFFFAOYSA-N.json');
    expect(byKey).toEqual(byId);
  });

  it('passes any other reference through trimmed, its case untouched', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ error_message: 'Not found.' }, 404)),
    );
    await expect(run(' Cc1ccccc1 ')).rejects.toMatchObject({ data: { reason: 'not_found' } });
    expect(firstPath()).toBe('/chembl/api/data/molecule/Cc1ccccc1.json');
  });

  it('rejects a blank reference at the input schema', () => {
    for (const blank of ['', '   ']) {
      expect(chemblGetDrugInfo.input.safeParse({ molecule_chembl_id: blank }).success).toBe(false);
    }
  });
});

describe('chembl_get_drug_info format()', () => {
  const PAIN = {
    mesh_id: 'D010146',
    mesh_heading: 'Pain',
    efo_id: 'EFO:0003843',
    efo_term: 'pain',
    max_phase_for_ind: 4,
    forms: [{ molecule_chembl_id: 'CHEMBL25', max_phase_for_ind: 4 }],
  };
  const MECHANISM = {
    target_chembl_id: 'CHEMBL221',
    mechanism_of_action: 'Cyclooxygenase inhibitor',
    action_type: 'INHIBITOR',
    molecule_chembl_id: 'CHEMBL25',
  };

  it("renders each form's own phase, an unknown phase as —, and no forms as —", () => {
    const blocks = chemblGetDrugInfo.format!({
      molecule_chembl_id: 'CHEMBL1336',
      parent_molecule_chembl_id: 'CHEMBL1336',
      pref_name: 'SORAFENIB',
      max_phase: 4,
      first_approval: 2005,
      mechanisms: [],
      mechanisms_total_count: 0,
      mechanisms_status: 'complete',
      mechanisms_failure: null,
      indications: [
        {
          mesh_id: 'D006528',
          mesh_heading: 'Carcinoma, Hepatocellular',
          efo_id: 'EFO:0000182',
          efo_term: 'hepatocellular carcinoma',
          max_phase_for_ind: 4,
          forms: [
            { molecule_chembl_id: 'CHEMBL1336', max_phase_for_ind: 4 },
            { molecule_chembl_id: 'CHEMBL4297490', max_phase_for_ind: 2 },
            { molecule_chembl_id: 'CHEMBL1200485', max_phase_for_ind: null },
          ],
        },
        { ...PAIN, forms: [] },
      ],
      indications_total_count: 2,
      indications_rows_fetched: 4,
      indications_status: 'complete',
      indications_failure: null,
    });
    const lines = (blocks[0] as { text: string }).text.split('\n');
    expect(lines).toContain(
      '- Carcinoma, Hepatocellular [MeSH D006528] / EFO: hepatocellular carcinoma [EFO:0000182] (max phase 4) — recorded on CHEMBL1336 (phase 4), CHEMBL4297490 (phase 2), CHEMBL1200485 (phase —)',
    );
    expect(lines).toContain(
      '- Pain [MeSH D010146] / EFO: pain [EFO:0003843] (max phase 4) — recorded on —',
    );
  });

  it('renders "— none recorded" for empty mechanism and indication lists', () => {
    const blocks = chemblGetDrugInfo.format!({
      molecule_chembl_id: 'CHEMBL999999',
      parent_molecule_chembl_id: 'CHEMBL999999',
      pref_name: null,
      max_phase: null,
      first_approval: null,
      mechanisms: [],
      mechanisms_total_count: 0,
      mechanisms_status: 'complete',
      mechanisms_failure: null,
      indications: [],
      indications_total_count: 0,
      indications_rows_fetched: 0,
      indications_status: 'complete',
      indications_failure: null,
    });
    expect((blocks[0] as { text: string }).text.split('\n')).toEqual([
      '**CHEMBL999999** — (unnamed)',
      'Max phase: — | First approval: —',
      'Parent: CHEMBL999999 — both lists cover the parent and its alternate forms',
      '',
      '### Mechanisms of action',
      'mechanisms_status: complete | mechanisms_total_count: 0',
      '— none recorded',
      '',
      '### Indications',
      'indications_status: complete | indications_total_count: 0 | indications_rows_fetched: 0',
      '— none recorded',
    ]);
  });

  it('renders a failed list as not-retrieved, never as "none recorded"', () => {
    const blocks = chemblGetDrugInfo.format!({
      molecule_chembl_id: 'CHEMBL25',
      parent_molecule_chembl_id: 'CHEMBL25',
      pref_name: 'ASPIRIN',
      max_phase: 4,
      first_approval: 1950,
      mechanisms: [],
      mechanisms_total_count: null,
      mechanisms_status: 'failed',
      mechanisms_failure: 'timeout',
      indications: [PAIN],
      indications_total_count: 1,
      indications_rows_fetched: 1,
      indications_status: 'complete',
      indications_failure: null,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('mechanisms_status: failed');
    expect(text).toContain('mechanisms_total_count: —');
    expect(text).toContain('not retrieved');
    // Exactly one list is empty, and it is the failed one — so no list may claim
    // "none recorded".
    expect(text).not.toContain('none recorded');
    expect(text.split('\n')).toEqual(
      expect.arrayContaining([
        'mechanisms_status: failed | mechanisms_total_count: — | mechanisms_failure: timeout',
        '— not retrieved: the request ran out of time before ChEMBL returned the list, so this list is unknown, not empty. Re-call to retry.',
      ]),
    );
  });

  it('renders a truncated list with its shortfall so it cannot read as complete', () => {
    const blocks = chemblGetDrugInfo.format!({
      molecule_chembl_id: 'CHEMBL25',
      parent_molecule_chembl_id: 'CHEMBL25',
      pref_name: 'ASPIRIN',
      max_phase: 4,
      first_approval: 1950,
      mechanisms: [MECHANISM],
      mechanisms_total_count: 3,
      mechanisms_status: 'truncated',
      mechanisms_failure: null,
      indications: [PAIN],
      indications_total_count: 167,
      indications_rows_fetched: 100,
      indications_status: 'truncated',
      indications_failure: null,
    });
    const lines = (blocks[0] as { text: string }).text.split('\n');
    // A mechanism row is one mechanism, so its shortfall is exact.
    expect(lines).toContain(
      'mechanisms_status: truncated | mechanisms_total_count: 3 — showing 1 of 3; the remaining 2 were not returned',
    );
    // Each unfetched indication row adds at most one indication, so the bound is rows unfetched.
    expect(lines).toContain(
      'indications_status: truncated | indications_total_count: 167 | indications_rows_fetched: 100 — showing 1; the page cap fetched 100 of the 167 rows, so up to 67 more were not returned, and the phases and forms shown are lower bounds',
    );
  });

  /** A complete result whose upstream strings are the ones each test supplies. */
  const drugResult = (strings: {
    id: string;
    name: string;
    parent: string;
    mechanism: string;
    action: string;
    target: string;
    form: string;
    heading: string;
    meshId: string;
    term: string;
    efoId: string;
  }) => ({
    molecule_chembl_id: strings.id,
    parent_molecule_chembl_id: strings.parent,
    pref_name: strings.name,
    max_phase: 4,
    first_approval: 2003,
    mechanisms: [
      {
        target_chembl_id: strings.target,
        mechanism_of_action: strings.mechanism,
        action_type: strings.action,
        molecule_chembl_id: strings.form,
      },
    ],
    mechanisms_total_count: 1,
    mechanisms_status: 'complete' as const,
    mechanisms_failure: null,
    indications: [
      {
        mesh_id: strings.meshId,
        mesh_heading: strings.heading,
        efo_id: strings.efoId,
        efo_term: strings.term,
        max_phase_for_ind: 4,
        forms: [{ molecule_chembl_id: strings.form, max_phase_for_ind: 4 }],
      },
    ],
    indications_total_count: 1,
    indications_rows_fetched: 1,
    indications_status: 'complete' as const,
    indications_failure: null,
  });

  it('renders the header, both lists, and their state lines, markup-free values as written', () => {
    const blocks = chemblGetDrugInfo.format!(
      drugResult({
        id: 'CHEMBL939',
        name: 'GEFITINIB',
        parent: 'CHEMBL939',
        mechanism: 'Epidermal growth factor receptor erbB1 inhibitor',
        action: 'INHIBITOR',
        target: 'CHEMBL203',
        form: 'CHEMBL939',
        heading: 'Carcinoma, Non-Small-Cell Lung',
        meshId: 'D002289',
        term: 'non-small cell lung carcinoma',
        efoId: 'EFO:0003060',
      }),
    );
    expect((blocks[0] as { text: string }).text.split('\n')).toEqual([
      '**CHEMBL939** — GEFITINIB',
      'Max phase: 4 | First approval: 2003',
      'Parent: CHEMBL939 — both lists cover the parent and its alternate forms',
      '',
      '### Mechanisms of action',
      'mechanisms_status: complete | mechanisms_total_count: 1',
      '- Epidermal growth factor receptor erbB1 inhibitor (INHIBITOR) → target CHEMBL203 — recorded on CHEMBL939',
      '',
      '### Indications',
      'indications_status: complete | indications_total_count: 1 | indications_rows_fetched: 1',
      '- Carcinoma, Non-Small-Cell Lung [MeSH D002289] / EFO: non-small cell lung carcinoma [EFO:0003060] (max phase 4) — recorded on CHEMBL939 (phase 4)',
    ]);
  });

  /**
   * #44: a mechanism or a MeSH heading opens its list item, where a leading `#`,
   * `>`, `1.`, or a reference definition would build a block inside the item; the
   * other strings sit inside a line.
   */
  it('renders upstream mechanisms, indications, names, and IDs as the text recorded', () => {
    const strings = {
      id: 'CHEMBL_939*',
      name: '*GEFITINIB* [x](y)',
      parent: 'CHEMBL939\\',
      mechanism: '# Kinase *inhibitor* <br>',
      action: '_INHIBITOR_',
      target: 'CHEMBL[203](x)',
      form: 'CHEMBL`939`',
      heading: '1. Carcinoma\n> quoted',
      meshId: 'D_1_',
      term: 'lung &amp; airway',
      efoId: 'EFO:1](y)',
    };
    const blocks = chemblGetDrugInfo.format!(drugResult(strings));
    const { text, nodes } = parseMarkdown((blocks[0] as { text: string }).text);
    expect(text).toBe(
      [
        `${strings.id} — ${strings.name}`,
        'Max phase: 4 | First approval: 2003',
        `Parent: ${strings.parent} — both lists cover the parent and its alternate forms`,
        'Mechanisms of action',
        'mechanisms_status: complete | mechanisms_total_count: 1',
        `${strings.mechanism} (${strings.action}) → target ${strings.target} — recorded on ${strings.form}`,
        'Indications',
        'indications_status: complete | indications_total_count: 1 | indications_rows_fetched: 1',
        `${strings.heading} [MeSH ${strings.meshId}] / EFO: ${strings.term} [${strings.efoId}] (max phase 4) — recorded on ${strings.form} (phase 4)`,
      ].join('\n'),
    );
    // The two section headings are the server's own; nothing else may build markup.
    expect(markupNodes(nodes)).toEqual(['heading']);

    const definition = chemblGetDrugInfo.format!(
      drugResult({ ...strings, mechanism: '[ref]: https://x.org kinase' }),
    );
    expect(parseMarkdown((definition[0] as { text: string }).text).text).toContain(
      '[ref]: https://x.org kinase (_INHIBITOR_)',
    );
  });
});

describe('chembl_get_drug_info — output field descriptions', () => {
  it('describe the counts by what they report, never by the upstream paging field behind them', () => {
    const schema = JSON.stringify(z.toJSONSchema(chemblGetDrugInfo.output));
    expect(schema).not.toContain('page_meta');
    expect(schema).toContain(
      'Total mechanism rows ChEMBL holds for the molecule and its alternate forms. Exceeds the returned array length exactly when the status is \\"truncated\\".',
    );
  });
});
