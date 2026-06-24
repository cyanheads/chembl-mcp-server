# chembl-mcp-server — Idea & Design

The drug-discovery layer the fleet is missing — [ChEMBL](https://www.ebi.ac.uk/chembl/) (EBI), a manually curated database of bioactive molecules with drug-like properties. Its unique value is the **curated link between compounds, protein targets, and measured bioactivity** (IC50/Ki/EC50), plus drug mechanism-of-action and clinical-indication data. Keyless REST API, CC BY-SA.

Fills the slot between three existing servers: `pubchem` knows a compound's *structure and properties*, `openfda` knows an *approved drug's label and adverse events*, and `protein`/`uniprot` know a *target's structure and function* — but nothing connects **"which compounds hit this target, how potently, in what assay,"** which is the core of early drug discovery and pharmacology.

**Audience:** Medicinal chemists, pharmacologists, drug-discovery and cheminformatics researchers, computational biologists doing target validation or lead finding.

## User Goals

- Find bioactivity data for a compound — what targets it hits and how potently (IC50/Ki/EC50)
- Find compounds active against a target (by protein/gene/UniProt accession) — lead discovery
- Look up a drug's mechanism of action, target, and clinical indications
- Search molecules by structure — exact, similarity, or substructure (SMILES/InChI)
- Get standardized dose-response measurements with assay context
- Trace a compound → target → known drugs for that target

## API Surface

One provider at `www.ebi.ac.uk/chembl/api/data/`. Everything is keyed by **ChEMBL IDs** (`CHEMBL25` = aspirin, `CHEMBL204` = a target). Resources are richly filterable (Django-style `field__op=` filters, e.g. `standard_type=IC50&standard_value__lte=100`). The **molecule × target × activity** trio is the heart of the surface.

| Resource | Endpoint | Purpose |
|:---------|:---------|:--------|
| Molecule | `/molecule` (+ `/similarity`, `/substructure`) | Compounds: properties, structures, structure search |
| Target | `/target` | Protein/organism targets; filter by UniProt accession or gene |
| Activity | `/activity` | Bioactivity measurements — the compound↔target↔assay link |
| Assay | `/assay` | Assay metadata (type, organism, confidence) |
| Mechanism | `/mechanism` | Drug mechanism of action → target |
| Drug indication | `/drug_indication` | Approved/investigational indications (MeSH/EFO) + max phase |

Compound properties include MW, AlogP, Lipinski rule-of-five violations, QED, and **max clinical phase** (a key "is this a drug" signal). Activity rows carry `standard_type` / `standard_value` / `standard_units` / `pchembl_value` (the normalized −log potency) — the field to rank on.

## Tool Surface (sketch)

```
chembl_search_molecules   — find compounds by name, ChEMBL ID, SMILES/InChIKey, or
                           structure search (exact | similarity≥threshold | substructure).
                           Returns ChEMBL ID, preferred name, canonical SMILES, formula,
                           MW, AlogP, Lipinski violations, QED, and max clinical phase.
                           The discovery entry point; chain IDs into get_bioactivities.
                           Convenience: a `structure` input auto-routes to the right
                           similarity/substructure endpoint by `search_type`.

chembl_get_bioactivities  — the flagship link. Bioactivity measurements for a molecule OR
                           a target. Filter by standard_type (IC50/Ki/EC50/…), potency
                           threshold (pchembl_value), assay type, and organism. Returns
                           per-measurement: compound, target, assay, standard_type/value/
                           units, pchembl_value, and assay confidence. Large result sets
                           spill to DataCanvas for SQL ranking/aggregation across the set.

chembl_search_targets     — find targets by name, gene symbol, UniProt accession, or
                           organism. Returns ChEMBL target ID, type (single protein /
                           protein complex / cell line / organism), and component
                           accessions. Resolves a protein from uniprot/ensembl into the
                           target ID that get_bioactivities needs.

chembl_get_drug_info      — pharmacology for a drug (molecule): mechanism(s) of action,
                           the molecular target(s) it acts on, action type (inhibitor /
                           agonist / …), first-approval year, and clinical indications
                           with max phase. The "what does this drug do and what's it for"
                           tool — distinct from openfda's label/adverse-event view.

chembl_get_assay          — assay detail by assay ChEMBL ID: description, type
                           (binding/functional/ADMET), target, organism, and confidence
                           score. The provenance behind a bioactivity row — call when an
                           agent needs to judge whether a measurement is comparable.
```

## Design Notes

- **`get_bioactivities` is the 80% tool and the reason this server exists.** It's the bidirectional compound↔target bridge: "what hits this target" (lead finding) and "what does this compound hit" (target deconvolution / selectivity). Rank on `pchembl_value`; expose the standard-type filter prominently since mixing IC50 and Ki is a correctness trap.
- **Activity tables are large and analytical** — a target like a kinase has tens of thousands of measurements. This is a textbook DataCanvas case: inline preview + `chembl_dataframe_query` for SQL (group by compound, filter by potency, dedupe by assay). Aggregate signal (median potency, assay count) must be computed over the full set, not the preview.
- **Standardize, don't pass through raw.** ChEMBL already provides `standard_*` and `pchembl_value` — surface those, and carry the original alongside. Never fabricate a missing potency; a measurement without a `standard_value` is data the agent must see as null, not zero.
- **Structure search has three modes** (exact / similarity / substructure) — consolidate under `chembl_search_molecules` with a `search_type` enum rather than three tools. Similarity takes a threshold (default ~70%).
- **Cross-server identity is the payoff.** A UniProt accession (`uniprot` / `protein`) → `chembl_search_targets` → `chembl_get_bioactivities` is the canonical chain; a ChEMBL molecule's InChIKey → `pubchem` for richer chemistry; an approved drug → `openfda` for the label and real-world adverse events. Document these explicitly.
- **Max clinical phase is the cheap "druggability" signal** — surface it on every molecule result so an agent can distinguish a marketed drug (phase 4) from a research compound (phase 0).
- **Licensing nuance:** ChEMBL data is CC BY-**SA** 3.0 — the share-alike applies to the *data*, which matters for downstream redistribution but not for serving it via MCP; attribution in output is the practical obligation.
- README one-liner: "Drug-discovery data over ChEMBL — connect compounds to protein targets through curated, standardized bioactivity, mechanisms, and indications."
