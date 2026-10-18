/**
 * @fileoverview Tests for the chembl_dataframe_drop registration gate. The drop
 * tool is opt-in behind CHEMBL_DATAFRAME_DROP_ENABLED (z.stringbool, so
 * "=false" actually disables). When the flag is off it is wrapped with
 * disabledTool(), which keeps it in the server manifest with the enable hint
 * while the registry skips it — so it stays absent from tools/list. Two layers
 * are verified: the env-var → boolean parse (including the stringbool
 * semantics), and the gate index.ts applies — the raw definition when the flag
 * is on, the wrapped one when off, with the eight-tool manifest constant either
 * way and the seven always-on tools untouched. Then the real wiring: the
 * non-throwing flag read `src/index.ts` gates on at module load, and `index.ts`
 * itself loaded with `createApp` stubbed — an invalid server env value must not
 * throw at import, and must instead fail the full parse inside `setup()`, where
 * the framework turns it into the configuration banner.
 * @module tests/tools/chembl-registration-gate
 */

import { disabledTool, z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDataframeDropEnabled } from '@/config/server-config.js';
import { chemblDataframeDescribe } from '@/mcp-server/tools/definitions/chembl-dataframe-describe.tool.js';
import { chemblDataframeDrop } from '@/mcp-server/tools/definitions/chembl-dataframe-drop.tool.js';
import { chemblDataframeQuery } from '@/mcp-server/tools/definitions/chembl-dataframe-query.tool.js';
import { chemblGetAssay } from '@/mcp-server/tools/definitions/chembl-get-assay.tool.js';
import { chemblGetBioactivities } from '@/mcp-server/tools/definitions/chembl-get-bioactivities.tool.js';
import { chemblGetDrugInfo } from '@/mcp-server/tools/definitions/chembl-get-drug-info.tool.js';
import { chemblSearchMolecules } from '@/mcp-server/tools/definitions/chembl-search-molecules.tool.js';
import { chemblSearchTargets } from '@/mcp-server/tools/definitions/chembl-search-targets.tool.js';

/**
 * `createApp` is stubbed so importing `src/index.ts` records its options instead
 * of starting a transport; `initChemblService` is a spy so a test can see the
 * config `setup()` hands it. Everything else in both modules stays real.
 */
const createAppMock = vi.hoisted(() => vi.fn());
const initChemblServiceMock = vi.hoisted(() => vi.fn());
vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp: createAppMock,
}));
vi.mock('@/services/chembl/chembl-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/chembl/chembl-service.js')>()),
  initChemblService: initChemblServiceMock,
}));

/** Mirror of the CHEMBL_DATAFRAME_DROP_ENABLED field — z.stringbool, default off. */
const DropFlagSchema = z.object({
  dataframeDropEnabled: z.stringbool().default(false),
});

function parseDropFlag(): boolean {
  return parseEnvConfig(DropFlagSchema, {
    dataframeDropEnabled: 'CHEMBL_DATAFRAME_DROP_ENABLED',
  }).dataframeDropEnabled;
}

/** The always-registered seven tools, in index.ts registration order. */
const ALWAYS_ON = [
  chemblSearchMolecules,
  chemblGetBioactivities,
  chemblSearchTargets,
  chemblGetDrugInfo,
  chemblGetAssay,
  chemblDataframeQuery,
  chemblDataframeDescribe,
];

/** The registration gate index.ts applies. */
function registeredTools(dataframeDropEnabled: boolean) {
  return [
    ...ALWAYS_ON,
    dataframeDropEnabled
      ? chemblDataframeDrop
      : disabledTool(chemblDataframeDrop, {
          reason: 'Dropping staged canvas tables is turned off in this deployment.',
          hint: 'CHEMBL_DATAFRAME_DROP_ENABLED=true',
        }),
  ];
}

describe('CHEMBL_DATAFRAME_DROP_ENABLED — stringbool parse', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to false when the env var is unset', () => {
    vi.stubEnv('CHEMBL_DATAFRAME_DROP_ENABLED', undefined as unknown as string);
    expect(parseDropFlag()).toBe(false);
  });

  it('parses "true" as true', () => {
    vi.stubEnv('CHEMBL_DATAFRAME_DROP_ENABLED', 'true');
    expect(parseDropFlag()).toBe(true);
  });

  it('parses "false" as false (z.stringbool, not z.coerce.boolean)', () => {
    vi.stubEnv('CHEMBL_DATAFRAME_DROP_ENABLED', 'false');
    expect(parseDropFlag()).toBe(false);
  });
});

