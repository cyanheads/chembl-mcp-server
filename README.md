<div align="center">
  <h1>@cyanheads/chembl-mcp-server</h1>
  <p><b>Link compounds to protein targets, rank bioactivity (IC50/Ki/EC50), and look up drug mechanisms and indications over ChEMBL via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools (+1 opt-in) • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/chembl-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/chembl-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/chembl-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/chembl-mcp-server/releases/latest/download/chembl-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=chembl-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY2hlbWJsLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22chembl-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fchembl-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Eight tools — five for the ChEMBL compound/target/bioactivity surface, plus three for SQL analytics over the DuckDB-backed canvas that `chembl_get_bioactivities` spills to (the third is opt-in):

| Tool | Description |
|:---|:---|
| `chembl_search_molecules` | Find compounds by name / ChEMBL ID / InChIKey, or run a structure search (exact \| similarity \| substructure) from a SMILES. |
| `chembl_get_bioactivities` | The flagship compound↔target bridge: bioactivity measurements for a molecule **or** a target, ranked on `pchembl_value`. Large sets spill to a canvas. |
| `chembl_search_targets` | Resolve a protein / gene symbol / UniProt accession to the ChEMBL target ID `chembl_get_bioactivities` needs. |
| `chembl_get_drug_info` | Drug pharmacology — mechanism(s) of action, molecular target(s), action type, first-approval year, and clinical indications. |
| `chembl_get_assay` | Assay provenance behind a bioactivity row — type, target, organism, and ChEMBL's 1–9 confidence score. |
| `chembl_dataframe_query` | Run a read-only SQL `SELECT` over the bioactivity rows spilled to a canvas — rank, group, dedupe, aggregate across the full set. |
| `chembl_dataframe_describe` | List the tables and columns staged on a canvas, so you can write correct SQL before querying. |
| `chembl_dataframe_drop` | Drop a named staged table from a canvas. Opt-in via `CHEMBL_DATAFRAME_DROP_ENABLED=true` — absent from `tools/list` when off, since TTL already reclaims staged tables. |

### `chembl_search_molecules`

The discovery entry point for compounds.

- Default `search_type=name` matches drug names, synonyms, ChEMBL IDs, and InChIKeys in one query
- Structure search via `search_type`: `exact` (exact match), `similarity` (Tanimoto ≥ threshold), or `substructure` (contains the query structure) — supply `structure` as a SMILES
- `similarity_threshold` is an integer 40–100 (default 70; ChEMBL rejects values below 40)
- `max_phase_min` restricts name searches to compounds at or above a max clinical phase (e.g. `4` for marketed drugs only)
- Every row carries `max_phase` — the cheap druggability signal (4 = marketed, 0 = research) — plus MW, AlogP, Lipinski rule-of-five violations, and QED; structure searches also return a Tanimoto similarity percent
- Chain `molecule_chembl_id` into `chembl_get_bioactivities` or `chembl_get_drug_info`

---

### `chembl_get_bioactivities`

The flagship tool and the reason the server exists — the curated compound↔target↔assay link.

- Supply **exactly one** of `molecule_chembl_id` (target deconvolution / selectivity) or `target_chembl_id` (lead finding); both or neither is a `missing_filter` error
- Filter by `standard_type` (IC50 / Ki / EC50 / …), minimum potency `pchembl_value_min`, `assay_type`, and `organism`; rows are ranked on `pchembl_value` (−log10 molar potency)
- **Ranking trap:** `pchembl_value` is comparable only within one `standard_type` — set the filter, because mixing IC50 and Ki is a scientific error
- Numerics are coerced from upstream JSON strings to `number | null` at the service boundary — a missing potency reads as `null`, never `0`
- A popular target carries tens of thousands of measurements: when the set exceeds the inline preview it **spills** to a DataCanvas table (`bioactivities`) you SQL with `chembl_dataframe_query` for honest aggregates across the full set, while the inline preview answers the immediate question
- Spilling requires `CANVAS_PROVIDER_TYPE=duckdb`; without it the preview is the full inlined set (capped at `limit`)
- The optional `canvas_id` reuses an existing canvas, but the `bioactivities` table is always re-registered — a second query **replaces** the prior rows on that canvas rather than appending; omit `canvas_id` to mint a fresh one

---

### `chembl_search_targets`

Resolve a protein into the ChEMBL target ID downstream tools need.

