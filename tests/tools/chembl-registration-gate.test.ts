/**
 * @fileoverview Tests for the chembl_dataframe_drop registration gate. The drop
 * tool is opt-in behind CHEMBL_DATAFRAME_DROP_ENABLED (z.stringbool, so
 * "=false" actually disables). When the flag is off it is wrapped with
 * disabledTool(), which keeps it in the server manifest with the enable hint
 * while the registry skips it — so it stays absent from tools/list. Two layers
 * are verified: the env-var → boolean parse (including the stringbool
 * semantics), and the gate index.ts applies — the raw definition when the flag
 * is on, the wrapped one when off, with the eight-tool manifest constant either
 * way and the seven always-on tools untouched.
 * @module tests/tools/chembl-registration-gate
 */

import { disabledTool, z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chemblDataframeDescribe } from '@/mcp-server/tools/definitions/chembl-dataframe-describe.tool.js';
import { chemblDataframeDrop } from '@/mcp-server/tools/definitions/chembl-dataframe-drop.tool.js';
import { chemblDataframeQuery } from '@/mcp-server/tools/definitions/chembl-dataframe-query.tool.js';
import { chemblGetAssay } from '@/mcp-server/tools/definitions/chembl-get-assay.tool.js';
import { chemblGetBioactivities } from '@/mcp-server/tools/definitions/chembl-get-bioactivities.tool.js';
import { chemblGetDrugInfo } from '@/mcp-server/tools/definitions/chembl-get-drug-info.tool.js';
import { chemblSearchMolecules } from '@/mcp-server/tools/definitions/chembl-search-molecules.tool.js';
import { chemblSearchTargets } from '@/mcp-server/tools/definitions/chembl-search-targets.tool.js';

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
