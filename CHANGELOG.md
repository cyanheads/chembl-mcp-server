# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.4.1](changelog/0.4.x/0.4.1.md) — 2026-10-24

chembl_get_drug_info and chembl_get_bioactivities read a drug's whole salt-form family, ID and code inputs are normalized or refused before any request, and ChEMBL text renders inert in content[]. The DataCanvas is on by default.

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-10-17 · ⚠️ Breaking

chembl_get_bioactivities spills pages concurrently under a time budget, pages inline views with cursors, and mints a canvas only when a view spills. Calls hold upstream requests to 45 s, and chembl_dataframe_query refuses the SQL the mcp-ts-core 0.13.15 gate denies.

## [0.3.3](changelog/0.3.x/0.3.3.md) — 2026-10-10

mcp-ts-core 0.13.14 accepts numeric-string search limits and null optional arguments; tool errors carry request IDs, and registry launch metadata and Docker dependency stages track the framework.

## [0.3.2](changelog/0.3.x/0.3.2.md) — 2026-09-26

Docker dependency installation runs natively while selecting DuckDB bindings for each target architecture.

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-09-26

Bioactivity canvas tables preserve fractional measurements and SQL queries retain projected text values; framework, Docker, and development tooling are updated.

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-09-19 · ⚠️ Breaking

Adopts mcp-ts-core 0.12.3 → 0.13.6: canvas_id inputs now validate against the minted id shape (breaking), sessionMode is declared explicitly, and a caller disconnect or a transient upstream 500 classifies correctly instead of failing the call outright.

## [0.2.4](changelog/0.2.x/0.2.4.md) — 2026-08-25

Adopts mcp-ts-core 0.12.3 (MCP SDK v2): tool inputs reject an undeclared key by name, outputSchema declares the error envelope, and MCP_SESSION_MODE now defaults to stateless. Also fixes a Docker multi-arch build crash under QEMU.

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-08-13

chembl_search_molecules and chembl_search_targets gain cursor pagination past the row cap; chembl_search_molecules also routes exact ChEMBL-ID/InChIKey queries to an honest single-record lookup instead of a fuzzy-search count.

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-08-12

chembl_get_drug_info now discloses truncated and failed mechanism/indication lists instead of an ambiguous empty array; chembl_dataframe_query's content output is bounded by a character budget instead of a fixed 50-row cut, and struct/list cells render as JSON.

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-08-12

chembl_get_bioactivities gains a null-potency view and accepts molecule and target together; the canvas spill is now capped and discloses truncation. Framework bump to mcp-ts-core 0.11.5 plus repo hygiene additions.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-27 · ⚠️ Breaking

Breaking: chembl_get_bioactivities renames the totalFound output field to totalCount. Default preview is now potency-ranked (null-pchembl rows no longer lead, while totalCount stays the honest match count), the canvas-disabled preview text no longer claims capped rows are complete, and chembl_dataframe_query returns BIGINT aggregates as numbers.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-25

First published release, on npm as @cyanheads/chembl-mcp-server — the ChEMBL drug-discovery surface (8 tools, 2 resources, DataCanvas SQL) plus pre-launch packaging, metadata, and identity polish.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-06-23

Initial release — ChEMBL drug-discovery surface: 8 tools (compound/target/bioactivity/drug/assay + DataCanvas trio), 2 resources, over @cyanheads/mcp-ts-core.