- Supply at least one of `accession` (UniProt, e.g. `P00533`), `gene_symbol` (e.g. `EGFR`), or `query` (free-text name); narrow further with `organism` and `target_type`
- A UniProt accession is the most precise input — chain it from a `uniprot` / `protein` server
- Each row carries the target type, organism, and component UniProt accessions + gene symbols (flattened from ChEMBL's nested component synonyms)
- Chain `target_chembl_id` into `chembl_get_bioactivities`

---

### `chembl_get_drug_info`

Drug pharmacology for a molecule — distinct from the `openfda` server's label / adverse-event view.

- Supply `molecule_chembl_id` (from `chembl_search_molecules`)
- Returns mechanism(s) of action, the molecular target(s), action type (inhibitor / agonist / …), first-approval year, and clinical indications with the max phase reached for each
- Composed from molecule + mechanisms + indications with `Promise.allSettled`, so a missing mechanism or indication list degrades to an empty array rather than failing the call
- A mechanism's `target_chembl_id` chains into `chembl_get_bioactivities` for compounds hitting the same target

---

### `chembl_get_assay`

Assay provenance behind a bioactivity row — call it to judge whether two measurements are comparable before ranking them together.

- Supply `assay_chembl_id` from a `chembl_get_bioactivities` row
- Returns the description, assay type (binding / functional / ADMET / toxicity), the target it measures, organism, and ChEMBL's 1–9 confidence score (9 = direct assay on the protein target, lower = homologous or indirect)

---

### `chembl_dataframe_query` / `chembl_dataframe_describe` / `chembl_dataframe_drop`

In-conversation SQL analytics over the `bioactivities` table that `chembl_get_bioactivities` spills to a DuckDB-backed canvas. When a query spills, the tool returns a `canvas_id`; pass it to `chembl_dataframe_query` for ranking, grouping, deduplication, and aggregation across the full set — standard DuckDB SQL.

- **Read-only.** `chembl_dataframe_query` accepts a single `SELECT`; writes, DDL, and non-SELECT statements are rejected by the framework SQL gate. Reference the staged table by the name `chembl_get_bioactivities` returned (`bioactivities`), and discover its columns with `chembl_dataframe_describe` first.
- The spilled table holds the **full** `Activity` row — 18 columns including the normalized `standard_*` / `pchembl_value` fields (rank on these) and the raw upstream `type` / `value` / `units` / `relation` (audit only). Compute aggregates here, never over the inline preview.
- `chembl_dataframe_drop` is the only destructive tool and is **opt-in** (`CHEMBL_DATAFRAME_DROP_ENABLED=true`) — absent from `tools/list` when off, because per-table and per-canvas TTL already reclaim staged tables. Reach for it only to free a large table early in a long session.
- All three require `CANVAS_PROVIDER_TYPE=duckdb`; without it they return a `canvas_disabled` error and `chembl_get_bioactivities` degrades to a preview-only response.

## Resources and prompts

| Type | Name | Description |
|:---|:---|:---|
| Resource | `chembl://molecule/{chemblId}` | A molecule record by ChEMBL ID — the same shape a `chembl_search_molecules` row carries (ID, names, structures, properties, max clinical phase). |
| Resource | `chembl://target/{chemblId}` | A target record by ChEMBL target ID — preferred name, type, organism, and component UniProt accessions + gene symbols. |

All resource data is also reachable via the tools, so tool-only MCP clients lose nothing — the resources are convenience injectable-context mirrors of the per-record fetch. `{chemblId}` is validated against the `CHEMBL\d+` pattern. There are no prompts; the canonical workflows are short tool chains an agent composes directly, and the cross-server chain guidance ships as server-level `instructions` instead.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Typed error contracts with recovery hints (`missing_filter`, `missing_input`, `canvas_disabled`)
- Pluggable auth (`none`, `jwt`, `oauth`) and swappable storage backends
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

ChEMBL-specific:

- Single keyless upstream client for the ChEMBL REST data API — Django-style filtered URL builder, `page_meta` pagination, `withRetry`-wrapped fetch + parse
- String → `number | null` numeric coercion at the service boundary (a missing potency becomes `null`, never `0` — the scientific-data fidelity rule)
- Bidirectional bioactivity: one tool serves both compound→target and target→compound, ranked on `pchembl_value`
- Structure search (exact / similarity / substructure) consolidated under one discovery tool via a `search_type` enum
- DataCanvas spill on the flagship: tens-of-thousands-of-row activity sets stream to a DuckDB table queryable via `chembl_dataframe_query`
- Server-level `instructions` carry the cross-server chain guidance and the ChEMBL CC BY-SA 3.0 attribution

Agent-friendly output:

- Provenance on every response — total-found counts, applied-filter echo, and a spill notice so agents know whether the preview is the full set or a slice of a canvas table
- Truncation disclosure — capped search results report `shown` / `cap` / `totalCount` so a page is never mistaken for the complete set
- Typed, recoverable errors — `missing_filter` / `missing_input` / `canvas_disabled` carry recovery hints, so callers correct the call without parsing prose
- Never fabricates — normalization and `format()` preserve `null` potency / units; a missing measurement renders as "not reported", never `0`

## Getting started

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

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
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
| `CHEMBL_DATAFRAME_DROP_ENABLED` | Register the opt-in `chembl_dataframe_drop` tool (absent from `tools/list` when off). | `false` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

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

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/chembl-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them. The fully-resolved `@duckdb` native binary is copied from the build stage so `CANVAS_PROVIDER_TYPE=duckdb` works at runtime.

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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
