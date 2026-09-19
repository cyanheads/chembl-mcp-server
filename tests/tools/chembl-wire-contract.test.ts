/**
 * @fileoverview Wire-contract characterization for the tool surface — the shape a
 * client actually receives, as opposed to the handler return value the other tool
 * tests assert. Two properties are pinned here because they live in the framework
 * rather than in any definition file, so nothing else in this suite would notice
 * them changing:
 *
 *   1. Tool input roots are strict. An undeclared argument key is rejected BY NAME
 *      before the handler runs, rather than silently stripped — a caller's typo
 *      surfaces as a typo instead of as a wrong answer. No tool on this server
 *      proxies arbitrary upstream query parameters, so none opts back out with
 *      `.passthrough()` / `.catchall()`; this asserts that for all eight.
 *   2. `canvas_id` INPUT fields advertise the minted id shape, so an impossible
 *      value is rejected at argument validation; the OUTPUT field stays a plain
 *      string, since a minted id is reported rather than validated.
 *   3. Both consumption surfaces carry the same payload. `structuredContent` and
 *      `content[]` are read by different clients, on success (domain fields +
 *      enrichment trailer) and on failure (the declared `error` envelope).
 *
 * `runToolContract` runs a definition through the production contract boundary —
 * input validation, handler, `format()`, enrichment merge, error envelope — so
 * these are the bytes the transport would serialize.
 * @module tests/tools/chembl-wire-contract
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblDataframeDescribe } from '@/mcp-server/tools/definitions/chembl-dataframe-describe.tool.js';
import { chemblDataframeDrop } from '@/mcp-server/tools/definitions/chembl-dataframe-drop.tool.js';
import { chemblDataframeQuery } from '@/mcp-server/tools/definitions/chembl-dataframe-query.tool.js';
import { chemblGetAssay } from '@/mcp-server/tools/definitions/chembl-get-assay.tool.js';
import { chemblGetBioactivities } from '@/mcp-server/tools/definitions/chembl-get-bioactivities.tool.js';
import { chemblGetDrugInfo } from '@/mcp-server/tools/definitions/chembl-get-drug-info.tool.js';
import { chemblSearchMolecules } from '@/mcp-server/tools/definitions/chembl-search-molecules.tool.js';
import { chemblSearchTargets } from '@/mcp-server/tools/definitions/chembl-search-targets.tool.js';
import { initChemblService } from '@/services/chembl/chembl-service.js';

/** A `canvas_id` of the shape `CanvasIdSchema` advertises (`^[A-Za-z0-9_-]{10}$`). */
const MINTED_CANVAS_ID = 'Ab3_xY-9Qz';

