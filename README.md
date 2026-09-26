<div align="center">
  <h1>@cyanheads/chembl-mcp-server</h1>
  <p><b>Link compounds to protein targets, rank bioactivity (IC50/Ki/EC50), and look up drug mechanisms and indications over ChEMBL via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools (+1 opt-in) • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/chembl-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.1.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/chembl-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/chembl-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/chembl-mcp-server/releases/latest/download/chembl-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=chembl-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY2hlbWJsLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22chembl-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fchembl-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://chembl.caseyjhand.com/mcp](https://chembl.caseyjhand.com/mcp)

</div>

---

## Overview

Drug-discovery data over ChEMBL (EBI) — the curated link between compounds, protein targets, and measured bioactivity (IC50/Ki/EC50), plus drug mechanisms and indications. Search compounds by name, ID, or structure, resolve protein targets, rank bioactivity measurements, and look up drug mechanisms and indications from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `chembl_search_molecules` | Find compounds by name / ChEMBL ID / InChIKey, or run a structure search (exact \| similarity \| substructure) from a SMILES. |
| `chembl_get_bioactivities` | The flagship compound↔target bridge: bioactivity measurements for a molecule, a target, or **both** (the compound×target pair), ranked on `pchembl_value`, or the measurements without one via `potency_view`. Large sets spill to a canvas. |
| `chembl_search_targets` | Resolve a protein / gene symbol / UniProt accession to the ChEMBL target ID `chembl_get_bioactivities` needs. |
| `chembl_get_drug_info` | Drug pharmacology — mechanism(s) of action, molecular target(s), action type, first-approval year, and clinical indications. |
| `chembl_get_assay` | Assay provenance behind a bioactivity row — type, target, organism, and ChEMBL's 1–9 confidence score. |
| `chembl_dataframe_query` | Run a read-only SQL `SELECT` over the bioactivity rows spilled to a canvas — rank, group, dedupe, aggregate across the full set. |
| `chembl_dataframe_describe` | List the tables and columns staged on a canvas, so you can write correct SQL before querying. |
| `chembl_dataframe_drop` | Drop a named staged table from a canvas. Opt-in via `CHEMBL_DATAFRAME_DROP_ENABLED=true` — absent from `tools/list` when off, since TTL already reclaims staged tables. |

### Resources

| Resource | Description |
|:---|:---|
| `chembl://molecule/{chemblId}` | A molecule record by ChEMBL ID — the same shape a `chembl_search_molecules` row carries. |
| `chembl://target/{chemblId}` | A target record by ChEMBL target ID — preferred name, type, organism, and component UniProt accessions + gene symbols. |

All resource data is also reachable via the tools, so tool-only MCP clients lose nothing. There are no prompts — the canonical workflows are short tool chains an agent composes directly, and the cross-server chain guidance ships as server-level `instructions` instead.

## Capability reference

### `chembl_search_molecules` <sub>tool</sub>

- Default `search_type=name` matches drug names, synonyms, ChEMBL IDs, and InChIKeys in one query; a query that is exactly a ChEMBL ID or InChIKey routes to ChEMBL's single-record lookup instead of the fuzzy text index (`totalCount: 1`)
- Structure search via `search_type`: `exact`, `similarity` (Tanimoto ≥ `similarity_threshold`, integer 40–100, default 70), or `substructure` — supply `structure` as a SMILES; `max_phase_min` (name search only) restricts to compounds at or above a max clinical phase
- Every row carries `max_phase`, MW, AlogP, Lipinski rule-of-five violations, and QED; only `search_type=similarity` results carry a Tanimoto `similarity` percent — absent, not null, on other modes
- Paginated via `nextCursor` / `cursor`, omitted (not null) on the last page — redeem a cursor with the same filters that minted it
- Chain `molecule_chembl_id` into `chembl_get_bioactivities` or `chembl_get_drug_info`

---

### `chembl_get_bioactivities` <sub>tool</sub>

- Supply at least one of `molecule_chembl_id` or `target_chembl_id`; supplying both narrows to that compound–target pair — neither is a `missing_filter` error
- Filter by `standard_type` (IC50/Ki/EC50/…), `pchembl_value_min`, `assay_type`, `organism`; ranked on `pchembl_value` — comparable only within one `standard_type`
- `potency_view` selects `potency_ranked` (default, measurements with a derivable `pchembl_value`) or `null_potency` (the excluded rows); `pchembl_value_min` with `null_potency` is a `contradictory_potency_filter` error, and `totalCount` spans both views
- Numerics are coerced to `number | null` at the service boundary — a missing potency reads as `null`, never `0`
- Large sets spill to a DataCanvas table per view (`bioactivities` / `bioactivities_null_potency`), capped at `CHEMBL_MAX_SPILL_ROWS` (default 50,000) and reported `truncated: true` + `staged_row_count` when hit; requires `CANVAS_PROVIDER_TYPE=duckdb`
- The inline preview is always capped at `limit` (default 25) regardless of spill status; the optional `canvas_id` reuses a canvas, but re-querying the same view replaces its prior rows

