/**
 * @fileoverview Tests for the chembl://molecule/{chemblId} and
 * chembl://target/{chemblId} resources: the handler returns the same normalized
 * shape the tool surface carries (against a stubbed upstream), the molecule's
 * resolved parent, and the ID param, which reads a ChEMBL ID in any case as the
 * canonical one and rejects a malformed ID at the schema boundary before any fetch.
 * @module tests/resources/chembl-resources
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
  createMockContext({
    tenantId: 'default',
    uri: new URL('chembl://molecule/CHEMBL25'),
    errors: chemblMoleculeResource.errors,
  });

describe.each([chemblMoleculeResource, chemblTargetResource])('$name upstream errors', (def) => {
  it('preserves the sanitized not-found reason and actionable recovery', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ internal: 'private diagnostic' }, 404));
    await expect(def.handler({ chemblId: 'CHEMBL999' }, ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'not_found',
        recovery: { hint: expect.stringContaining('Verify the ChEMBL ID') },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

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
    const params = chemblMoleculeResource.params!.parse({ chemblId: 'CHEMBL25' });
    const result = await chemblMoleculeResource.handler(params, ctx());
    expect(result).toMatchObject({
      molecule_chembl_id: 'CHEMBL25',
      max_phase: 4,
      mw_freebase: 180.16,
    });
  });

  it('carries the parent a salt resolves to, and a record with no hierarchy as its own', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          molecule_chembl_id: 'CHEMBL1079742',
          molecule_hierarchy: {
            active_chembl_id: 'CHEMBL553',
            molecule_chembl_id: 'CHEMBL1079742',
            parent_chembl_id: 'CHEMBL553',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ molecule_chembl_id: 'CHEMBL1201352', molecule_hierarchy: null }),
      );
    const read = async (chemblId: string) =>
      chemblMoleculeResource.handler(chemblMoleculeResource.params!.parse({ chemblId }), ctx());
    expect(await read('CHEMBL1079742')).toMatchObject({
      molecule_chembl_id: 'CHEMBL1079742',
      parent_chembl_id: 'CHEMBL553',
    });
    expect(await read('CHEMBL1201352')).toMatchObject({
      molecule_chembl_id: 'CHEMBL1201352',
      parent_chembl_id: 'CHEMBL1201352',
    });
  });

  it('rejects a malformed ChEMBL ID at the param schema (no fetch)', () => {
    expect(() => chemblMoleculeResource.params!.parse({ chemblId: 'not-an-id' })).toThrow();
    expect(() => chemblMoleculeResource.params!.parse({ chemblId: 'CHEMBL' })).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves a lowercase ChEMBL ID as the canonical one (#41)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ molecule_chembl_id: 'CHEMBL25' }));
    const params = chemblMoleculeResource.params!.parse({ chemblId: 'chembl25' });
    expect(params).toEqual({ chemblId: 'CHEMBL25' });
    const result = await chemblMoleculeResource.handler(params, ctx());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://www.ebi.ac.uk/chembl/api/data/molecule/CHEMBL25.json',
    );
    expect(result).toMatchObject({ molecule_chembl_id: 'CHEMBL25' });
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
    const params = chemblTargetResource.params!.parse({ chemblId: 'CHEMBL203' });
    const result = await chemblTargetResource.handler(
      params,
      createMockContext({
        tenantId: 'default',
        uri: new URL('chembl://target/CHEMBL203'),
        errors: chemblTargetResource.errors,
      }),
    );
    expect(result).toMatchObject({
      target_chembl_id: 'CHEMBL203',
      target_type: 'SINGLE PROTEIN',
      components: [{ gene_symbols: ['EGFR'] }],
    });
  });

  it('reads a lowercase ChEMBL ID as the canonical one (#41), and rejects a malformed one', () => {
    expect(chemblTargetResource.params!.parse({ chemblId: 'chembl203' })).toEqual({
      chemblId: 'CHEMBL203',
    });
    expect(() => chemblTargetResource.params!.parse({ chemblId: 'CHEMBL203x' })).toThrow();
    expect(() => chemblTargetResource.params!.parse({ chemblId: 'P00533' })).toThrow();
  });
});
