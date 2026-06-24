/**
 * @fileoverview Tests for the handler-level input gates that Zod can't express:
 * the bioactivity molecule-XOR-target gate and the search "at least one input"
 * gates. These fire before any upstream call, so no network is involved.
 * @module tests/tools/chembl-input-gates
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblGetBioactivities } from '@/mcp-server/tools/definitions/chembl-get-bioactivities.tool.js';
import { chemblSearchMolecules } from '@/mcp-server/tools/definitions/chembl-search-molecules.tool.js';
import { chemblSearchTargets } from '@/mcp-server/tools/definitions/chembl-search-targets.tool.js';
import { initChemblService } from '@/services/chembl/chembl-service.js';

beforeAll(() => {
  initChemblService(getServerConfig());
});

/** Assert a handler call rejects with the given McpError code + data.reason. */
async function expectFail(promise: Promise<unknown>, code: number, reason: string) {
  await expect(promise).rejects.toMatchObject({ code, data: { reason } });
  await expect(promise).rejects.toBeInstanceOf(McpError);
}

describe('chembl_get_bioactivities — molecule XOR target gate', () => {
  it('rejects when neither id is supplied', async () => {
    const ctx = createMockContext({ tenantId: 'default', errors: chemblGetBioactivities.errors });
    const input = chemblGetBioactivities.input.parse({});
    await expectFail(
      chemblGetBioactivities.handler(input, ctx),
      JsonRpcErrorCode.InvalidParams,
      'missing_filter',
    );
  });

  it('rejects when both ids are supplied', async () => {
    const ctx = createMockContext({ tenantId: 'default', errors: chemblGetBioactivities.errors });
    const input = chemblGetBioactivities.input.parse({
      molecule_chembl_id: 'CHEMBL25',
      target_chembl_id: 'CHEMBL203',
    });
    await expectFail(
      chemblGetBioactivities.handler(input, ctx),
      JsonRpcErrorCode.InvalidParams,
      'missing_filter',
    );
  });

  it('treats blank-string ids as absent (form-client guard)', async () => {
    const ctx = createMockContext({ tenantId: 'default', errors: chemblGetBioactivities.errors });
    const input = chemblGetBioactivities.input.parse({
      molecule_chembl_id: '   ',
      target_chembl_id: '',
    });
    await expectFail(
      chemblGetBioactivities.handler(input, ctx),
      JsonRpcErrorCode.InvalidParams,
      'missing_filter',
    );
  });
});

describe('chembl_search_targets — at-least-one-input gate', () => {
  it('rejects when none of query/accession/gene_symbol supplied', async () => {
    const ctx = createMockContext({ tenantId: 'default', errors: chemblSearchTargets.errors });
    const input = chemblSearchTargets.input.parse({});
    await expectFail(
      chemblSearchTargets.handler(input, ctx),
      JsonRpcErrorCode.InvalidParams,
      'missing_input',
    );
  });

  it('treats blank strings as absent', async () => {
    const ctx = createMockContext({ tenantId: 'default', errors: chemblSearchTargets.errors });
    const input = chemblSearchTargets.input.parse({ query: '  ', accession: '', gene_symbol: '' });
    await expectFail(
      chemblSearchTargets.handler(input, ctx),
      JsonRpcErrorCode.InvalidParams,
      'missing_input',
    );
  });
});

describe('chembl_search_molecules — input/mode pairing gate', () => {
  it('rejects search_type=name without a query', async () => {
    const ctx = createMockContext({ tenantId: 'default', errors: chemblSearchMolecules.errors });
    const input = chemblSearchMolecules.input.parse({ search_type: 'name' });
    await expectFail(
      chemblSearchMolecules.handler(input, ctx),
      JsonRpcErrorCode.InvalidParams,
      'missing_input',
    );
  });

  it('rejects a structure search_type without a structure', async () => {
    const ctx = createMockContext({ tenantId: 'default', errors: chemblSearchMolecules.errors });
    const input = chemblSearchMolecules.input.parse({ search_type: 'similarity' });
    await expectFail(
      chemblSearchMolecules.handler(input, ctx),
      JsonRpcErrorCode.InvalidParams,
      'missing_input',
    );
  });
});