---

### `chembl_search_targets` <sub>tool</sub>

- Supply at least one of `accession` (UniProt, e.g. `P00533`), `gene_symbol`, or `query` (free-text); narrow with `organism` and `target_type` — none supplied is a `missing_input` error
- A UniProt accession is the most precise input — chain it from a `uniprot`/`protein` server
- Each row carries target type, organism, and component UniProt accessions + gene symbols, flattened from ChEMBL's nested component synonyms
- Paginated via `nextCursor` / `cursor`, the same contract as `chembl_search_molecules`
- Chain `target_chembl_id` into `chembl_get_bioactivities`

---

### `chembl_get_drug_info` <sub>tool</sub>

- Supply `molecule_chembl_id`; returns mechanism(s) of action, molecular target(s), action type, first-approval year, and clinical indications with the max phase reached for each
- Mechanisms and indications are fetched with `Promise.allSettled`, so a rejected list degrades to a disclosed partial result rather than failing the call
- Each list carries its own `mechanisms_status` / `indications_status` (`complete` / `truncated` / `failed`) next to a `*_total_count` — an empty array is authoritative only when the status is `complete`
- A mechanism's `target_chembl_id` chains into `chembl_get_bioactivities`

---

### `chembl_get_assay` <sub>tool</sub>

- Supply `assay_chembl_id` from a `chembl_get_bioactivities` row
- Returns description, assay type (binding / functional / ADMET / toxicity), the target measured, organism, and ChEMBL's 1–9 confidence score (9 = direct assay on the protein target, lower = homologous or indirect)
- Call it to judge whether two measurements are comparable before ranking them together

---

### `chembl_dataframe_query` <sub>tool</sub>

- Accepts a single read-only `SELECT` against a `canvas_id` from a spilled `chembl_get_bioactivities` call; writes, DDL, and non-SELECT statements are rejected by the framework SQL gate
- Reference each staged table by the name `chembl_get_bioactivities` returned — `bioactivities` (potency_ranked) or `bioactivities_null_potency` (null_potency); discover columns with `chembl_dataframe_describe` first
- Two independent bounds, each disclosed: `truncated` is the canvas engine's own query-result cap; `rendered_rows` is how many rows the `content[]` markdown table holds under its character budget — either can trip without the other; page past both with SQL `LIMIT`/`OFFSET`
- `structuredContent.rows` always carries the full materialized result regardless of the render bound
- Requires `CANVAS_PROVIDER_TYPE=duckdb`, else a `canvas_disabled` error

---

### `chembl_dataframe_describe` <sub>tool</sub>

- Supply a `canvas_id` from a spilled `chembl_get_bioactivities` call
- Returns each staged table/view with its row count, kind, and column names + types
- Requires `CANVAS_PROVIDER_TYPE=duckdb`, else a `canvas_disabled` error

---

### `chembl_dataframe_drop` <sub>tool</sub>

- Opt-in — registered only when `CHEMBL_DATAFRAME_DROP_ENABLED=true`; absent from `tools/list` when off, though it still appears in the server manifest carrying the enable hint
- Drops a named staged table by `canvas_id` + `table_name`; returns `dropped: true` if it existed, `false` if already gone
- Rarely needed — per-table and per-canvas TTL already reclaim staged tables; reach for it only to free a large table early in a long session
- Requires `CANVAS_PROVIDER_TYPE=duckdb`

---

### `chembl://molecule/{chemblId}` <sub>resource</sub>

- Molecule record as `application/json` — the same shape a `chembl_search_molecules` row carries (ID, names, structures, properties, max clinical phase)
- `chemblId` is validated against the `CHEMBL\d+` pattern
- Fully covered by the tool surface — a convenience injectable-context mirror of the per-record fetch

---

### `chembl://target/{chemblId}` <sub>resource</sub>

- Target record as `application/json` — preferred name, type, organism, and component UniProt accessions + gene symbols
- `chemblId` is validated against the `CHEMBL\d+` pattern
- Fully covered by the tool surface — a convenience injectable-context mirror of the per-record fetch

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

ChEMBL-specific:

