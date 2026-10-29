#!/usr/bin/env node
/**
 * @fileoverview chembl-mcp-server MCP server entry point. Parses the server
 * config and wires the ChEMBL service + DataCanvas in setup(), so an invalid
 * env value fails startup with the framework's configuration banner. Defaults
 * CANVAS_PROVIDER_TYPE to duckdb once `.env` is loaded, so a `.env` value still
 * wins over the default.
 * Declares the stateless HTTP session posture, registers the tool/resource
 * surface, serves the root `skills/` tree over MCP, and carries the
 * cross-server chain guidance + CC BY-SA attribution as server-level
 * instructions. chembl_dataframe_drop is gated behind
 * CHEMBL_DATAFRAME_DROP_ENABLED via disabledTool().
 * @module index
 */

import { createApp, disabledTool } from '@cyanheads/mcp-ts-core';
import { parseConfig, resetConfig } from '@cyanheads/mcp-ts-core/config';
import { getServerConfig, isDataframeDropEnabled } from './config/server-config.js';
import { chemblMoleculeResource } from './mcp-server/resources/definitions/chembl-molecule.resource.js';
import { chemblTargetResource } from './mcp-server/resources/definitions/chembl-target.resource.js';
import { chemblDataframeDescribe } from './mcp-server/tools/definitions/chembl-dataframe-describe.tool.js';
import { chemblDataframeDrop } from './mcp-server/tools/definitions/chembl-dataframe-drop.tool.js';
import { chemblDataframeQuery } from './mcp-server/tools/definitions/chembl-dataframe-query.tool.js';
import { chemblGetAssay } from './mcp-server/tools/definitions/chembl-get-assay.tool.js';
import { chemblGetBioactivities } from './mcp-server/tools/definitions/chembl-get-bioactivities.tool.js';
import { chemblGetDrugInfo } from './mcp-server/tools/definitions/chembl-get-drug-info.tool.js';
import { chemblSearchMolecules } from './mcp-server/tools/definitions/chembl-search-molecules.tool.js';
import { chemblSearchTargets } from './mcp-server/tools/definitions/chembl-search-targets.tool.js';
import { setCanvas } from './services/canvas-accessor.js';
import { initChemblService } from './services/chembl/chembl-service.js';

parseConfig();
// DataCanvas defaults on; set CANVAS_PROVIDER_TYPE=none to disable it.
process.env.CANVAS_PROVIDER_TYPE ||= 'duckdb';
resetConfig();

const tools = [
  chemblSearchMolecules,
  chemblGetBioactivities,
  chemblSearchTargets,
  chemblGetDrugInfo,
  chemblGetAssay,
  chemblDataframeQuery,
  chemblDataframeDescribe,
  /**
   * chembl_dataframe_drop is the lone mutator on a read-only surface. When
   * CHEMBL_DATAFRAME_DROP_ENABLED is off it is wrapped with disabledTool(), so
   * it stays visible in the server manifest and landing page with the enable
   * hint while being skipped at registration — absent from tools/list, and so
   * uncallable. TTL already reclaims staged tables without it. The flag is read
   * on its own here, without throwing: the full config parse runs in setup(),
   * where an invalid value reaches the framework's configuration banner.
   */
  isDataframeDropEnabled()
    ? chemblDataframeDrop
    : disabledTool(chemblDataframeDrop, {
        reason: 'Dropping staged canvas tables is turned off in this deployment.',
        hint: 'CHEMBL_DATAFRAME_DROP_ENABLED=true',
      }),
];

await createApp({
  name: 'chembl-mcp-server',
  title: 'chembl-mcp-server',
  /**
   * No tool or resource on this surface calls `ctx.requestInput`, so nothing
   * needs a durable session to answer a mid-handler prompt. Declaring it here
   * rather than leaving it to the framework's `auto` default (stateful) makes a
   * source run, the Dockerfile, and `.env.example` resolve alike;
   * `MCP_SESSION_MODE` still overrides whenever it carries a meaningful value.
   */
  sessionMode: 'stateless',
  instructions:
    "Drug-discovery data over ChEMBL (EBI) — the curated link between compounds, protein targets, and measured bioactivity (IC50/Ki/EC50), plus drug mechanisms and indications. Canonical chains: (1) a UniProt accession from the uniprot/protein server → chembl_search_targets → chembl_get_bioactivities for the most potent leads on a target, or with molecule_chembl_id supplied alongside target_chembl_id to narrow to how potently one compound hits that one target; (2) chembl_search_molecules → chembl_get_drug_info for a drug's mechanism and indications; (3) a molecule's standard_inchi_key → the pubchem server for richer chemistry, an approved drug (max_phase 4) → the openfda server for the FDA label and adverse events. Ranking trap: pchembl_value is comparable only within one standard_type — set the standard_type filter (mixing IC50 and Ki is a scientific error). Coverage trap: many measurements have no derivable pchembl_value and are absent from the default potency-ranked view — chembl_get_bioactivities returns them only under potency_view: \"null_potency\", which stages its own canvas table alongside the ranked one. Salt trap: a drug's measurements are split across its salts and other alternate forms, and a salt often ranks first in chembl_search_molecules — every molecule row names its family parent_chembl_id, chembl_get_bioactivities reads the whole family under include_alternate_forms: true, and chembl_get_drug_info always reports the family's mechanisms and indications. A popular target carries tens of thousands of measurements; chembl_get_bioactivities spills the selected view to a DataCanvas table (call chembl_dataframe_describe for its columns, then chembl_dataframe_query to SQL them; unavailable only where the server sets CANVAS_PROVIDER_TYPE=none), bounded by a row cap (CHEMBL_MAX_SPILL_ROWS) and a time budget (CHEMBL_SPILL_DEADLINE_MS) — read truncated: true as a bounded slice, not the complete view, with truncated_by naming the bound. Pass that canvas_id back and each later non-cursor call re-stages the view's table with its own rows, inline fits included. Data from ChEMBL, licensed CC BY-SA 3.0 — attribute ChEMBL (https://www.ebi.ac.uk/chembl/) in downstream use.",
  tools,
  resources: [chemblMoleculeResource, chemblTargetResource],
  skills: 'skills',
  setup(core) {
    initChemblService(getServerConfig());
    setCanvas(core.canvas);
  },
});
