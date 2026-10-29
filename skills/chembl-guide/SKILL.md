---
name: chembl-guide
description: Gates and workflows for the chembl_* bioactivity tools, covering pinning a protein to its single-protein target, ranking leads without mixing mutants, salts, or repeat measurements, building a compound's target profile and selectivity with its inactive results, and checking assay provenance and approval status. Use before ranking potencies, calling a compound selective or inactive, or saying what a drug hits or is approved for from chembl_* output.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

ChEMBL's curated measurements (compound × target × assay), plus the mechanisms and indications it records for drugs and clinical candidates. Keyless. Not here:

- What a source paper says. Rows cite `document_chembl_id` and `document_year`; no tool resolves a document to a title, DOI, or PMID.
- Pharmacology for a research compound. `chembl_get_drug_info` returns empty lists marked `complete` for a compound with no clinical record, so take its targets from `chembl_get_bioactivities` instead.

## Identifiers

- **Target ID** comes from `chembl_search_targets` (accession, gene symbol, or name), a mechanism in `chembl_get_drug_info`, or any bioactivity row. The search does not take a ChEMBL ID (a target ID sent as `query` matches nothing); for an ID already in hand, read its type, organism, and components from the `chembl://target/{chemblId}` resource.
- **Mechanism targets are not always proteins.** A drug's mechanism can name a fusion, complex, or family target: imatinib's names the Bcr/Abl fusion (a `CHIMERIC PROTEIN` target) beside single-protein ABL1, and each holds its own measurements. For the protein's data, resolve its gene to the `SINGLE PROTEIN` target too.
- **Molecule ID in a row is the form that was measured.** In a target view a salt ranks as its own compound (imatinib mesylate's ABL1 measurements sit under the mesylate's ID, apart from imatinib's). Rows carry no parent column: before reporting a leaderboard, look up `parent_chembl_id` for each shortlisted ID with `chembl_search_molecules` and merge forms of one parent.
- **Assay ID** comes from a row's `assay_chembl_id` and is read one at a time with `chembl_get_assay`. The confidence score lives only there; neither the rows nor the staged table carry it.

## Gates

1. **Pin the target before pulling leads.** A gene symbol or accession matches every target containing that protein: families, chimeras, protein–protein-interaction targets, and, for a gene symbol, other species' orthologs. `EGFR` returns close to twenty targets, one of them human `SINGLE PROTEIN`. Set `target_type` to `SINGLE PROTEIN` and `organism`, or take that row.
2. **Separate wild type from mutants.** A target view mixes engineered mutants (`L858R`, `T790M`, `L858R,T790M,C797S`) with the native protein, and mutant assays often top the ranking: about half of EGFR's ranked Ki rows were mutant, the most potent row among them. Set `variant: "wild_type"` for the native protein, or the recorded mutation for one variant; a mutant ChEMBL records without its residues reads `UNDEFINED MUTATION`.
3. **Rank compounds, not rows.** Each measurement is its own row, so a preview's top rows repeat a few compounds, and most leads rest on one measurement from one paper. Aggregate per molecule in SQL and report measurement and document counts beside the median.
4. **Keep a profile to proteins.** Rows carry no target type. An unfiltered molecule view mixes cell lines (`K562`), whole organisms (viruses), and ChEMBL's catch-all targets (`Unchecked`, `NON-PROTEIN TARGET`, `ADMET`) with proteins. `assay_type: "B"` leaves out the cell-based assays; adding `organism: "Homo sapiens"` also drops the catch-alls, which record no organism, and other species. Families and fusions can remain; check any doubtful target through the resource.
5. **Inactive results live in the null_potency view.** Ranked rows are only `=` measurements whose `data_validity_comment` is empty or `Manually validated`; their `activity_comment` can still read `Active`, `Uncertain`, or `inactive`. `null_potency` also holds `=` rows with a suspect flag (`Potential transcription error`, `Outside typical range`) or a non-molar unit. Every censored result (`Kd > 10000 nM`) and every result reported only as a comment (`Inhibition < 50% @ 10 uM`, `Not Determined`) sits in `null_potency`; a weak `=` value annotated `inactive` can still rank, at the bottom. Imatinib's binding data names dozens of targets with a potency and several hundred more that appear only in the null view. Before calling a compound selective, or saying it does not hit a target, stage both views and read the target's null-view rows: relation, value, and comment, since a single-concentration `Inhibition` percentage sits there too.
6. **Take selectivity ratios within one document.** One `standard_type` is not enough: assay conditions vary by paper. For imatinib, ABL1 versus KIT runs from over 100-fold in favor of ABL1 in one document to about 10-fold in favor of KIT in another. Pivot on rows that share `document_chembl_id` (a panel) and report each document's difference; one pChEMBL unit is 10-fold.
7. **A truncated ranked table is the most potent prefix.** Under either `truncated_by` bound, the staged rows are the top of the potency order: a row-level top N is exact down to the table's minimum `pchembl_value`, but per-compound medians, counts, and hit rates over it skew potent. Before aggregating, narrow with `pchembl_value_min`, `variant`, or `assay_type` until `truncated` is false.
8. **Check confidence before calling a value direct.** `chembl_get_assay` scores how exactly the assay's target is assigned: 9 is a direct single protein, 8 a homologous protein, 1 a non-molecular target such as a cell line. The score is set per assay, so check it rather than infer it from the assay kind: ABL1 kinase-domain binding panels score 8, and EGFR's A431 cell assays score 8 or 9 depending on the assay. Shortlist first, then fetch the assays behind the rows you cite.
9. **Approved means phase 4 for that indication.** `chembl_get_drug_info` lists trial indications alongside approved ones: imatinib carries over a hundred, about ten at `max_phase_for_ind` 4. On molecules and indications alike, 4 is approved, 3 to 1 are trial phases, 0.5 is early phase 1, −1 is clinical with the phase unknown, and a null `max_phase` means no clinical record (ChEMBL records no 0).

## Workflows

### Protein → ranked leads → provenance

1. `chembl_search_targets` with the UniProt accession, `target_type: "SINGLE PROTEIN"`, and the organism → one target ID (Gate 1).
2. `chembl_get_bioactivities` with that target, one `standard_type`, `variant: "wild_type"`, and `assay_type: "B"` for binding constants (Gate 2). A large view spills.
3. If `truncated`, narrow first (Gate 7). Then rank per compound in SQL (Gate 3; [recipes](references/sql-recipes.md)).
4. For the shortlist: `chembl_search_molecules` on each ID to merge salts into their parent and read `max_phase`; `chembl_get_assay` on the assays behind the cited values (Gate 8).

### Compound → target profile and selectivity

1. `chembl_search_molecules` → take the row's `parent_chembl_id`.
2. `chembl_get_bioactivities` with that ID, `include_alternate_forms: true`, `assay_type: "B"`, `organism: "Homo sapiens"` (Gate 4), then the same call with `potency_view: "null_potency"`. Whichever call spills first returns a `canvas_id`; pass it on the other, and that view is staged beside it even when it fits inline. A view that fits inline with no `canvas_id` returns only `limit` rows; raise `limit` or follow `nextCursor` to read it whole.
3. In SQL: the targets with a potency, the targets with no potency value (Gate 5), and per-document pivots for any pair (Gate 6).

### Drug → mechanism, indications, approval

`chembl_get_drug_info` on any form. Read the approved indications at phase 4 (Gate 9). Before chaining a mechanism's target into `chembl_get_bioactivities`, check whether it is a fusion or family target (Identifiers).

### DataCanvas

Results too large to return inline are staged as a DataCanvas table, and the response carries a `canvas_id`. Call `chembl_dataframe_describe` with it for the staged table and column names before writing SQL, then `chembl_dataframe_query` with a read-only query. Pass the same `canvas_id` back to stage further results beside the first; the tables expire with the canvas.

- Only the other `potency_view` stages beside the first. A second call of the same view on that canvas replaces its table, so compare targets by staging one molecule-scoped call and filtering `target_chembl_id` in SQL, not one call per target.
- The engine is DuckDB: `MEDIAN`, `FILTER (WHERE …)`, `GROUP BY ALL`, `UNION ALL` across the two view tables all work. Write every alias with `AS`: a bare keyword alias such as `name` or `rows` fails to parse.

## References

- [references/sql-recipes.md](references/sql-recipes.md): verified queries for leads, the variant mix, protein profiles, targets with no potency value, per-document selectivity, and one target's full evidence.
