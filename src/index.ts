#!/usr/bin/env node
/**
 * @fileoverview chembl-mcp-server MCP server entry point. Wires the ChEMBL
 * service + optional DataCanvas in setup(), registers the tool/resource surface,
 * and carries the cross-server chain guidance + CC BY-SA attribution as
 * server-level instructions. chembl_dataframe_drop is conditionally registered
 * behind CHEMBL_DATAFRAME_DROP_ENABLED.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
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

const config = getServerConfig();

const tools = [
  chemblSearchMolecules,
  chemblGetBioactivities,
  chemblSearchTargets,
  chemblGetDrugInfo,
  chemblGetAssay,
  chemblDataframeQuery,
  chemblDataframeDescribe,
  // chembl_dataframe_drop registers only when CHEMBL_DATAFRAME_DROP_ENABLED=true,
  // so it is absent from tools/list when off (TTL already reclaims staged tables).
  ...(config.dataframeDropEnabled ? [chemblDataframeDrop] : []),
];

await createApp({
  name: 'chembl-mcp-server',
  title: 'chembl-mcp-server',
  instructions:
    "Drug-discovery data over ChEMBL (EBI) — the curated link between compounds, protein targets, and measured bioactivity (IC50/Ki/EC50), plus drug mechanisms and indications. Canonical chains: (1) a UniProt accession from the uniprot/protein server → chembl_search_targets → chembl_get_bioactivities for the most potent leads on a target; (2) chembl_search_molecules → chembl_get_drug_info for a drug's mechanism and indications; (3) a molecule's standard_inchi_key → the pubchem server for richer chemistry, an approved drug (max_phase 4) → the openfda server for the FDA label and adverse events. Ranking trap: pchembl_value is comparable only within one standard_type — set the standard_type filter (mixing IC50 and Ki is a scientific error). A popular target carries tens of thousands of measurements; chembl_get_bioactivities spills the full set to a DataCanvas table you SQL with chembl_dataframe_query (requires CANVAS_PROVIDER_TYPE=duckdb). Data from ChEMBL, licensed CC BY-SA 3.0 — attribute ChEMBL (https://www.ebi.ac.uk/chembl/) in downstream use.",
  tools,
  resources: [chemblMoleculeResource, chemblTargetResource],
  setup(core) {
    initChemblService(config);
    setCanvas(core.canvas);
  },
});