describe('chembl_dataframe_drop — registration gate', () => {
  it('hands the registry the disabledTool() wrapper when the flag is off', () => {
    const tools = registeredTools(false);
    const drop = tools.find((t) => t.name === 'chembl_dataframe_drop');
    // disabledTool() returns a copy carrying the marker the registry reads to
    // skip registration, so a wrapped tool is never the raw definition.
    expect(drop).toBeDefined();
    expect(drop).not.toBe(chemblDataframeDrop);
    expect(tools).toHaveLength(8);
  });

  it('hands the registry the raw definition when the flag is on', () => {
    const tools = registeredTools(true);
    expect(tools.find((t) => t.name === 'chembl_dataframe_drop')).toBe(chemblDataframeDrop);
    expect(tools).toHaveLength(8);
  });

  it('preserves the definition through the wrapper', () => {
    const drop = registeredTools(false).find((t) => t.name === 'chembl_dataframe_drop');
    expect(drop?.description).toBe(chemblDataframeDrop.description);
    expect(drop?.annotations).toEqual(chemblDataframeDrop.annotations);
    expect(drop?.handler).toBe(chemblDataframeDrop.handler);
  });

  it('always registers the seven core tools regardless of the flag', () => {
    for (const flag of [false, true]) {
      const names = registeredTools(flag).map((t) => t.name);
      expect(names).toContain('chembl_search_molecules');
      expect(names).toContain('chembl_get_bioactivities');
      expect(names).toContain('chembl_dataframe_query');
      expect(names).toContain('chembl_dataframe_describe');
    }
  });

  it('marks the drop tool destructive + non-read-only (the only such tool)', () => {
    // Drop is the lone mutator on an otherwise read-only surface.
    expect(chemblDataframeDrop.annotations?.readOnlyHint).toBe(false);
    expect(chemblDataframeDrop.annotations?.destructiveHint).toBe(true);
    for (const t of ALWAYS_ON) {
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });
});

/** An unsubstituted installer placeholder, as a host forwards a blank option. */
const placeholder = (name: string): string => `\${user_config.${name}}`;

describe('isDataframeDropEnabled — the module-load flag read (#30)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['true', true],
    ['false', false],
    ['', false],
    [placeholder('CHEMBL_DATAFRAME_DROP_ENABLED'), false],
    ['maybe', false],
  ])('reads %j as %s without throwing', (value, expected) => {
    vi.stubEnv('CHEMBL_DATAFRAME_DROP_ENABLED', value);
    expect(isDataframeDropEnabled()).toBe(expected);
  });

  it('reads an unset flag as off', () => {
    vi.stubEnv('CHEMBL_DATAFRAME_DROP_ENABLED', undefined as unknown as string);
    expect(isDataframeDropEnabled()).toBe(false);
  });

  it('is unaffected by an invalid value in another server variable', () => {
    vi.stubEnv('CHEMBL_MAX_PAGE_SIZE', 'abc');
    vi.stubEnv('CHEMBL_DATAFRAME_DROP_ENABLED', 'true');
    expect(isDataframeDropEnabled()).toBe(true);
  });
});

/** The slice of `createApp()` options these tests read. */
interface IndexOptions {
  setup: (core: { canvas: undefined }) => void;
  tools: Array<{ name: string }>;
}

/**
 * Import `src/index.ts` fresh under the current env and return the options it
 * passed to `createApp`, plus the drop definition and config accessor from the
 * same module graph (a fresh graph holds its own definition objects).
 */
async function loadIndex() {
  vi.resetModules();
  createAppMock.mockClear();
  initChemblServiceMock.mockClear();
  await import('@/index.js');
  expect(createAppMock).toHaveBeenCalledTimes(1);
  const options = createAppMock.mock.calls[0]?.[0] as IndexOptions;
  const { chemblDataframeDrop: drop } = await import(
    '@/mcp-server/tools/definitions/chembl-dataframe-drop.tool.js'
  );
  const { getServerConfig } = await import('@/config/server-config.js');
  const dropEntry = options.tools.find((t) => t.name === 'chembl_dataframe_drop');
  return { options, drop, dropEntry, getServerConfig };
}

/** Run the captured `setup()` and return what it threw, if anything. */
function runSetup(options: IndexOptions): unknown {
  try {
    options.setup({ canvas: undefined });
    return undefined;
  } catch (error) {
    return error;
  }
}

