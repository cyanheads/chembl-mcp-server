/**
 * @fileoverview Wire-contract characterization for the tool surface — the shape a
 * client actually receives, as opposed to the handler return value the other tool
 * tests assert. These properties are pinned here because they live in the framework
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
 *   4. The advertised JSON Schema admits every raw form a handler normalizes (#41),
 *      checked as whole argument objects against `required`, `additionalProperties`,
 *      and each property's keywords.
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

describe('tool argument representation repairs', () => {
  it('repairs a numeric limit string before querying and reports the parsed cap on both surfaces', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ targets: [], page_meta: { total_count: 0, next: null } }),
    );
    // @ts-expect-error Model-written wire arguments precede representation repair.
    const result = await runToolContract(chemblSearchTargets, { query: 'kinase', limit: '15' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ targets: [], cap: 15, shown: 0 });
    expect(contentText(result)).toContain('**cap:** 15');
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('limit')).toBe('15');
  });

  it('treats null at an optional query as absent and fills the missing-input recovery', async () => {
    // @ts-expect-error Model-written wire arguments precede representation repair.
    const result = await runToolContract(chemblSearchTargets, { query: null });

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        data: {
          reason: 'missing_input',
          recovery: { hint: expect.stringContaining('Supply at least one: accession') },
        },
      },
    });
    expect(contentText(result)).toContain('Recovery: Supply at least one: accession');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clamps a limit above the cap instead of rejecting it, and reports the applied cap on both surfaces', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ targets: [], page_meta: { total_count: 0, next: null } }),
    );
    const result = await runToolContract(chemblSearchTargets, { query: 'kinase', limit: 101 });

    expect(result.isError).toBeFalsy();
    const notice =
      'limit 101 is above the maximum of 100, so 100 was applied. No target matched query="kinase". Verify the accession/symbol, or broaden with a free-text query.';
    expect(result.structuredContent).toMatchObject({ targets: [], cap: 100, shown: 0, notice });
    const lines = contentText(result).split('\n');
    expect(lines).toContain('**cap:** 100');
    expect(lines).toContain(`> ${notice}`);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('limit')).toBe('100');
  });

  it('keeps a non-numeric limit string rejected before the upstream call', async () => {
    // @ts-expect-error Deliberately invalid wire input must fail argument validation.
    const result = await runToolContract(chemblSearchTargets, { query: 'kinase', limit: 'many' });

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments' },
      },
    });
    expect(contentText(result)).toContain('limit');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * The JSON Schema one input property advertises in `tools/list` — the keywords
 * {@link admitsValue} models. `description` and `default` constrain nothing, and
 * any other keyword fails the check rather than being skipped.
 */
interface AdvertisedProperty {
  default?: unknown;
  description?: string;
  maximum?: number;
  minimum?: number;
  minLength?: number;
  pattern?: string;
  type?: string;
}

/** The input object schema `tools/list` advertises for a tool, as the SDK projects it. */
interface AdvertisedInput {
  additionalProperties?: boolean;
  properties: Record<string, AdvertisedProperty>;
  required?: string[];
}

function advertisedInput(def: { input: { '~standard': unknown } }): AdvertisedInput {
  const standard = def.input['~standard'] as {
    jsonSchema: { input: (options: { target: string }) => unknown };
  };
  return standard.jsonSchema.input({ target: 'draft-2020-12' }) as AdvertisedInput;
}

const MODELED_KEYWORDS = new Set([
  'default',
  'description',
  'maximum',
  'minimum',
  'minLength',
  'pattern',
  'type',
]);

/**
 * Whether a JSON-Schema-validating client accepts `value` for one property: the
 * type, `minLength` in code points, `minimum` / `maximum`, and `pattern` as an
 * unanchored ECMA-262 regex under the `u` flag, the way JSON Schema validators
 * compile it. A keyword outside that set throws, so a constraint added to the
 * schema later cannot pass here unchecked.
 */
function admitsValue(property: AdvertisedProperty, value: string | number): boolean {
  const unmodeled = Object.keys(property).filter((keyword) => !MODELED_KEYWORDS.has(keyword));
  if (unmodeled.length > 0) throw new Error(`admitsValue does not model ${unmodeled.join(', ')}`);
  if (typeof value === 'number') {
    const typed =
      property.type === 'integer' ? Number.isInteger(value) : property.type === 'number';
    return (
      typed &&
      (property.minimum === undefined || value >= property.minimum) &&
      (property.maximum === undefined || value <= property.maximum)
    );
  }
  return (
    property.type === 'string' &&
    (property.minLength === undefined || [...value].length >= property.minLength) &&
    (property.pattern === undefined || new RegExp(property.pattern, 'u').test(value))
  );
}

/**
 * Whether a JSON-Schema-validating client accepts a whole arguments object: every
 * `required` key present, no key outside `properties` while `additionalProperties`
 * is false, and each value admitted by its property.
 */
function admits(schema: AdvertisedInput, args: Record<string, string | number>): boolean {
  return (
    (schema.required ?? []).every((key) => Object.hasOwn(args, key)) &&
    Object.entries(args).every(([key, value]) => {
      const property = schema.properties[key];
      return property ? admitsValue(property, value) : schema.additionalProperties !== false;
    })
  );
}

/**
 * Every raw form a handler normalizes is one a schema-validating client must be
 * able to send (#41): JSON Schema `pattern` takes no flags, so a pattern stating
 * only the canonical form would have such a client refuse the variants the
 * server maps. The refused column is what the advertised schema rules out.
 */
