# Developer Protocol

**Server:** chembl-mcp-server
**Version:** 0.1.1
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.10.9`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/sdk` ^1.29.0
**Zod:** ^4.4.3

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## Server surface

ChEMBL drug-discovery data over the EBI REST API (`https://www.ebi.ac.uk/chembl/api/data`) — keyless, read-only. The curated compound ↔ target ↔ bioactivity link, plus drug mechanisms and indications.

**Tools** (`src/mcp-server/tools/definitions/`):

| Tool | Purpose |
|:-----|:--------|
| `chembl_search_molecules` | Discovery entry point — find compounds by name / ChEMBL ID / InChIKey, or structure search (exact / similarity / substructure) from a SMILES |
| `chembl_search_targets` | Resolve a protein / gene / UniProt accession to the ChEMBL target ID `chembl_get_bioactivities` needs |
| `chembl_get_bioactivities` | Flagship compound↔target bridge — bioactivity measurements for a molecule OR a target; large sets spill to a DataCanvas table SQL'd via `chembl_dataframe_query` |
| `chembl_get_drug_info` | Drug pharmacology — mechanism(s) of action, target(s), first-approval year, clinical indications |
| `chembl_get_assay` | Assay provenance behind a bioactivity row — type, target, organism, 1–9 confidence score |
| `chembl_dataframe_query` | Read-only SQL SELECT over the spilled bioactivity rows (canvas) |
| `chembl_dataframe_describe` | List tables/columns staged on a canvas before querying |
| `chembl_dataframe_drop` | Drop a staged table early. Opt-in behind `CHEMBL_DATAFRAME_DROP_ENABLED`; conditionally registered, so absent from `tools/list` when off |

**Resources** (`src/mcp-server/resources/definitions/`): `chembl://molecule/{chemblId}` and `chembl://target/{chemblId}` — injectable-context mirrors of the per-record fetch.

**Service** (`src/services/chembl/chembl-service.ts`): the single upstream client. Builds Django-style filtered `.json` URLs, paginates `page_meta`, coerces string numerics → `number | null` at the boundary (absent → `null`, never `0` — the scientific-fidelity rule), flattens nested upstream structures into the flat domain types in `types.ts`. Every fetch routes through `fetchJson`, which wraps the framework HTTP utility in `withRetry`.

**Security invariant — upstream errors are sanitized at `fetchJson`.** The framework's `fetchWithTimeout` throws a status-mapped `McpError` whose `data` carries raw upstream internals (`statusCode`, `responseBody`, `requestId`, the internal URL), and the framework ships `McpError.data` verbatim to the client. `fetchJson`'s catch calls `sanitizeUpstreamError`, which detects the framework error STRUCTURALLY by `err.code` (never by message string) and re-throws a clean domain error (`notFound` / `validationError` / `timeout` / `rateLimited` / `serviceUnavailable`) whose `data` is leak-free (`reason` + recovery `hint`); the raw error rides as `cause` for server-side logs only. This is the single chokepoint for all eight tools and both resources — never bypass it by calling `fetchWithTimeout` directly from a handler. Regression-tested in `tests/services/chembl-service-fetch.test.ts`.

**Canvas:** `chembl_get_bioactivities` spills large rowsets to a DataCanvas table (`bioactivities`) when `CANVAS_PROVIDER_TYPE=duckdb`; otherwise it inlines a preview and the `chembl_dataframe_*` tools return a `canvas_disabled` error. `getCanvas()` (`src/services/canvas-accessor.ts`) returns the framework-wired canvas or `undefined`.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

Real shape, condensed from `chembl-get-assay.tool.ts` (a keyless read-only tool — no `auth` scope; every field `.describe()`d; numeric fields nullable to honor upstream absence):

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getChemblService } from '@/services/chembl/chembl-service.js';

export const chemblGetAssay = tool('chembl_get_assay', {
  title: 'chembl-get-assay',                    // display identity = the hyphenated repo name
  description: 'Assay provenance behind a bioactivity row: type, target, organism, 1–9 confidence score.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    assay_chembl_id: z.string().min(1).describe("ChEMBL assay ID, e.g. \"CHEMBL674637\"."),
  }),
  output: z.object({
    assay_chembl_id: z.string().describe('The ChEMBL assay ID queried.'),
    confidence_score: z.number().nullable().describe('ChEMBL confidence score, 1–9. Null when unscored.'),
    // …remaining fields
  }),

  // Service throws sanitized domain errors; the handler stays a thin pure call.
  async handler(input, ctx) {
    return await getChemblService().getAssay(input.assay_chembl_id.trim(), ctx);
  },

  // format() populates content[] — the markdown twin of structuredContent.
  // Different clients read different surfaces (Claude Code → structuredContent,
  // Claude Desktop → content[]); both must carry the same data.
  // Enforced at lint time: every field in `output` must appear in the rendered text.
  format: (result) => [{ type: 'text', text: `**${result.assay_chembl_id}** — confidence ${result.confidence_score ?? '—'}` }],
});
```

### Resource

Real shape — `chembl-molecule.resource.ts`. The handler is a thin pass-through to the service; a 404 surfaces as the sanitized `notFound` from `fetchJson`, so no per-resource error handling is needed:

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { getChemblService } from '@/services/chembl/chembl-service.js';

export const chemblMoleculeResource = resource('chembl://molecule/{chemblId}', {
  name: 'chembl-molecule',
  title: 'chembl-molecule',
  description: 'A molecule record by ChEMBL ID — the chembl_search_molecules row shape.',
  mimeType: 'application/json',
  params: z.object({
    chemblId: z.string().regex(/^CHEMBL\d+$/, 'Must be a ChEMBL ID like CHEMBL25.').describe('ChEMBL molecule ID.'),
  }),
  handler(params, ctx) {
    return getChemblService().getMolecule(params.chemblId, ctx);
  },
  examples: [{ name: 'Aspirin', uri: 'chembl://molecule/CHEMBL25' }],
});
```

