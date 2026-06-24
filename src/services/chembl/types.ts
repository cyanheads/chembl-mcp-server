/**
 * @fileoverview Domain types for the ChEMBL service layer. The flat `Molecule`,
 * `Activity`, `Target`, and `DrugInfo` shapes are the normalized view the tools
 * consume — numeric fields are coerced from upstream JSON strings to
 * `number | null` at the service boundary (absent → `null`, never `0`), and
 * nested upstream structures (`molecule_structures`, `molecule_properties`,
 * `target_components`, `target_component_synonyms`) are flattened here.
 * @module services/chembl/types
 */

/** Structure-search modes routed by `chembl_search_molecules`. */
export type SearchType = 'name' | 'exact' | 'similarity' | 'substructure';

/**
 * A compound as surfaced by search / molecule fetch. Numeric props are coerced
 * from upstream strings; absent → `null`.
 */
export interface Molecule {
  /** Calculated AlogP lipophilicity, e.g. 1.31. */
  alogp: number | null;
  /** Canonical SMILES from `molecule_structures.canonical_smiles`. */
  canonical_smiles: string | null;
  /** Full molecular formula, e.g. "C9H8O4". */
  full_molformula: string | null;
  /** Max clinical phase: 4 = marketed, 0/null = research. The cheap druggability signal. */
  max_phase: number | null;
  /** ChEMBL molecule ID, e.g. "CHEMBL25". */
  molecule_chembl_id: string;
  /** Molecule type, e.g. "Small molecule". */
  molecule_type: string | null;
  /** Molecular weight of the free base, e.g. 180.16. */
  mw_freebase: number | null;
  /** Lipinski rule-of-five violation count. */
  num_ro5_violations: number | null;
  /** Preferred name, e.g. "ASPIRIN". `null` for many research compounds. */
  pref_name: string | null;
  /** QED weighted drug-likeness score, 0–1. */
  qed_weighted: number | null;
  /** Tanimoto similarity percent — present only on similarity/substructure search. */
  similarity?: number | null;
  /** Standard InChIKey — chain to pubchem for richer chemistry. */
  standard_inchi_key: string | null;
}

/**
 * One bioactivity measurement — the compound↔target↔assay link. `standard_*` is
 * the normalized comparable view; the raw upstream fields are carried alongside.
 */
export interface Activity {
  /** ChEMBL activity row ID. */
  activity_id: number;
  /** ChEMBL assay ID — pass to chembl_get_assay for provenance. */
  assay_chembl_id: string;
  /** Assay description text. */
  assay_description: string | null;
  /** Assay type: B=binding, F=functional, A=ADMET, T=toxicity, P=physicochemical, U=unclassified. */
  assay_type: string | null;
  /** ChEMBL molecule ID for the measured compound. */
  molecule_chembl_id: string;
  /** Compound preferred name. `null` for many research compounds. */
  molecule_pref_name: string | null;
  /** −log10(molar potency); the rank field. `null` when underivable. */
  pchembl_value: number | null;
  /** Original relation string from upstream. */
  relation: string | null;
  /** Standardized relation: "=", ">", "<", etc. */
  standard_relation: string | null;
  /** Standardized activity type: "IC50" | "Ki" | "EC50" | … — the comparability key. */
  standard_type: string | null;
  /** Standardized units, e.g. "nM". */
  standard_units: string | null;
  /** Standardized value. Absent measurement → `null`, never `0`. */
  standard_value: number | null;
  /** ChEMBL target ID the compound was measured against. */
  target_chembl_id: string;
  /** Target organism, e.g. "Homo sapiens". */
  target_organism: string | null;
  /** Target preferred name. */
  target_pref_name: string | null;
  /** Original (pre-standardization) activity type string from upstream. */
  type: string | null;
  /** Original units string from upstream. */
  units: string | null;
  /** Original value string from upstream — not coerced. */
  value: string | null;
}

/** A protein/complex/cell-line/organism target component. */
export interface TargetComponent {
  /** UniProt accession, e.g. "P00533". */
  accession: string | null;
  /** Gene symbols flattened from component synonyms where syn_type starts with GENE_SYMBOL. */
  gene_symbols: string[];
}

