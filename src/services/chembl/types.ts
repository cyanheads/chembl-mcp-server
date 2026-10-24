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
  /**
   * The parent of the molecule's family — the ID ChEMBL files the salts and other
   * alternate forms under: `molecule_hierarchy.parent_chembl_id`, or the record's
   * own ID when ChEMBL records no hierarchy (it is then its family's parent). Never
   * `active_chembl_id`, which can name a different molecule (a prodrug's metabolite).
   */
  parent_chembl_id: string;
  /** Preferred name, e.g. "ASPIRIN". `null` for many research compounds. */
  pref_name: string | null;
  /** QED weighted drug-likeness score, 0–1. */
  qed_weighted: number | null;
  /** Tanimoto similarity percent — present only on `search_type=similarity` results. */
  similarity?: number | null;
  /** Standard InChIKey — chain to pubchem for richer chemistry. */
  standard_inchi_key: string | null;
}

/**
 * One bioactivity measurement — the compound↔target↔assay link. `standard_*` is
 * the normalized comparable view; the raw upstream fields are carried alongside.
 */
export interface Activity {
  /** Depositor or curator comment on the result, e.g. "Not Active" — often the only result when `standard_value` is null. */
  activity_comment: string | null;
  /** ChEMBL activity row ID. */
  activity_id: number;
  /** ChEMBL assay ID — pass to chembl_get_assay for provenance. */
  assay_chembl_id: string;
  /** Assay description text. */
  assay_description: string | null;
  /** Assay type: B=binding, F=functional, A=ADMET, T=toxicity, P=physicochemical, U=unclassified. */
  assay_type: string | null;
  /** UniProt accession of the assay's variant protein. `null` when no variant is recorded, and for "UNDEFINED MUTATION". */
  assay_variant_accession: string | null;
  /** The assay's recorded variant, e.g. "T315I", "L858R,T790M", "UNDEFINED MUTATION". `null` when none is recorded. */
  assay_variant_mutation: string | null;
  /** ChEMBL's data-validity annotation, e.g. "Outside typical range". `null` when unannotated. */
  data_validity_comment: string | null;
  /** ChEMBL document ID of the measurement's source publication or deposited dataset. */
  document_chembl_id: string | null;
  /** Publication year of the source document. `null` when it has none, as for deposited datasets. */
  document_year: number | null;
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
  /** The form of the drug's family the mechanism is recorded on, e.g. a salt. */
  molecule_chembl_id: string | null;
  /** ChEMBL target ID the mechanism acts on. */
  target_chembl_id: string | null;
}

/** One form of a family an indication is recorded on, at that form's own highest phase for it. */
export interface IndicationForm {
  /** Max clinical phase this form reached for the indication. */
  max_phase_for_ind: number | null;
  /** The form's ChEMBL molecule ID — the parent, a salt, or another alternate form. */
  molecule_chembl_id: string;
}

/**
 * A clinical indication for a drug's family: one per (`mesh_id`, `efo_id`) pair
 * across its forms, at the highest phase any form reached for it.
 */
export interface Indication {
  /** EFO ontology ID, e.g. "EFO:0003060". */
  efo_id: string | null;
  /** EFO term, e.g. "non-small cell lung carcinoma". */
  efo_term: string | null;
  /** The forms of the family the indication is recorded on, in upstream order, each at its own phase. */
  forms: IndicationForm[];
  /** Max clinical phase reached for THIS indication, the highest across `forms`. */
  max_phase_for_ind: number | null;
  /** MeSH heading, e.g. "Carcinoma, Non-Small-Cell Lung". */
  mesh_heading: string | null;
  /** MeSH descriptor ID, e.g. "D002289". */
  mesh_id: string | null;
}

/**
 * Retrieval state of one secondary list on a composed {@link DrugInfo}. The three
 * states a caller must be able to tell apart:
 *
 * - `complete` — every row ChEMBL records is present. An empty array here is a
 *   fact about the molecule.
 * - `truncated` — the single-request page cap bounded the list, so the array is a
 *   prefix of `*_total_count` rows.
 * - `failed` — the upstream request did not succeed ({@link ListFailure} says
 *   why), so the empty array is unknown data, NOT evidence that no rows exist.
 */
export type ListStatus = 'complete' | 'truncated' | 'failed';

/**
 * Why a `failed` list failed: `timeout` — the request ran out of time (its
 * per-attempt timeout or the call's budget) before ChEMBL returned the list;
 * `upstream_error` — ChEMBL answered with an error, or could not be reached.
 */
export type ListFailure = 'timeout' | 'upstream_error';

/**
 * Drug pharmacology for one molecule: its own record, joined to the mechanisms and
 * indications ChEMBL records across its family (the parent and its alternate forms).
 */
