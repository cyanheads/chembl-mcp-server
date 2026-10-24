# Developer Protocol

**Server:** chembl-mcp-server
**Version:** 0.4.0
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.15`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.3.1
**Zod:** ^4.6.7

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## Server surface

ChEMBL drug-discovery data over the EBI REST API (`https://www.ebi.ac.uk/chembl/api/data`) — keyless, read-only. The curated compound ↔ target ↔ bioactivity link, plus drug mechanisms and indications.

**Tools** (`src/mcp-server/tools/definitions/`):

| Tool | Purpose |
|:-----|:--------|
| `chembl_search_molecules` | Discovery entry point — find compounds by name / ChEMBL ID / InChIKey, or structure search (exact / similarity / substructure) from a SMILES; every row names its family `parent_chembl_id`; a total at ChEMBL's name (10,000) or substructure (30,000) search ceiling comes back `totalCountCapped`; an unparseable similarity or substructure SMILES fails fast as `invalid_structure` |
| `chembl_search_targets` | Resolve a protein / gene / UniProt accession to the ChEMBL target ID `chembl_get_bioactivities` needs |
| `chembl_get_bioactivities` | Flagship compound↔target bridge — bioactivity measurements for a molecule, a target, or both (which narrows to that compound–target pair); `include_alternate_forms` widens the molecule to its family by parent; `variant` keeps wild-type measurements or one recorded mutant; `potency_view` picks the measurements with a derivable `pchembl_value` (default) or exactly those without one; large sets spill to a per-view DataCanvas table SQL'd via `chembl_dataframe_query`; whenever a call stages nothing (canvas off, or an inline fit with no `canvas_id`), `cursor` / `nextCursor` page through the view, and a cursor page never stages |
| `chembl_get_drug_info` | Drug pharmacology — mechanism(s) of action, target(s), first-approval year, clinical indications, read across the molecule's family (the parent its record resolves to, and that parent's salts and alternate forms) |
| `chembl_get_assay` | Assay provenance behind a bioactivity row — type, target, organism, 1–9 confidence score |
| `chembl_dataframe_query` | Read-only SQL SELECT over the staged bioactivity rows (canvas) |
| `chembl_dataframe_describe` | List tables/columns staged on a canvas before querying |
| `chembl_dataframe_drop` | Drop a staged table early. Opt-in behind `CHEMBL_DATAFRAME_DROP_ENABLED`; wrapped in `disabledTool()` when off, so it carries the enable hint in the manifest while staying absent from `tools/list` |

**Resources** (`src/mcp-server/resources/definitions/`): `chembl://molecule/{chemblId}` and `chembl://target/{chemblId}` — injectable-context mirrors of the per-record fetch.

**Service** (`src/services/chembl/chembl-service.ts`): the single upstream client. Builds Django-style filtered `.json` URLs, walks a bioactivity view by offset on a total order (`-pchembl_value` then `activity_id`, or `activity_id` alone for the null-potency view — never `page_meta.next`), asks every activity page for only the fields `normalizeActivity` reads (`only=` from `ACTIVITY_FIELDS`, derived from a field set that `satisfies` ties to `RawActivity` both ways, with a test that the list equals the keys `normalizeActivity` reads — ChEMBL drops an unknown name silently, so a new field goes in the type, the set, and the normalizer or the typecheck or test fails), coerces string numerics → `number | null` at the boundary (absent → `null`, never `0` — the scientific-fidelity rule), flattens nested upstream structures into the flat domain types in `types.ts`. Every fetch routes through `fetchJson`, which wraps the framework HTTP utility in `withRetry` under the call's one deadline (`CallDeadline`), started at each public method's entry or passed in by a caller chaining methods: 45 s (`CALL_DEADLINE_MS`) by default, or `CHEMBL_SPILL_DEADLINE_MS` (default 45 s) for a canvas-on `chembl_get_bioactivities` call without a cursor. At the defaults every request of a call — chained, concurrent, or retried — settles before an MCP client's 60 s timeout. The bioactivity spill walks its pages concurrently, in offset order, through one service-wide `createPacer({ maxConcurrent })`, so one spill whose pages hang can hold every slot until each attempt's timeout or its deadline, and a concurrent spill waits behind it (an accepted limitation, `docs/design.md` § Known Limitations).