- Bidirectional bioactivity bridge — one tool serves both compound→target and target→compound, ranked on `pchembl_value`
- Structure search (exact / similarity / substructure) consolidated under one discovery tool via a `search_type` enum
- String → `number | null` numeric coercion at the service boundary — a missing potency becomes `null`, never `0`
- DataCanvas spill on the flagship tool — tens-of-thousands-of-row activity sets stream to a DuckDB table you inspect with `chembl_dataframe_describe` and query via `chembl_dataframe_query`
- Server-level `instructions` carry the cross-server chain guidance and the ChEMBL CC BY-SA 3.0 attribution requirement

Agent-friendly output:

- Provenance on every response — total-found counts, applied-filter echo, and a spill notice so agents know whether the preview is the full set or a slice of a canvas table
- Truncation disclosure — capped searches report `shown` / `cap` / `totalCount`, and spilled tables report `truncated` + `staged_row_count`, so a page or slice is never mistaken for the complete set
- Typed, recoverable errors — `missing_filter` / `missing_input` / `contradictory_potency_filter` / `canvas_disabled` carry recovery hints, so callers correct the call without parsing prose
- Never fabricates — normalization and `format()` preserve `null` potency / units; a missing measurement renders as "not reported", never `0`

## Getting started

### Public Hosted Instance

A public instance is available at `https://chembl.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "chembl-mcp-server": {
      "type": "streamable-http",
      "url": "https://chembl.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

ChEMBL is keyless — no API key or account is required.

Add the following to your MCP client configuration file:

```json
{
  "mcpServers": {
    "chembl-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/chembl-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "chembl-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/chembl-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "chembl-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/chembl-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

To unlock the analytical SQL path (the `bioactivities` spill and the `chembl_dataframe_*` tools), add `"CANVAS_PROVIDER_TYPE": "duckdb"` to the `env`.

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- Optional: set `CANVAS_PROVIDER_TYPE=duckdb` to enable the DataCanvas SQL path for large bioactivity sets.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/chembl-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd chembl-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env to override any defaults (all optional)
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. ChEMBL is keyless, so every variable is optional.

| Variable | Description | Default |
|:---|:---|:---|
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable the bioactivity spill and the `chembl_dataframe_*` SQL tools. When `none`, large sets inline a preview but never spill. | `none` |
| `CHEMBL_API_BASE_URL` | Base URL for the ChEMBL REST data API. Override for a private mirror or pinned host. | `https://www.ebi.ac.uk/chembl/api/data` |
| `CHEMBL_REQUEST_TIMEOUT_MS` | Per-request timeout in milliseconds for upstream ChEMBL fetches. | `30000` |
| `CHEMBL_MAX_PAGE_SIZE` | ChEMBL per-page cap when streaming activity pages for the spill (max 1000). | `1000` |
| `CHEMBL_DEFAULT_LIMIT` | Default result limit applied when callers omit it. | `25` |
| `CHEMBL_MAX_SPILL_ROWS` | Ceiling on rows `chembl_get_bioactivities` stages to a canvas table, and so on the upstream page drain behind it. Over the cap the response reports `truncated: true`. | `50000` |
| `CHEMBL_DATAFRAME_DROP_ENABLED` | Register the opt-in `chembl_dataframe_drop` tool (absent from `tools/list` when off). | `false` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session posture; `stateless`, `stateful`, or `auto` (resolves to `stateful`). Overrides the server's stateless declaration. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed calls' arguments and results with key-name redaction; secrets inside free-form values remain visible. | `false` |
| `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` | UTF-8 byte cap per logged input/result payload. | `16384` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL for traces and metrics, using `/v1/traces` and `/v1/metrics`. | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Explicit full endpoint for OTLP log export. Requires the optional log peers; included in the default Docker build. | — |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security, changelog sync
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t chembl-mcp-server .
docker run --rm -e MCP_TRANSPORT_TYPE=stdio chembl-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/chembl-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them. DuckDB native bindings are installed for the runtime stage's target architecture so `CANVAS_PROVIDER_TYPE=duckdb` works on either image architecture.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools/resources and inits the ChEMBL service + optional canvas. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`). Five ChEMBL tools plus the three `chembl_dataframe_*` canvas tools. |
| `src/mcp-server/resources/definitions` | Resource definitions (`*.resource.ts`). Molecule and target record mirrors. |
| `src/services/chembl` | The single ChEMBL upstream client — URL builder, pagination, numeric coercion, nested-structure flattening, activity page stream. |
| `src/services/canvas-accessor.ts` | Module-level holder for the optional `DataCanvas` wired in `createApp({ setup })`. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources in the `createApp()` arrays
- Wrap the ChEMBL API: validate raw → normalize to the flat domain type → return the output schema; never fabricate missing fields (absent numerics become `null`, never `0`)

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