const SERVER_VARS = [
  'CHEMBL_API_BASE_URL',
  'CHEMBL_REQUEST_TIMEOUT_MS',
  'CHEMBL_MAX_PAGE_SIZE',
  'CHEMBL_DEFAULT_LIMIT',
  'CHEMBL_MAX_SPILL_ROWS',
  'CHEMBL_MAX_CONCURRENT_PAGES',
  'CHEMBL_SPILL_DEADLINE_MS',
  'CHEMBL_DATAFRAME_DROP_ENABLED',
];

describe('src/index.ts — server config parsed in setup() (#30)', () => {
  /**
   * Blank every server variable first, so a developer's exported value or a
   * `.env` line (which never overrides a set variable) cannot leak into the import.
   */
  beforeEach(() => {
    for (const name of SERVER_VARS) vi.stubEnv(name, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['CHEMBL_MAX_PAGE_SIZE', 'abc'],
    ['CHEMBL_DATAFRAME_DROP_ENABLED', 'maybe'],
    ['CHEMBL_MAX_CONCURRENT_PAGES', '0'],
    ['CHEMBL_MAX_CONCURRENT_PAGES', '7'],
    ['CHEMBL_MAX_CONCURRENT_PAGES', '2.5'],
    ['CHEMBL_SPILL_DEADLINE_MS', '9999'],
    ['CHEMBL_SPILL_DEADLINE_MS', '600001'],
  ])(
    'loads with %s=%s, then fails setup() with a ConfigurationError naming it',
    async (name, value) => {
      vi.stubEnv(name, value);
      const { options, drop, dropEntry } = await loadIndex();
      expect(dropEntry).toBeDefined();
      expect(dropEntry).not.toBe(drop);
      expect(runSetup(options)).toMatchObject({
        code: JsonRpcErrorCode.ConfigurationError,
        message: expect.stringContaining(`${name} (`),
      });
      expect(initChemblServiceMock).not.toHaveBeenCalled();
    },
  );

  it('registers the raw drop definition when CHEMBL_DATAFRAME_DROP_ENABLED=true', async () => {
    vi.stubEnv('CHEMBL_DATAFRAME_DROP_ENABLED', 'true');
    const { options, drop, dropEntry } = await loadIndex();
    expect(dropEntry).toBe(drop);
    expect(options.tools).toHaveLength(8);
    expect(runSetup(options)).toBeUndefined();
  });

  it('parses inside setup() and hands that config to initChemblService', async () => {
    vi.stubEnv('CHEMBL_API_BASE_URL', 'https://mirror.example/at-import');
    const { options, getServerConfig } = await loadIndex();
    // A value that changes after import still reaches the service: nothing parsed it yet.
    vi.stubEnv('CHEMBL_API_BASE_URL', 'https://mirror.example/at-setup');
    expect(runSetup(options)).toBeUndefined();
    expect(initChemblServiceMock).toHaveBeenCalledTimes(1);
    const config = initChemblServiceMock.mock.calls[0]?.[0];
    expect(config).toBe(getServerConfig());
    expect(config).toMatchObject({ apiBaseUrl: 'https://mirror.example/at-setup' });
  });

  it.each([
    ['empty', () => ''],
    ['an unsubstituted placeholder', placeholder],
  ])('starts on defaults with every server variable %s', async (_label, valueFor) => {
    for (const name of SERVER_VARS) vi.stubEnv(name, valueFor(name));
    const { options, drop, dropEntry } = await loadIndex();
    expect(dropEntry).not.toBe(drop);
    expect(runSetup(options)).toBeUndefined();
    expect(initChemblServiceMock.mock.calls[0]?.[0]).toEqual({
      apiBaseUrl: 'https://www.ebi.ac.uk/chembl/api/data',
      requestTimeoutMs: 30_000,
      maxPageSize: 1000,
      defaultLimit: 25,
      maxSpillRows: 50_000,
      maxConcurrentPages: 4,
      spillDeadlineMs: 45_000,
      dataframeDropEnabled: false,
    });
  });

  it.each([
    ['CHEMBL_MAX_CONCURRENT_PAGES', '1', { maxConcurrentPages: 1 }],
    ['CHEMBL_MAX_CONCURRENT_PAGES', '6', { maxConcurrentPages: 6 }],
    ['CHEMBL_SPILL_DEADLINE_MS', '10000', { spillDeadlineMs: 10_000 }],
    ['CHEMBL_SPILL_DEADLINE_MS', '600000', { spillDeadlineMs: 600_000 }],
  ])('accepts the in-range bound %s=%s', async (name, value, parsed) => {
    vi.stubEnv(name, value);
    const { options } = await loadIndex();
    expect(runSetup(options)).toBeUndefined();
    expect(initChemblServiceMock.mock.calls[0]?.[0]).toMatchObject(parsed);
  });
});
