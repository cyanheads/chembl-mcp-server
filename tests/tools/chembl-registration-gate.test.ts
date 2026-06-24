/**
 * @fileoverview Tests for the chembl_dataframe_drop conditional-registration gate.
 * The drop tool is opt-in behind CHEMBL_DATAFRAME_DROP_ENABLED (z.stringbool, so
 * "=false" actually disables) and conditionally registered — absent from
 * tools/list when off. Two layers are verified: the env-var → boolean parse
 * (including the stringbool semantics), and the registration predicate
 * index.ts uses (`config.dataframeDropEnabled ? [drop] : []`) — drop appears iff
 * the flag is on, while the seven always-on tools are always present.
 * @module tests/tools/chembl-registration-gate
 */

import { z } from '@cyanheads/mcp-ts-core';
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

/** The conditional-registration predicate index.ts applies. */
function registeredTools(dataframeDropEnabled: boolean) {
  return [...ALWAYS_ON, ...(dataframeDropEnabled ? [chemblDataframeDrop] : [])];
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

describe('chembl_dataframe_drop — conditional registration', () => {
  it('omits the drop tool from tools/list when the flag is off', () => {
    const names = registeredTools(false).map((t) => t.name);
    expect(names).not.toContain('chembl_dataframe_drop');
    expect(names).toHaveLength(7);
  });

  it('includes the drop tool when the flag is on', () => {
    const names = registeredTools(true).map((t) => t.name);
    expect(names).toContain('chembl_dataframe_drop');
    expect(names).toHaveLength(8);
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
