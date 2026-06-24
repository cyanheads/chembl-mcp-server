/**
 * @fileoverview Server-specific configuration for chembl-mcp-server. Lazy-parses
 * the ChEMBL upstream env vars (base URL, timeout, page size, default limit) and
 * the opt-in dataframe-drop toggle via a Zod schema, with env-var names mapped so
 * validation errors name the variable rather than the schema path.
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
    .describe('Per-request timeout in milliseconds for upstream ChEMBL fetches.'),
  maxPageSize: z.coerce
    .number()
    .int()
    .positive()
    .max(1000)
    .default(1000)
    .describe(
      "ChEMBL's per-page cap when streaming activity pages for the bioactivity spill (max 1000).",
    ),
  defaultLimit: z.coerce
    .number()
    .int()
    .positive()
    .default(25)
    .describe('Default `limit` applied when callers omit it; keeps inline preview sizes sane.'),
  dataframeDropEnabled: z
    .stringbool()
    .default(false)
    .describe(
      'Opt-in toggle for the chembl_dataframe_drop tool. Off by default — per-table/canvas TTL already reclaims staged tables; set true only to free a large staged table early in a long session.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/**
 * Lazily parse and cache the server config. Maps each Zod path to its env var so
 * a bad value reports `CHEMBL_REQUEST_TIMEOUT_MS`, not `requestTimeoutMs`.
 */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiBaseUrl: 'CHEMBL_API_BASE_URL',
    requestTimeoutMs: 'CHEMBL_REQUEST_TIMEOUT_MS',
    maxPageSize: 'CHEMBL_MAX_PAGE_SIZE',
    defaultLimit: 'CHEMBL_DEFAULT_LIMIT',
    dataframeDropEnabled: 'CHEMBL_DATAFRAME_DROP_ENABLED',
  });
  return _config;
}
