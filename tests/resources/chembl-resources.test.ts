/**
 * @fileoverview Tests for the chembl://molecule/{chemblId} and
 * chembl://target/{chemblId} resources: the handler returns the same normalized
 * shape the tool surface carries (against a stubbed upstream), and the CHEMBL\d+
 * param regex rejects malformed IDs at the schema boundary before any fetch.
 * @module tests/resources/chembl-resources
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblMoleculeResource } from '@/mcp-server/resources/definitions/chembl-molecule.resource.js';
import { chemblTargetResource } from '@/mcp-server/resources/definitions/chembl-target.resource.js';
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

const ctx = () =>
  createMockContext({ tenantId: 'default', uri: new URL('chembl://molecule/CHEMBL25') });

describe('chembl://molecule/{chemblId}', () => {
  it('returns a normalized molecule record for a valid ChEMBL ID', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        molecule_chembl_id: 'CHEMBL25',
        pref_name: 'ASPIRIN',
        max_phase: '4',
        molecule_properties: { mw_freebase: '180.16' },
      }),
    );
    const params = chemblMoleculeResource.params.parse({ chemblId: 'CHEMBL25' });
    const result = await chemblMoleculeResource.handler(params, ctx());
    expect(result).toMatchObject({
      molecule_chembl_id: 'CHEMBL25',
      max_phase: 4,
      mw_freebase: 180.16,
    });
  });

  it('rejects a malformed ChEMBL ID at the param schema (no fetch)', () => {
    expect(() => chemblMoleculeResource.params.parse({ chemblId: 'not-an-id' })).toThrow();
    expect(() => chemblMoleculeResource.params.parse({ chemblId: 'CHEMBL' })).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('chembl://target/{chemblId}', () => {
  it('returns a normalized target record with flattened gene symbols', async () => {
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
    const params = chemblTargetResource.params.parse({ chemblId: 'CHEMBL203' });
    const result = await chemblTargetResource.handler(
      params,
      createMockContext({ tenantId: 'default', uri: new URL('chembl://target/CHEMBL203') }),
    );
    expect(result).toMatchObject({ target_chembl_id: 'CHEMBL203', target_type: 'SINGLE PROTEIN' });
    expect(result.components[0]?.gene_symbols).toEqual(['EGFR']);
  });

  it('rejects a lowercase/malformed ChEMBL ID at the param schema', () => {
    expect(() => chemblTargetResource.params.parse({ chemblId: 'chembl203' })).toThrow();
    expect(() => chemblTargetResource.params.parse({ chemblId: 'CHEMBL203x' })).toThrow();
  });
});