export interface DrugInfo {
  /** Year of first approval, from the molecule record. `null` if unapproved/unknown. */
  first_approval: number | null;
  /** Clinical indication(s). Empty is authoritative only when `indications_status` is `complete`. */
  indications: Indication[];
  /** Why `indications` failed; `null` unless `indications_status` is `failed`. */
  indications_failure: ListFailure | null;
  /**
   * Upstream indication rows fetched, before deduplication. When `truncated`, the
   * rows not fetched (`indications_total_count` minus this) bound the indications
   * missing. `null` when the fetch failed.
   */
  indications_rows_fetched: number | null;
  /** Retrieval state of `indications`. */
  indications_status: ListStatus;
  /**
   * The distinct indications when `complete`; ChEMBL's indication row total for the
   * family when `truncated`, an upper bound. `null` when the fetch failed — unknown,
   * never 0.
   */
  indications_total_count: number | null;
  /** Max clinical phase across all indications. */
  max_phase: number | null;
  /** Mechanism(s) of action. Empty is authoritative only when `mechanisms_status` is `complete`. */
  mechanisms: Mechanism[];
  /** Why `mechanisms` failed; `null` unless `mechanisms_status` is `failed`. */
  mechanisms_failure: ListFailure | null;
  /** Retrieval state of `mechanisms`. */
  mechanisms_status: ListStatus;
  /** Upstream mechanism total. `null` when the fetch failed — unknown, never 0. */
  mechanisms_total_count: number | null;
  /** ChEMBL molecule ID, as the molecule's own record writes it. */
  molecule_chembl_id: string;
  /** The family parent both lists were requested by ({@link Molecule.parent_chembl_id}). */
  parent_molecule_chembl_id: string;
  /** Preferred name. */
  pref_name: string | null;
}

/**
 * One page of a drug-info list: its normalized items, how many upstream rows they
 * came from, and the upstream `page_meta.total_count`. `rowCount` is what the
 * truncation check reads, since deduplication can leave fewer items than rows.
 */
export interface ListPage<T> {
  items: T[];
  rowCount: number;
  totalCount: number;
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

/** A page of a molecule search, whose route may stop counting at a ceiling. */
export interface MoleculePage extends Page<Molecule> {
  /**
   * `totalCount` is the search route's ceiling rather than a count: at least that
   * many compounds match, and ChEMBL serves no row past it.
   */
  totalCountCapped: boolean;
}

/** Options for `searchMolecules` (name / ID / InChIKey lookup mode). */
export interface SearchMoleculesOptions {
  limit: number;
  maxPhaseMin?: number | undefined;
  /** Zero-based row to start the upstream window at. Defaults to 0. */
  offset?: number | undefined;
  query: string;
}

/** Options for `structureSearch` (exact / similarity / substructure). */
export interface StructureSearchOptions {
  limit: number;
  /** Zero-based row to start the upstream window at. Defaults to 0. */
  offset?: number | undefined;
  searchType: Extract<SearchType, 'exact' | 'similarity' | 'substructure'>;
  similarityThreshold: number;
  structure: string;
}

/** Options for `searchTargets`. */
export interface SearchTargetsOptions {
  accession?: string | undefined;
  geneSymbol?: string | undefined;
  limit: number;
  /** Zero-based row to start the upstream window at. Defaults to 0. */
  offset?: number | undefined;
  organism?: string | undefined;
  query?: string | undefined;
  targetType?: string | undefined;
}

/**
 * Which side of the `pchembl_value` presence split a bioactivity query retrieves.
 * The two views partition the same match set exactly and are never combined:
 * ChEMBL sorts null-`pchembl_value` rows FIRST under a descending
 * `order_by=-pchembl_value`, so a merged stream would lead with the unrankable
 * rows and defeat the potency ranking.
 *
 * - `potency_ranked` — measurements with a derivable `pchembl_value`
 *   (`pchembl_value__isnull=false`), ordered most-potent-first. The default.
 * - `null_potency` — measurements with no derivable `pchembl_value`
 *   (`pchembl_value__isnull=true`), reachable only by asking for them.
 */
export type PotencyView = 'potency_ranked' | 'null_potency';

/**
 * The assay-variant filter of a bioactivity query: the rows that record no variant,
 * or the rows whose recorded variant equals `mutation` case-insensitively — the
 * whole recorded string, so "L858R" never matches "L858R,T790M".
 */
export type VariantFilter = { kind: 'wild_type' } | { kind: 'mutation'; mutation: string };

/**
 * Options for `streamActivities` / `countActivities` — at least one of molecule/target
 * id is set by the caller. Both together is legal and ANDs upstream, narrowing the
 * query to the measurements of that one compound against that one target. The count
 * reads only the filters; `offset` and `pageSize` shape the stream's page walk.
 */
export interface GetActivitiesOptions {
  assayType?: string | undefined;
  /**
   * The molecule scope: one form's own measurements (`form`, the
   * `molecule_chembl_id` filter), or every form's under a family parent (`family`,
   * the `parent_molecule_chembl_id` filter — pass a resolved
   * {@link Molecule.parent_chembl_id}; a salt's ID there matches nothing).
   */
  molecule?: { scope: 'form' | 'family'; id: string } | undefined;
  /**
   * Zero-based row of the view the stream starts at. Defaults to 0. The tool
   * derives it from a redeemed cursor; validate it before it gets here — ChEMBL
   * answers an offset it cannot read with page one rather than an error.
   */
  offset?: number | undefined;
  organism?: string | undefined;
  /**
   * Rows per upstream page, capped at `CHEMBL_MAX_PAGE_SIZE` and defaulting to it.
   * A walk that needs only a few rows asks for a page that size rather than
   * downloading a full page and discarding the rest.
   */
  pageSize?: number | undefined;
  pchemblValueMin?: number | undefined;
  /** Defaults to `potency_ranked` when omitted. */
  potencyView?: PotencyView | undefined;
  standardType?: string | undefined;
  targetChemblId?: string | undefined;
  variant?: VariantFilter | undefined;
}
