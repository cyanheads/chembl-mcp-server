/**
 * @fileoverview Preserve executable skill modules while removing dependency agent
 * documentation from a built `.mcpb`. Covers the package-root `AGENT_DOC_ENTRY`
 * selector shared by `scripts/clean-mcpb.ts` and `scripts/lint-packaging.ts`
 * (cyanheads/mcp-ts-core#794): the MCP SDK's `dist/ext/skills/` runtime must
 * survive cleaning, and both scripts must select the same entries. The framework
 * pins the pair only in its own test suite, so this server's copies are pinned here.
 * @module tests/scripts/bundle-agent-docs.test
 */

import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY as lintAgentDocEntry } from '../../scripts/lint-packaging.js';

describe('bundle agent documentation selection', () => {
  it.each([
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    'node_modules/service/node_modules/@modelcontextprotocol/server/dist/ext/skills/node.cjs',
    'node_modules/service/dist/skills/runtime.js',
    'skills/chembl-guide/SKILL.md',
  ])('retains runtime or published skill path %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([]);
    expect(lintAgentDocEntry.test(entry)).toBe(false);
  });

  it.each([
    'node_modules/example/skills/example-guide/SKILL.md',
    'node_modules/@vendor/example/skills/example-guide/references/query.md',
    'node_modules/example/framework-skills/add-tool/SKILL.md',
    'node_modules/example/.claude/settings.json',
    'node_modules/example/.agents/skills/guide/SKILL.md',
    'node_modules/example/node_modules/nested/skills/guide/references/query.md',
    'node_modules/@vendor/example/node_modules/@nested/package/skills/guide/reference.md',
    'node_modules/example/docs/SKILL.md',
  ])('removes dependency agent documentation %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([entry]);
    expect(lintAgentDocEntry.test(entry)).toBe(true);
  });
});