**Security invariant — upstream errors are sanitized at `fetchJson`.** The framework's `fetchWithTimeout` throws status-mapped `McpError` values with upstream diagnostics such as response bodies. `McpError.data` reaches the client verbatim. `fetchJson` rethrows clean domain errors through `sanitizeUpstreamError`, preserving only a reason and recovery hint; the raw error stays on `cause`. Every upstream tool and resource declares the service's non-baseline `not_found` and `rate_limited` reasons with `thrownBy: 'service'`. Never bypass this boundary with a direct fetch from a handler. Regression coverage lives in `tests/services/chembl-service-fetch.test.ts`.

**Canvas:** `chembl_get_bioactivities` spills large rowsets to a DataCanvas table under `CANVAS_PROVIDER_TYPE=duckdb`, the default `src/index.ts` sets (§ Server identity and instructions) — one per `potency_view` (`bioactivities` / `bioactivities_null_potency`), so both can coexist on one canvas and `UNION ALL` back into the honest full set; under `none` it inlines a page that `nextCursor` continues, and the `chembl_dataframe_*` tools return a `canvas_disabled` error. A canvas is minted only when a view spills: without a `canvas_id`, `spillover()` gets a stand-in that acquires on its first `registerTable` and releases the canvas if that registration fails, so an inline fit, a zero match, an upstream failure, or a cancellation holds no tenant slot (remove the stand-in once cyanheads/mcp-ts-core#501 ships). A supplied `canvas_id` is never released, and every non-cursor call re-stages the selected view's table on it — inline fits and zero matches included — so the table always holds the latest successful call's rows. A spill onto a supplied canvas registers under a per-call `<view table>_staging_<hex>` table and replaces the view's table only once it succeeds: drop the table, copy the staging table in with `query('SELECT * FROM <staging>', { registerAs })` (which refuses an existing name rather than replacing it), drop the staging table. The swap takes no signal, every write to a supplied canvas's view table (the swap, and the inline-fit or zero-match re-stage) takes its turn on it, and a spill that fails or is cancelled leaves the earlier table. A `cursor` call is always served inline: it acquires no canvas and leaves a supplied `canvas_id` untouched. A canvas-on inline fit with no `canvas_id` stages nothing either, so it mints `nextCursor` as the canvas-off page does. The spill passes `caps: { maxRows: config.maxSpillRows }`, and the walk requests no page at or past the cap or the view total; `CHEMBL_SPILL_DEADLINE_MS` bounds its count and walk together, and at expiry the fetched prefix stages; a page whose retries the budget stops short (`retry_deadline_exceeded` on the sanitized error's `cause`) counts as expiry, and so does a walk that stops starting pages once the budget left would not hold another (timed by the latest page to land, on its final attempt), ending after the pages in flight. A table either bound cut short reports `truncated: true`, `staged_row_count`, and `truncated_by` (`row_cap` / `time_budget`) on both response surfaces rather than passing itself off as complete; `row_cap` means the registered rows reached the cap, and a walk that ends on a short page below it names no bound. `getCanvas()` (`src/services/canvas-accessor.ts`) returns the framework-wired canvas or `undefined`. Both views pass an explicit canvas schema: `standard_value` and `pchembl_value` are nullable `DOUBLE` columns, `activity_id` is `BIGINT`, `document_year` is a nullable `INTEGER`, and text fields stay `VARCHAR`. Never infer these types from preview rows; sparse or integer-only previews can silently narrow later fractional measurements.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters. The exceptions are canvas plumbing: re-raising a framework canvas failure whose throw-site recovery hint the calling tool cannot follow (`chembl_dataframe_drop`, and `chembl_get_bioactivities` at its canvas mint, which also releases a canvas whose spill failed before rethrowing; `docs/design.md` § Error Contract), and `chembl_get_bioactivities`'s writes to a supplied canvas, which drop a spill's staging table whatever the outcome (logging a failed drop) and pass over an earlier write's failure when taking their turn on the view table.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

Real shape, condensed from `chembl-get-assay.tool.ts` (a keyless read-only tool — no `auth` scope; every field `.describe()`d; numeric fields nullable to honor upstream absence):

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { chemblIdInput } from '@/mcp-server/input-normalization.js';
import { getChemblService } from '@/services/chembl/chembl-service.js';

export const chemblGetAssay = tool('chembl_get_assay', {
  title: 'chembl-get-assay',                    // display identity = the hyphenated repo name
  description: 'Assay provenance behind a bioactivity row: type, target, organism, 1–9 confidence score.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    // Parses any case and surrounding whitespace to the canonical ID; the advertised
    // pattern spells those variants out, since JSON Schema `pattern` takes no flags.
    assay_chembl_id: chemblIdInput('Must be a ChEMBL assay ID like CHEMBL674637 — …')
      .describe("ChEMBL assay ID, e.g. \"CHEMBL674637\"."),
  }),
  output: z.object({
    assay_chembl_id: z.string().describe('The ChEMBL assay ID queried.'),
    confidence_score: z.number().nullable().describe('ChEMBL confidence score, 1–9. Null when unscored.'),
    // …remaining fields
  }),

  // Service throws sanitized domain errors; the handler stays a thin pure call.
  async handler(input, ctx) {
    return await getChemblService().getAssay(input.assay_chembl_id, ctx);
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
import { chemblIdInput } from '@/mcp-server/input-normalization.js';
import { getChemblService } from '@/services/chembl/chembl-service.js';

export const chemblMoleculeResource = resource('chembl://molecule/{chemblId}', {
  name: 'chembl-molecule',
  title: 'chembl-molecule',
  description: 'A molecule record by ChEMBL ID — the chembl_search_molecules row shape.',
  mimeType: 'application/json',
  params: z.object({
    chemblId: chemblIdInput('Must be a ChEMBL ID like CHEMBL25 — …').describe('ChEMBL molecule ID.'),
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
    .describe('Base URL for the ChEMBL REST data API. Override for a private mirror or pinned host.'),
  requestTimeoutMs: z.coerce.number().int().positive().default(30_000),
  maxPageSize: z.coerce.number().int().positive().max(1000).default(1000),
  defaultLimit: z.coerce.number().int().positive().default(25),
  maxSpillRows: z.coerce.number().int().positive().default(50_000),
  maxConcurrentPages: z.coerce.number().int().min(1).max(6).default(4),
  spillDeadlineMs: z.coerce.number().int().min(10_000).max(600_000).default(45_000),
  dataframeDropEnabled: z.stringbool().default(false),
});

const ENV_VARS = {
  apiBaseUrl: 'CHEMBL_API_BASE_URL',
  requestTimeoutMs: 'CHEMBL_REQUEST_TIMEOUT_MS',
  maxPageSize: 'CHEMBL_MAX_PAGE_SIZE',
  defaultLimit: 'CHEMBL_DEFAULT_LIMIT',
  maxSpillRows: 'CHEMBL_MAX_SPILL_ROWS',
  maxConcurrentPages: 'CHEMBL_MAX_CONCURRENT_PAGES',
  spillDeadlineMs: 'CHEMBL_SPILL_DEADLINE_MS',
  dataframeDropEnabled: 'CHEMBL_DATAFRAME_DROP_ENABLED',
} as const;

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, ENV_VARS);
  return _config;
}

// The drop flag alone, never throwing — for the registration gate at module load.
export function isDataframeDropEnabled(): boolean {
  const flag = ServerConfigSchema.shape.dataframeDropEnabled.safeParse(
    process.env[ENV_VARS.dataframeDropEnabled],
  );
  return flag.success && flag.data;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`CHEMBL_REQUEST_TIMEOUT_MS`) not the path (`requestTimeoutMs`). It throws `ConfigurationError`, and `src/index.ts` calls `getServerConfig()` inside `setup()`, where the framework prints it as a clean startup banner and exits 1. Never call it at module load: an invalid value there escapes as a raw stack before `createApp()` runs. The drop tool's registration form is chosen at module load, so `index.ts` reads that one flag through `isDataframeDropEnabled()`, which never throws — an invalid value reads as off there and fails the `setup()` parse.

For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment. `z.stringbool()` parses `true/false/1/0/yes/no/on/off/y/n/enabled/disabled` (case-insensitive) and rejects anything else, so `=false` actually disables.

### Server identity and instructions

`createApp()` accepts optional identity fields forwarded to the SDK's `initialize` response and the server manifest (`/.well-known/mcp.json`):

Real shape — `src/index.ts`. **`title` is the hyphenated repo name** (`chembl-mcp-server`), never a Title-Case display name — humans and agents both see the machine identity. The identity block is `name` + `title` only — don't add `description` or `websiteUrl` (`description` derives from `package.json`, the canonical source):

```ts
parseConfig();                                             // loads .env first, so a .env value wins
process.env.CANVAS_PROVIDER_TYPE ||= 'duckdb';             // DataCanvas on unless set to none
resetConfig();                                             // the framework logger parsed config at import; drop that cache

await createApp({
  name: 'chembl-mcp-server',
  title: 'chembl-mcp-server',                              // display identity = repo name
  instructions: '…canonical cross-server chains + the pchembl_value-by-standard_type ranking trap + CC BY-SA attribution…',
  sessionMode: 'stateless',                                // no ctx.requestInput surface
  tools,
  resources: [chemblMoleculeResource, chemblTargetResource],
  setup(core) {
    initChemblService(getServerConfig());                  // parse here, so a bad value reaches the banner
    setCanvas(core.canvas);
  },
});
```

`instructions` is optional server-level orientation, sent on every `initialize` as session-level context. Here it carries the canonical cross-server chains (UniProt → `chembl_search_targets` → `chembl_get_bioactivities`), the ranking trap (`pchembl_value` is comparable only within one `standard_type`), the coverage trap (measurements without a `pchembl_value` sit in the `null_potency` view), the salt trap (a drug's measurements split across its alternate forms), and the ChEMBL CC BY-SA attribution — instead of repeating that context across tool descriptions.

### Session posture and shutdown

`sessionMode` declares the HTTP session posture in `src/` rather than leaving it to a deployment's `MCP_SESSION_MODE`, which still wins whenever it carries a meaningful value (an empty string and an unsubstituted `${…}` placeholder read as unset and fall through to the option). This server declares `stateless`: no tool or resource calls `ctx.requestInput`, so nothing needs a durable session to answer a mid-handler prompt, and a source run, a container, and `.env.example` all resolve alike. `require: 'stateful'` belongs on a server whose tools *do* gate on `ctx.requestInput` — there is nothing here to guard.

**No `teardown` hook, deliberately.** `teardown(core)` is the `setup()` counterpart for releasing what setup allocated — a watcher, a socket, a non-`unref()`'d timer. `setup()` here constructs the `ChemblService` (config values and a page pacer that sets only `maxConcurrent`, so it arms no timer — no handles) and stores a reference to `core.canvas`, which the framework owns and shuts down itself. Nothing is left to release, and an empty hook is ceremony, not adoption.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.getMany(keys)`, `.list(prefix, { cursor, limit })`. Accepts any JSON-serializable value; reads return its JSON form (a `Date` comes back as an ISO string). |
| `ctx.requestInput` | Suspend and ask the caller for more input — `return ctx.requestInput({ inputRequests: { key: inputRequired.elicit({ message, requestedSchema }) } })`. Never returns; the handler is re-entered with the answers. Always present. |
| `ctx.inputs` | The request's responses — `.accepted(key, schema)`, `.view(key)`, `.state()`, `.dropped` — limited to what the client declared (`elicitation` and its form/url modes, `sampling`, `roots`). Client-supplied: a consent gate trusts only a `ctx.state` record it stored when it asked, bound to the operation, caller, and target (see the `api-context` skill). |
| `ctx.clientCapabilities` | What the client declared for this request, `undefined` when no view exists. Decides whether to ask for optional context (e.g. roots); never a reason to skip a consent prompt. |
| `ctx.enrich` | Success-path agent context (empty-result notices, query echo, pagination totals) — `ctx.enrich(...)` or `.notice()` / `.total()` / `.echo()` / `.truncated()`. Reaches `structuredContent` and `content[]`; lands only when the definition declares an `enrichment` block (no-op otherwise). |
| `ctx.content` | Non-text content blocks — `.image(data, mimeType)`, `.audio(data, mimeType)`, or `ctx.content(block)` for a raw block. Prepended to `content[]` after `format()`; never enters `structuredContent`. |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.requestId` | Request ID — the one every log record of the call carries and its error envelope returns as `data.requestId`. |
| `ctx.tenantId` | Tenant ID from JWT; `'default'` for stdio or HTTP with auth off. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required (≥ 5 words, lint-validated) — the single source of truth for the agent's next move. The framework puts it on the wire whenever a failure carrying that `reason` arrives without a hint — a bare `ctx.fail('reason')` or a service throw with `data: { reason }` — as `data.recovery.hint`, mirrored into `content[]` text unless the message already contains it verbatim; override with an explicit `{ recovery: { hint: '...' } }` when dynamic runtime context matters. Every error envelope also carries `data.requestId`, the id the server's log records for that call carry, and `content[]` closes with `(reason … · request <id>)`. Mark an entry the service layer throws with `thrownBy: 'service'` so `error-contract-unthrown` skips it — lint-only metadata, nothing at runtime reads it. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

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
throw new McpError(JsonRpcErrorCode.InitializationFailed, 'Connection failed', { pool: 'primary' });
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
    input-normalization.ts              # Shared input-edge parsing: ChEMBL IDs, molecule refs, assay_type, codes, limit clamp
    markdown-text.ts                    # The format() escape: upstream strings render inert in content[] (mdInline / mdLineStart)
    tools/definitions/
      chembl-search-molecules.tool.ts   # …and 7 more (search-targets, get-bioactivities, get-drug-info,
      …                                 #   get-assay, dataframe-query, dataframe-describe, dataframe-drop)
    resources/definitions/
      chembl-molecule.resource.ts       # chembl://molecule/{chemblId}
      chembl-target.resource.ts         # chembl://target/{chemblId}
tests/                                  # Vitest — services/, tools/, resources/, mcp-server/ (no prompts)
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

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, and this server ships `.claude-plugin/` and `.codex-plugin/`, so that name would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

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
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity (run by devcheck) |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |

**CI is one file.** `.github/workflows/codeql.yml` is the only GitHub Actions workflow this repo carries: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. This server uses DataCanvas, so it ships a portable bundle without the DuckDB native. `@duckdb/node-api` is a direct dependency, not an optional peer, but with its native binding stripped the canvas cannot start: under `CANVAS_PROVIDER_TYPE=duckdb` every `chembl_get_bioactivities` call whose view spills fails with `-32008` (`Install "@duckdb/node-api"…`) while inline fits and cursor pages still answer, and no canvas is ever staged for the `chembl_dataframe_*` tools to read. The bundle therefore runs canvas-off: `manifest.json` fixes `CANVAS_PROVIDER_TYPE` to `"none"` in `mcp_config.env`, overriding the server's `duckdb` default, and leaves the canvas-only options out of `user_config`: `CANVAS_PROVIDER_TYPE` itself, `CHEMBL_DATAFRAME_DROP_ENABLED` (it only registers a tool that needs a canvas), `CHEMBL_MAX_SPILL_ROWS` (it bounds only what a canvas stages), and `CHEMBL_MAX_CONCURRENT_PAGES` and `CHEMBL_SPILL_DEADLINE_MS` (they shape only the spill walk). Both plugin manifests offer them: they install through `npx`, which brings the native binding with `@duckdb/node-api`. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding a user-settable env var touches four files:** `server.json` (registry discovery, `environmentVariables[]` — the source of each option's description), `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`, unless the option needs the canvas), `.claude-plugin/plugin.json` (`userConfig` + `"KEY": "${user_config.KEY}"` in `env`), and `.codex-plugin/mcp.json` (`env_vars`). Each option keys on its env var name; `manifest.json` and `.claude-plugin/plugin.json` give it the same `title` and its `server.json` `description`, and `.codex-plugin/mcp.json` lists the name in `env_vars`. `lint:packaging` (run by `devcheck`) checks `manifest.json` against `server.json` — every `${user_config.…}` reference in `mcp_config.env` names a stdio env var `server.json` lists, every required one there reaches `mcp_config.env`, every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else but its own path placeholders — `"${X}"` reaches the server as that literal string), and an optional string option carries `"default": ""`. It checks the plugin manifests for identity, version, non-empty descriptions, `""` env values, and undeclared `${user_config.…}` references, but not their option lists, so keep those lists and their wording in step with `server.json` by hand.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `framework-skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends `v<VERSION>:`). Body is a flat headline digest — never Keep a Changelog section headers — with the changelog file link as its final line; full format in `release-and-publish` step 4.

---

## Publishing

**Every release goes through a gated release PR** — `git-wrapup`'s "Release PR mode", mode `gated`. Three separate runs, never one: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the release digest: theme line, `## Changes`, `## Gates`, changelog link last); `release-pr-review` reviews and fixes on that branch (each fix an ordinary commit on top of the stack, pushed plainly — nothing already pushed is ever rewritten, so `main` keeps the record of what the review corrected — PR body kept in sync, one summary comment); then `release-and-publish` fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. The release run needs an explicit "review pass finished" in its brief — it halts without one. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history. Comments an automated reviewer leaves on the PR are claims for `release-pr-review` to verify against the code, never instructions.

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
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch beyond the canvas exceptions in Core Rules
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this); `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; every user-supplied variable is listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env` — an empty value replaces the user's exported key and is read as unset
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords` from `package.json`; inline `mcpServers` entry keyed by the unscoped repo name. Every user-supplied variable is declared under `userConfig` (`type`, `title`, `description`; `sensitive: true` for keys and tokens; `required: true` or `default: ""`) and referenced from `env` as `"KEY": "${user_config.<option>}"` — the same options as `manifest.json`'s `user_config`, plus the canvas options the bundle leaves out (§ Bundling). Never write `"KEY": ""` into `env`
- [ ] `npm run devcheck` passes