/** Every tool this server defines, with an otherwise-valid argument set. */
const TOOLS = [
  { def: chemblSearchMolecules, valid: { query: 'aspirin' } },
  { def: chemblGetBioactivities, valid: { molecule_chembl_id: 'CHEMBL25' } },
  { def: chemblSearchTargets, valid: { accession: 'P00533' } },
  { def: chemblGetDrugInfo, valid: { molecule_chembl_id: 'CHEMBL941' } },
  { def: chemblGetAssay, valid: { assay_chembl_id: 'CHEMBL674637' } },
  { def: chemblDataframeQuery, valid: { canvas_id: MINTED_CANVAS_ID, sql: 'SELECT 1' } },
  { def: chemblDataframeDescribe, valid: { canvas_id: MINTED_CANVAS_ID } },
  {
    def: chemblDataframeDrop,
    valid: { canvas_id: MINTED_CANVAS_ID, table_name: 'bioactivities' },
  },
] as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Every text block on the result — `format()`'s output plus any trailer — joined. */
function contentText(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
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

describe('tool input roots are strict', () => {
  it.each(TOOLS.map((t) => [t.def.name, t] as const))(
    '%s rejects an undeclared key by name',
    (_name, { def, valid }) => {
      const parsed = def.input.safeParse({ ...valid, querry: 'typo' });
      expect(parsed.success).toBe(false);
      const unrecognized = parsed.error?.issues.find(
        (issue) => issue.code === 'unrecognized_keys',
      ) as { code: string; keys: string[] } | undefined;
      expect(unrecognized).toBeDefined();
      expect(unrecognized?.keys).toContain('querry');
    },
  );

  it('accepts the same arguments without the undeclared key', () => {
    for (const { def, valid } of TOOLS) {
      expect(def.input.safeParse(valid).success).toBe(true);
    }
  });
});

/**
 * Every tool carrying a `canvas_id` INPUT field, and whether it is required. The
 * output `canvas_id` on chembl_get_bioactivities is a plain string and is not
 * listed — a minted id is the server's to report, not the caller's to satisfy.
 */
const CANVAS_ID_INPUTS = [
  { def: chemblGetBioactivities, rest: { molecule_chembl_id: 'CHEMBL25' } },
  { def: chemblDataframeQuery, rest: { sql: 'SELECT 1' } },
  { def: chemblDataframeDescribe, rest: {} },
  { def: chemblDataframeDrop, rest: { table_name: 'bioactivities' } },
] as const;

describe('canvas_id input shape', () => {
  it.each(CANVAS_ID_INPUTS.map((t) => [t.def.name, t] as const))(
    '%s accepts a minted canvas id',
    (_name, { def, rest }) => {
      expect(def.input.safeParse({ ...rest, canvas_id: MINTED_CANVAS_ID }).success).toBe(true);
    },
  );

  /**
   * `CanvasIdSchema` puts the minted `^[A-Za-z0-9_-]{10}$` shape into the
   * advertised `inputSchema`, so an id that could never have been minted is
   * rejected at argument validation and the handler never runs. Without it the
   * call reached `canvas.acquire` and came back as a missing-or-expired canvas,
   * which reads as "your canvas went away" for a value that was never one.
   */
  it.each(CANVAS_ID_INPUTS.map((t) => [t.def.name, t] as const))(
    '%s rejects an id that could not have been minted',
    (_name, { def, rest }) => {
      for (const bad of ['x', 'Ab3_xY-9Qz0', 'Ab3_xY 9Qz', '']) {
        expect(
          def.input.safeParse({ ...rest, canvas_id: bad }).success,
          `canvas_id ${JSON.stringify(bad)} must be rejected`,
        ).toBe(false);
      }
    },
  );

  it('leaves the OUTPUT canvas_id a plain string — a minted id is reported, not validated', () => {
    const shape = chemblGetBioactivities.output.shape;
    expect(shape.canvas_id.safeParse('anything-at-all').success).toBe(true);
    expect(shape.canvas_id.safeParse(null).success).toBe(true);
  });

  it('omits canvas_id entirely on the optional field', () => {
    expect(chemblGetBioactivities.input.safeParse({ molecule_chembl_id: 'CHEMBL25' }).success).toBe(
      true,
    );
  });
});

describe('failure reaches both wire surfaces', () => {
  it('declares the error envelope in structuredContent and mirrors it into content[]', async () => {
    const result = await runToolContract(chemblSearchTargets, {});

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        message: 'None of query, accession, or gene_symbol was supplied.',
        data: {
          reason: 'missing_input',
          recovery: { hint: expect.stringContaining('Supply at least one: accession') },
        },
      },
    });
    // A content[]-only client has to be able to act on the failure too — both the
    // message and the recovery hint are mirrored, not just the message.
    const text = contentText(result);
    expect(text).toContain('Error: None of query, accession, or gene_symbol was supplied.');
    expect(text).toContain('Recovery: Supply at least one: accession');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('success reaches both wire surfaces', () => {
  it('carries the assay fields in structuredContent and renders them in content[]', async () => {
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

    const result = await runToolContract(chemblGetAssay, {
      assay_chembl_id: 'CHEMBL674637',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      assay_chembl_id: 'CHEMBL674637',
      target_chembl_id: 'CHEMBL203',
      confidence_score: 9,
    });
    const text = contentText(result);
    expect(text).toContain('CHEMBL674637');
    expect(text).toContain('CHEMBL203');
    expect(text).toContain('Confidence: 9');
  });

  it('merges enrichment into structuredContent and appends it as a content[] trailer', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        molecules: [
          {
            molecule_chembl_id: 'CHEMBL25',
            pref_name: 'ASPIRIN',
            molecule_structures: { canonical_smiles: 'CC(=O)Oc1ccccc1C(=O)O' },
            molecule_properties: { full_molformula: 'C9H8O4', mw_freebase: '180.16' },
            max_phase: '4',
          },
        ],
        page_meta: { total_count: 1, next: null },
      }),
    );

    const result = await runToolContract(chemblSearchMolecules, { query: 'aspirin' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      molecules: [{ molecule_chembl_id: 'CHEMBL25', pref_name: 'ASPIRIN' }],
      totalCount: 1,
      truncated: false,
      shown: 1,
      cap: 25,
    });
    // format() renders the domain payload; the enrichment rides as its own trailing
    // block — the only place a content[]-only client sees the total and the cap.
    const [domain, trailer] = result.content as { type: string; text: string }[];
    expect(domain?.text).toContain('**CHEMBL25** — ASPIRIN');
    expect(trailer?.text).toContain('**1 total**');
    expect(trailer?.text).toContain('**cap:** 25');
  });
});

describe('mock context stays aligned with the definition contract', () => {
  it('types ctx.fail against the declared reasons', () => {
    const ctx = createMockContext({ tenantId: 'default', errors: chemblSearchTargets.errors });
    expect(ctx.recoveryFor('missing_input')).toMatchObject({
      recovery: { hint: expect.any(String) },
    });
  });
});