const ADVERTISED_FORMS = [
  {
    def: chemblGetBioactivities,
    field: 'molecule_chembl_id',
    admitted: [
      'chembl941',
      '  CHEMBL941  ',
      'CHEMBL941',
      '',
      '   ',
      'KTUFNOKKBVMGRW-UHFFFAOYSA-N',
      'CC(=O)Oc1ccccc1C(=O)O',
    ],
    refused: [],
  },
  {
    def: chemblGetBioactivities,
    field: 'target_chembl_id',
    admitted: ['chembl203', '  CHEMBL203  ', 'CHEMBL203', '', '   '],
    refused: ['imatinib', 'CHEMBL', 'P00533'],
  },
  {
    def: chemblGetBioactivities,
    field: 'assay_type',
    admitted: ['B', ' B ', 'b', 'binding', 'Binding', 'ADMET', 'adme', 'Unclassified', '', '  '],
    refused: ['X', 'bind', 'B F'],
  },
  {
    def: chemblGetBioactivities,
    field: 'standard_type',
    admitted: ['IC50', 'ic50', 'Kd'],
    refused: [],
  },
  {
    def: chemblGetBioactivities,
    field: 'limit',
    admitted: [1, 1000, 1001, 10_000],
    refused: [0, 10_001],
  },
  {
    def: chemblGetDrugInfo,
    field: 'molecule_chembl_id',
    admitted: [
      'chembl25',
      '  CHEMBL25  ',
      'CHEMBL25',
      'KTUFNOKKBVMGRW-UHFFFAOYSA-N',
      'ktufnokkbvmgrw-uhfffaoysa-n',
      'CC(=O)Oc1ccccc1C(=O)O',
    ],
    refused: [''],
  },
  {
    def: chemblGetAssay,
    field: 'assay_chembl_id',
    admitted: ['chembl674637', '  CHEMBL674637  ', 'CHEMBL674637'],
    refused: ['imatinib', '', '   '],
  },
  {
    def: chemblSearchTargets,
    field: 'accession',
    admitted: ['p00533', ' P00533 ', ''],
    refused: [],
  },
  {
    def: chemblSearchTargets,
    field: 'target_type',
    admitted: ['single protein', 'SINGLE PROTEIN', ''],
    refused: [],
  },
  { def: chemblSearchTargets, field: 'limit', admitted: [100, 101, 10_000], refused: [0, 10_001] },
  { def: chemblSearchMolecules, field: 'query', admitted: ['chembl25', 'CHEMBL25'], refused: [] },
  {
    def: chemblSearchMolecules,
    field: 'limit',
    admitted: [100, 101, 10_000],
    refused: [0, 10_001],
  },
] as const;

describe('advertised input schemas admit every raw form the handlers normalize (#41)', () => {
  /**
   * Each form is checked as the whole arguments object a client would send, `{ [field]: value }`,
   * so `required` and `additionalProperties` are applied along with the property. That object
   * is a complete call for every tool listed: none requires an argument besides the field.
   */
  it.each(ADVERTISED_FORMS.map((c) => [`${c.def.name}.${c.field}`, c] as const))(
    '%s',
    (_label, { def, field, admitted, refused }) => {
      const schema = advertisedInput(def);
      expect(schema.properties[field], `${def.name} advertises ${field}`).toBeDefined();
      expect((schema.required ?? []).filter((key) => key !== field)).toEqual([]);
      for (const value of admitted) {
        expect(admits(schema, { [field]: value }), `${JSON.stringify(value)} admitted`).toBe(true);
      }
      for (const value of refused) {
        expect(admits(schema, { [field]: value }), `${JSON.stringify(value)} refused`).toBe(false);
      }
    },
  );

  it('applies the object keywords every tool advertises: required keys and no undeclared ones', () => {
    const advertised = TOOLS.map(({ def }) => {
      const { required, additionalProperties } = advertisedInput(def);
      return [def.name, { required, additionalProperties }];
    });
    expect(Object.fromEntries(advertised)).toEqual({
      chembl_search_molecules: { required: undefined, additionalProperties: false },
      chembl_get_bioactivities: { required: undefined, additionalProperties: false },
      chembl_search_targets: { required: undefined, additionalProperties: false },
      chembl_get_drug_info: { required: ['molecule_chembl_id'], additionalProperties: false },
      chembl_get_assay: { required: ['assay_chembl_id'], additionalProperties: false },
      chembl_dataframe_query: { required: ['canvas_id', 'sql'], additionalProperties: false },
      chembl_dataframe_describe: { required: ['canvas_id'], additionalProperties: false },
      chembl_dataframe_drop: {
        required: ['canvas_id', 'table_name'],
        additionalProperties: false,
      },
    });
    const assay = advertisedInput(chemblGetAssay);
    expect(admits(assay, { assay_chembl_id: 'CHEMBL674637' })).toBe(true);
    expect(admits(assay, {})).toBe(false);
    expect(admits(assay, { assay_chembl_id: 'CHEMBL674637', querry: 'typo' })).toBe(false);
  });

  it('rejects a target ID that is no ChEMBL ID with -32602 before any request, routing to the search tool', async () => {
    const result = await runToolContract(chemblGetBioactivities, { target_chembl_id: 'imatinib' });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(contentText(result).split('\n')).toContain(
      'Error: Input validation error: Invalid arguments for tool chembl_get_bioactivities: target_chembl_id: Must be a ChEMBL target ID like CHEMBL203 — find one with chembl_search_targets.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
