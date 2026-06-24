/**
 * @fileoverview Behavior tests for chembl_get_assay: the happy path with a full
 * confidence decode, a sparse assay (null confidence/target preserved as null),
 * and the pure format() rendering the — fallbacks for absent fields.
 * @module tests/tools/chembl-get-assay.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblGetAssay } from '@/mcp-server/tools/definitions/chembl-get-assay.tool.js';
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

describe('chembl_get_assay — provenance', () => {
  it('returns a fully-decoded assay with a coerced confidence score', async () => {
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
    const result = await chemblGetAssay.handler(
      chemblGetAssay.input.parse({ assay_chembl_id: 'CHEMBL674637' }),
      ctx(),
    );
    expect(result).toMatchObject({
      assay_chembl_id: 'CHEMBL674637',
      assay_type: 'B',
      target_chembl_id: 'CHEMBL203',
      organism: 'Homo sapiens',
      confidence_score: 9,
    });
  });

  it("preserves a sparse assay's missing fields as null", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ assay_chembl_id: 'CHEMBL1' }));
    const result = await chemblGetAssay.handler(
      chemblGetAssay.input.parse({ assay_chembl_id: 'CHEMBL1' }),
      ctx(),
    );
    expect(result.confidence_score).toBeNull();
    expect(result.target_chembl_id).toBeNull();
    expect(result.assay_type).toBeNull();
  });

  it('rejects an empty assay_chembl_id at the schema boundary', () => {
    expect(() => chemblGetAssay.input.parse({ assay_chembl_id: '' })).toThrow();
  });
});

describe('chembl_get_assay format()', () => {
  it('renders the confidence line and target', () => {
    const blocks = chemblGetAssay.format!({
      assay_chembl_id: 'CHEMBL674637',
      description: 'Inhibition of EGFR',
      assay_type: 'B',
      assay_type_description: 'Binding',
      target_chembl_id: 'CHEMBL203',
      organism: 'Homo sapiens',
      confidence_score: 9,
      confidence_description: 'Direct single protein target assigned',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**CHEMBL674637**');
    expect(text).toContain('Confidence: 9');
    expect(text).toContain('Target: CHEMBL203');
  });

  it('renders — for absent fields on a sparse assay', () => {
    const blocks = chemblGetAssay.format!({
      assay_chembl_id: 'CHEMBL1',
      description: null,
      assay_type: null,
      assay_type_description: null,
      target_chembl_id: null,
      organism: null,
      confidence_score: null,
      confidence_description: null,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Confidence: —');
    expect(text).toContain('Target: —');
  });
});
