/**
 * @fileoverview Tests for the handler-level input gates that Zod can't express:
 * the bioactivity at-least-one molecule/target gate and the search "at least one
 * input" gates. Every rejecting case fires before any upstream call, so no network
 * is involved. The one accepting case — both bioactivity IDs together — has to run
 * past the gate to prove it was let through, so it stubs `fetch`.
 * @module tests/tools/chembl-input-gates
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblGetBioactivities } from '@/mcp-server/tools/definitions/chembl-get-bioactivities.tool.js';
import { chemblSearchMolecules } from '@/mcp-server/tools/definitions/chembl-search-molecules.tool.js';
import { chemblSearchTargets } from '@/mcp-server/tools/definitions/chembl-search-targets.tool.js';
import { initChemblService } from '@/services/chembl/chembl-service.js';

beforeAll(() => {
  initChemblService(getServerConfig());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Assert a handler call rejects with the given McpError code + data.reason.
 * `ToolDefinition.handler` is typed to allow a sync return, so its result is
 * `T | Promise<T>`; normalizing through `Promise.resolve` keeps a sync return
 * assertable — it settles fulfilled and the `.rejects` assertion fails, which
 * is the correct verdict for a gate that was supposed to throw.
 */
async function expectFail(result: unknown, code: number, reason: string) {
  const settled = Promise.resolve(result);
  await expect(settled).rejects.toMatchObject({ code, data: { reason } });
  await expect(settled).rejects.toBeInstanceOf(McpError);
}

describe('chembl_get_bioactivities — molecule/target filter gate', () => {
  it('rejects when neither id is supplied', async () => {
    const ctx = createMockContext({ tenantId: 'default', errors: chemblGetBioactivities.errors });
    const input = chemblGetBioactivities.input.parse({});
    await expectFail(
      chemblGetBioactivities.handler(input, ctx),
      JsonRpcErrorCode.InvalidParams,
      'missing_filter',
    );
  });

  it('lets both ids through — a compound × target pair is a query, not a gate failure', async () => {
    // A fresh Response per call — the handler makes two (honest count, then the
    // view stream), and a Response body can only be read once.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ activities: [], page_meta: { total_count: 0, next: null } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      ),
    );
    const ctx = createMockContext({ tenantId: 'default', errors: chemblGetBioactivities.errors });
    const input = chemblGetBioactivities.input.parse({
      molecule_chembl_id: 'CHEMBL25',
      target_chembl_id: 'CHEMBL203',
    });
    const result = await chemblGetBioactivities.handler(input, ctx);
    expect(result.totalCount).toBe(0);
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
