/**
 * @fileoverview Behavior tests for chembl_get_drug_info: the composed happy path,
 * the degraded path (a research compound with no mechanisms/indications → a
 * notice, not an error), 404 propagation when the molecule itself is missing, and
 * the pure format() rendering "— none recorded" for empty lists.
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
      indications: [{ mesh_heading: 'NSCLC', efo_term: 'nsclc', max_phase_for_ind: 4 }],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**CHEMBL939**');
    expect(text).toContain('First approval: 2003');
    expect(text).toContain('EGFR inhibitor');
    expect(text).toContain('NSCLC');
  });

  it('renders "— none recorded" for empty mechanism and indication lists', () => {
    const blocks = chemblGetDrugInfo.format!({
      molecule_chembl_id: 'CHEMBL999999',
      pref_name: null,
      max_phase: null,
      first_approval: null,
      mechanisms: [],
      indications: [],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('(unnamed)');
    expect(text).toContain('Max phase: —');
    expect((text.match(/— none recorded/g) ?? []).length).toBe(2);
  });
});
