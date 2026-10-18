/**
 * @fileoverview Server-specific configuration for chembl-mcp-server. Lazy-parses
 * the ChEMBL upstream env vars (base URL, timeout, page size, default limit, and
 * the bioactivity spill's row cap, page concurrency, and time budget) and the
 * opt-in dataframe-drop toggle via a Zod schema, with env-var names mapped so
 * validation errors name the variable rather than the schema path, plus a
 * non-throwing read of the drop toggle alone for the module-load registration gate.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * ChEMBL has no API key — it is keyless — so there is no degraded-without-key
 * mode. The capability gate for the analytical SQL path is `CANVAS_PROVIDER_TYPE`
 * (a framework env var), not a server-config field. The only server-owned toggle
 * is the opt-in dataframe-drop tool flag.
 */
const ServerConfigSchema = z.object({
  apiBaseUrl: z
    .string()
    .default('https://www.ebi.ac.uk/chembl/api/data')
    .describe(
      'Base URL for the ChEMBL REST data API. Override for a private mirror or pinned host.',
    ),
  requestTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe(
      "Per-attempt timeout in milliseconds for an upstream ChEMBL request, capped by what is left of the call's time budget (45 s for most calls, CHEMBL_SPILL_DEADLINE_MS for a bioactivity spill).",
    ),
  maxPageSize: z.coerce
    .number()
    .int()
    .positive()
    .max(1000)
    .default(1000)
    .describe(
      'Rows per upstream ChEMBL page (max 1000). The bioactivity spill walks pages of this size; an inline bioactivity page requests its limit, capped at this size.',
    ),
  defaultLimit: z.coerce
    .number()
    .int()
    .positive()
    .default(25)
    .describe('Default `limit` applied when callers omit it; keeps inline preview sizes sane.'),
  maxSpillRows: z.coerce
    .number()
    .int()
    .positive()
    .default(50_000)
    .describe(
      'Hard ceiling on rows staged to a DataCanvas table by chembl_get_bioactivities, and so on the upstream page walk behind it: no page is requested at or past it (at 1000 rows/page, 50000 bounds one call to 50 ChEMBL page fetches). Covers the largest real single-protein targets uncapped while bounding the catch-all ones; a capped result is reported as truncated rather than passed off as complete.',
    ),
  maxConcurrentPages: z.coerce
    .number()
    .int()
    .min(1)
    .max(6)
    .default(4)
    .describe(
      'Most chembl_get_bioactivities spill-page requests in flight at once (1–6), shared by every call on the server, so concurrent spills interleave rather than multiply the load on ChEMBL.',
    ),
  spillDeadlineMs: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(600_000)
    .default(45_000)
    .describe(
      'Time budget in milliseconds for one chembl_get_bioactivities spill — its count request and page walk (10000–600000). At expiry the rows fetched so far stage with truncated: true and truncated_by: "time_budget"; with nothing fetched the call fails as upstream_timeout. The default settles under the 60 s request timeout MCP clients apply by default.',
    ),
  dataframeDropEnabled: z
    .stringbool()
    .default(false)
    .describe(
      'Opt-in toggle for the chembl_dataframe_drop tool. Off by default — a staged table lives as long as its canvas, which expires on its sliding CANVAS_TTL_MS or its CANVAS_ABSOLUTE_CAP_MS cap and frees its tables; set true only to free a large staged table early in a long session.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/** Schema path → env var, so a validation error names the variable at fault. */
const ENV_VARS = {
  apiBaseUrl: 'CHEMBL_API_BASE_URL',
  requestTimeoutMs: 'CHEMBL_REQUEST_TIMEOUT_MS',
  maxPageSize: 'CHEMBL_MAX_PAGE_SIZE',
  defaultLimit: 'CHEMBL_DEFAULT_LIMIT',
  maxSpillRows: 'CHEMBL_MAX_SPILL_ROWS',
  maxConcurrentPages: 'CHEMBL_MAX_CONCURRENT_PAGES',
  spillDeadlineMs: 'CHEMBL_SPILL_DEADLINE_MS',
  dataframeDropEnabled: 'CHEMBL_DATAFRAME_DROP_ENABLED',
} as const satisfies Record<keyof ServerConfig, string>;

let _config: ServerConfig | undefined;

/**
 * Lazily parse and cache the server config. Maps each Zod path to its env var so
 * a bad value reports `CHEMBL_REQUEST_TIMEOUT_MS`, not `requestTimeoutMs`. Call it
 * from `createApp`'s `setup()`, where an invalid value fails startup with the
 * framework's configuration banner rather than an uncaught stack.
 */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, ENV_VARS);
  return _config;
}

/**
 * Read only `CHEMBL_DATAFRAME_DROP_ENABLED`, without throwing. `src/index.ts`
 * picks the drop tool's registration form at module load, before `setup()` runs;
 * a value the schema rejects reads as off here and is reported by the full
 * `getServerConfig()` parse inside `setup()`. Blank and unsubstituted
 * `${user_config.…}` values are rejected too, so they read as off — the default.
 */
export function isDataframeDropEnabled(): boolean {
  const flag = ServerConfigSchema.shape.dataframeDropEnabled.safeParse(
    process.env[ENV_VARS.dataframeDropEnabled],
  );
  return flag.success && flag.data;
}
