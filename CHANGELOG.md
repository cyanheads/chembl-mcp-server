# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-27 · ⚠️ Breaking

Breaking: chembl_get_bioactivities renames the totalFound output field to totalCount. Default preview is now potency-ranked (null-pchembl rows no longer lead, while totalCount stays the honest match count), the canvas-disabled preview text no longer claims capped rows are complete, and chembl_dataframe_query returns BIGINT aggregates as numbers.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-25

First published release, on npm as @cyanheads/chembl-mcp-server — the ChEMBL drug-discovery surface (8 tools, 2 resources, DataCanvas SQL) plus pre-launch packaging, metadata, and identity polish.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-06-23

Initial release — ChEMBL drug-discovery surface: 8 tools (compound/target/bioactivity/drug/assay + DataCanvas trio), 2 resources, over @cyanheads/mcp-ts-core.