This server defines **no prompts**.

### Server config

Real shape — `src/config/server-config.ts`. ChEMBL is **keyless**, so there is no API-key field and no degraded-without-key mode; the only server-owned env vars are the upstream tuning knobs + the opt-in dataframe-drop toggle (the SQL path is gated by the framework's `CANVAS_PROVIDER_TYPE`, not a server-config field):

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiBaseUrl: z.string().default('https://www.ebi.ac.uk/chembl/api/data')
    .describe('Base URL for the ChEMBL REST data API. Override for a private mirror.'),
  requestTimeoutMs: z.coerce.number().int().positive().default(30_000),
  maxPageSize: z.coerce.number().int().positive().max(1000).default(1000),
  defaultLimit: z.coerce.number().int().positive().default(25),
  dataframeDropEnabled: z.stringbool().default(false),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiBaseUrl: 'CHEMBL_API_BASE_URL',
    requestTimeoutMs: 'CHEMBL_REQUEST_TIMEOUT_MS',
    maxPageSize: 'CHEMBL_MAX_PAGE_SIZE',
    defaultLimit: 'CHEMBL_DEFAULT_LIMIT',
    dataframeDropEnabled: 'CHEMBL_DATAFRAME_DROP_ENABLED',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`CHEMBL_REQUEST_TIMEOUT_MS`) not the path (`requestTimeoutMs`). Throws `ConfigurationError`, which the framework prints as a clean startup banner.

For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment. `z.stringbool()` parses `true/false/1/0/yes/no/on/off` and rejects anything else, so `=false` actually disables.

### Server identity and instructions

`createApp()` accepts optional identity fields forwarded to the SDK's `initialize` response and the server manifest (`/.well-known/mcp.json`):

Real shape — `src/index.ts`. **`title` is the hyphenated repo name** (`chembl-mcp-server`), never a Title-Case display name — humans and agents both see the machine identity. The identity block is `name` + `title` only — don't add `description` or `websiteUrl` (`description` derives from `package.json`, the canonical source):

```ts
await createApp({
  name: 'chembl-mcp-server',
  title: 'chembl-mcp-server',                              // display identity = repo name
  instructions: '…canonical cross-server chains + the pchembl_value-by-standard_type ranking trap + CC BY-SA attribution…',
  tools,
  resources: [chemblMoleculeResource, chemblTargetResource],
  setup(core) {
    initChemblService(config);
    setCanvas(core.canvas);
  },
});
```

`instructions` is optional server-level orientation, sent on every `initialize` as session-level context. Here it carries the canonical cross-server chains (UniProt → `chembl_search_targets` → `chembl_get_bioactivities`), the ranking trap (`pchembl_value` is comparable only within one `standard_type`), and the ChEMBL CC BY-SA attribution — instead of repeating that context across tool descriptions.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.elicit` | Ask user for structured input — form call `(message, schema)` or `.url(message, url)` for an external link. **Check for presence first:** `if (ctx.elicit) { ... }` |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.progress` | Task progress (present when `task: true`) — `.setTotal(n)`, `.increment()`, `.update(message)`. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required descriptive metadata for the agent's next move (≥ 5 words, lint-validated); for the wire `data.recovery.hint` (mirrored into `content[]` text), pass explicitly at the throw site when dynamic context matters: `ctx.fail('reason', msg, { recovery: { hint: '...' } })`. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`);
  return item;
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point — registers tools + resources, wires service + canvas
  config/
    server-config.ts                    # ChEMBL env vars (Zod schema, keyless)
  services/
    canvas-accessor.ts                  # Module holder for the optional DataCanvas
    chembl/
      chembl-service.ts                 # Single upstream client + sanitizeUpstreamError (the leak chokepoint)
      types.ts                          # Flat domain types (Molecule, Activity, Target, DrugInfo, Assay, …)
  mcp-server/
    tools/definitions/
      chembl-search-molecules.tool.ts   # …and 7 more (search-targets, get-bioactivities, get-drug-info,
      …                                 #   get-assay, dataframe-query, dataframe-describe, dataframe-drop)
    resources/definitions/
      chembl-molecule.resource.ts       # chembl://molecule/{chemblId}
      chembl-target.resource.ts         # chembl://target/{chemblId}
tests/                                  # Vitest — services/, tools/, resources/ (no prompts)
```

No `prompts/` directory — this server defines no prompts.

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-docs.tool.ts` |
| Tool/resource/prompt names | snake_case | `search_docs` |
| Directories | kebab-case | `src/services/doc-search/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `npm run build` | Compile TypeScript |
| `npm run rebuild` | Clean + build |
| `npm run clean` | Remove build artifacts |
| `npm run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, and re-run `bun audit`. Use when `devcheck` flags a transitive advisory — Bun's `update` is sticky on transitive resolutions, so the advisory may be a stale-lockfile false positive. If it survives the refresh, it's real. |
| `npm run tree` | Generate directory structure doc |
| `npm run format` | Auto-fix formatting (safe fixes only) |
| `npm run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `npm test` | Run tests |
| `npm run start:stdio` | Production mode (stdio) |
| `npm run start:http` | Production mode (HTTP) |
| `npm run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `npm run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `npm run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips dependency-shipped agent docs (`node_modules/**` `skills/`, `.claude/`, `.agents/`, `SKILL.md`) that root-anchored `.mcpbignore` patterns cannot reach. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true flags security fixes
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section. When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order** (Keep a Changelog): Added, Changed, Deprecated, Removed, Fixed, Security. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getMyService } from '@/services/my-domain/my-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `npm run devcheck` passes