/** A target — resolves a protein into the ChEMBL target ID get_bioactivities needs. */
export interface Target {
  /** Protein components with their UniProt accessions and gene symbols. */
  components: TargetComponent[];
  /** Organism, e.g. "Homo sapiens". */
  organism: string | null;
  /** Preferred name, e.g. "Epidermal growth factor receptor". */
  pref_name: string | null;
  /** ChEMBL target ID, e.g. "CHEMBL203". */
  target_chembl_id: string;
  /** Target type: "SINGLE PROTEIN" | "PROTEIN COMPLEX" | "CELL-LINE" | "ORGANISM" | … */
  target_type: string | null;
}

/** A drug mechanism of action joined to its molecular target. */
export interface Mechanism {
  /** Action type, e.g. "INHIBITOR" | "AGONIST" | "ANTAGONIST". */
  action_type: string | null;
  /** Mechanism of action, e.g. "Epidermal growth factor receptor erbB1 inhibitor". */
  mechanism_of_action: string | null;
  /** ChEMBL target ID the mechanism acts on. */
  target_chembl_id: string | null;
}

/** A clinical indication for a drug. */
export interface Indication {
  /** EFO term, e.g. "non-small cell lung carcinoma". */
  efo_term: string | null;
  /** Max clinical phase reached for THIS indication. */
  max_phase_for_ind: number | null;
  /** MeSH heading, e.g. "Carcinoma, Non-Small-Cell Lung". */
  mesh_heading: string | null;
}

/** Drug pharmacology — mechanisms + indications joined for one molecule. */
export interface DrugInfo {
  /** Year of first approval, from the molecule record. `null` if unapproved/unknown. */
  first_approval: number | null;
  /** Clinical indication(s). */
  indications: Indication[];
  /** Max clinical phase across all indications. */
  max_phase: number | null;
  /** Mechanism(s) of action. */
  mechanisms: Mechanism[];
  /** ChEMBL molecule ID. */
  molecule_chembl_id: string;
  /** Preferred name. */
  pref_name: string | null;
}

/** Assay provenance behind a bioactivity row. */
export interface Assay {
  /** ChEMBL assay ID. */
  assay_chembl_id: string;
  /** Assay type code: B=binding, F=functional, A=ADMET, T=toxicity, P=physicochemical, U=unclassified. */
  assay_type: string | null;
  /** Human-readable assay type, e.g. "Binding". */
  assay_type_description: string | null;
  /** Human-readable confidence description. */
  confidence_description: string | null;
  /** ChEMBL confidence score, 1–9 (9 = direct assay on the protein target). */
  confidence_score: number | null;
  /** Assay description text. */
  description: string | null;
  /** Assay organism. */
  organism: string | null;
  /** ChEMBL target ID the assay measures, when assigned. */
  target_chembl_id: string | null;
}

/** Result envelope carrying the upstream `page_meta.total_count` alongside rows. */
export interface Page<T> {
  /** The rows for this request (already capped by the caller's limit). */
  items: T[];
  /** Upstream `page_meta.total_count` — total matches before the limit. */
  totalCount: number;
}

/** Options for `searchMolecules` (name / ID / InChIKey lookup mode). */
export interface SearchMoleculesOptions {
  limit: number;
  maxPhaseMin?: number | undefined;
  query: string;
}

/** Options for `structureSearch` (exact / similarity / substructure). */
export interface StructureSearchOptions {
  limit: number;
  searchType: Extract<SearchType, 'exact' | 'similarity' | 'substructure'>;
  similarityThreshold: number;
  structure: string;
}

/** Options for `searchTargets`. */
export interface SearchTargetsOptions {
  accession?: string | undefined;
  geneSymbol?: string | undefined;
  limit: number;
  organism?: string | undefined;
  query?: string | undefined;
  targetType?: string | undefined;
}

/** Options for `getActivities` — exactly one of molecule/target id is set by the caller. */
export interface GetActivitiesOptions {
  assayType?: string | undefined;
  limit: number;
  moleculeChemblId?: string | undefined;
  organism?: string | undefined;
  pchemblValueMin?: number | undefined;
  standardType?: string | undefined;
  targetChemblId?: string | undefined;
}
