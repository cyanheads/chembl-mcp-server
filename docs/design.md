# chembl-mcp-server — Design

> Formalizes [`docs/idea.md`](./idea.md) into a buildable spec. The MCP surface is the contract;
> everything below it grounds implementation in the [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)
> framework and the live ChEMBL REST API (probed against `www.ebi.ac.uk/chembl/api/data/` during design).

Display identity is the hyphenated repo name **`chembl-mcp-server`** on every surface (`createApp()`
`name`/`title`, manifest `name`, docs headers) — never a Title-Cased "ChEMBL MCP Server".

---

## MCP Surface

### Tools

| Tool | Summary | readOnlyHint | openWorldHint | Key inputs | Output shape |
|---|---|---|---|---|---|
| `chembl_search_molecules` | Discovery entry point. Find compounds by name / ChEMBL ID / InChIKey, or run a structure search (exact \| similarity \| substructure) from a SMILES. `search_type` defaults to `name`; `structure` is required when `search_type` is `exact`, `similarity`, or `substructure`. At least one of `query` or `structure` must be supplied. | `true` | `true` | `query?`, `structure?`, `search_type` (default `name`), `similarity_threshold?` (integer 40–100, default 70), `max_phase_min?`, `limit` (cap 100; up to 10,000 clamps to 100 with a notice), `cursor?` | `{ molecules[], nextCursor? }` — ChEMBL ID, pref_name, canonical SMILES, formula, MW, AlogP, RO5 violations, QED, max_phase, family parent_chembl_id, (similarity score 0–100 when structure search); `totalCount`/`totalCountCapped`/`truncated`/`shown`/`cap` via enrichment — `totalCountCapped` marks a total equal to ChEMBL's name (10,000) or substructure (30,000) search ceiling, a lower bound, with a notice on every page of that search |
| `chembl_get_bioactivities` | **Flagship.** Bioactivity measurements for a molecule, a target, or **both** (the compound↔target↔assay bridge). At least one of `molecule_chembl_id` or `target_chembl_id` is required — both together ANDs upstream and narrows to that compound–target pair, neither is a `missing_filter` error. `include_alternate_forms` (default `false`) fetches `/molecule/{molecule_chembl_id}`, resolves its parent by the shared rule (§ Domain types), and swaps `molecule_chembl_id` for `parent_molecule_chembl_id` in the shared filter params, so the count, both views, cursor pages, and the spill read the whole family; set without `molecule_chembl_id` it is an `alternate_forms_without_molecule` error. IDs reach the filters trimmed and uppercased (Design Decisions, input normalization); without `include_alternate_forms`, a `molecule_chembl_id` that is no ChEMBL ID is a `not_a_chembl_id` error, since the exact filter could only answer zero rows. Filters by standard_type (exact, case included — a zero-row result triggers one best-effort `standard_type__iexact` lookup that names a recorded case variant in the notice), potency, assay type (a code or ChEMBL's name for it, mapped to the code), organism, and assay variant (`variant`: `"wild_type"` → `assay_variant_mutation__isnull=true`; any other value, with the spaces beside `,` / `/` removed → `assay_variant_mutation__iexact`, the whole recorded string — ChEMBL refuses `contains` / `startswith` / `regex` on the field). `potency_view` selects which side of the `pchembl_value` presence split is retrieved: `potency_ranked` (default, `pchembl_value__isnull=false`, ranked most-potent-first with ties broken on `activity_id`) or `null_potency` (`pchembl_value__isnull=true`, the rows the ranked view excludes, in `activity_id` order). Either view is walked by offset on that total order. `totalCount` spans both (separate `limit:1` call, no isnull filter). Large sets spill to DataCanvas, one table per view, capped at `CHEMBL_MAX_SPILL_ROWS`; a canvas is minted only on a spill, and a supplied `canvas_id` has the view re-staged on every non-cursor call, a spill replacing its table only once it succeeds. Whenever a call stages nothing (the canvas off, or an inline fit with no `canvas_id`), `cursor` / `nextCursor` walk the view a page at a time; a cursor page is always served inline and never stages, canvas or not. | `true` | `true` | at least one of `molecule_chembl_id?` / `target_chembl_id?`, `include_alternate_forms` (default `false`), `standard_type?`, `pchembl_value_min?`, `assay_type?`, `organism?`, `variant?`, `potency_view` (default `potency_ranked`), `limit` (cap 1,000; up to 10,000 clamps to 1,000 with a notice), `canvas_id?`, `cursor?` | `{ activities[], totalCount, potency_view, spilled, canvas_id, table_name, staged_row_count, truncated, truncated_by, canvasDisabled, nextCursor? }` per-measurement: molecule, target, assay (ID, type, description, variant mutation + accession), standard_type/relation/value/units, pchembl_value, raw type/value/units/relation, activity_comment, data_validity_comment, source document ID + year (assay confidence comes from `chembl_get_assay`) |
| `chembl_search_targets` | Resolve a protein/gene/UniProt accession → ChEMBL target ID that `get_bioactivities` needs. At least one of `query`, `accession`, or `gene_symbol` must be supplied; omitting all fails as `missing_input` (`InvalidParams`). | `true` | `true` | `query?`, `accession?` (uppercased), `gene_symbol?`, `organism?`, `target_type?` (uppercased), `limit` (cap 100; up to 10,000 clamps to 100 with a notice), `cursor?` | `{ targets[], nextCursor? }` — target_chembl_id, pref_name, target_type, organism, component accessions + gene symbols; `totalCount`/`truncated`/`shown`/`cap` via enrichment |
| `chembl_get_drug_info` | Pharmacology for a drug (molecule): mechanism(s) of action, molecular target(s), action type, first-approval year, indications + max phase. `molecule_chembl_id` comes from `chembl_search_molecules`. Both lists are read across the molecule's family by `parent_molecule_chembl_id`, the parent its own record resolves to — a parent and its salt answer alike. | `true` | `true` | `molecule_chembl_id` (from `chembl_search_molecules`, any case, or a standard InChIKey) | `{ molecule_chembl_id, parent_molecule_chembl_id, pref_name, max_phase, first_approval, mechanisms[], mechanisms_status, mechanisms_total_count, mechanisms_failure, indications[], indications_status, indications_total_count, indications_rows_fetched, indications_failure }` — each mechanism names the form it is recorded on, each indication is one (`mesh_id`, `efo_id`) pair at its highest phase with the forms it is recorded on, each at its own phase; each list carries its own `complete`\|`truncated`\|`failed` state + count, and a failed one says whether it timed out, so an empty array is never ambiguous |
| `chembl_get_assay` | Assay detail by assay ChEMBL ID — provenance behind a bioactivity row (type, target, organism, confidence). `assay_chembl_id` comes from a bioactivity row's `assay_chembl_id` field. | `true` | `true` | `assay_chembl_id` (from a bioactivity row) | `{ assay_chembl_id, description, assay_type, assay_type_description, target_chembl_id, organism, confidence_score, confidence_description }` (every field but the ID nullable) — confidence_score is ChEMBL's 1–9 scale (9 = direct assay on protein target) |
| `chembl_dataframe_query` | Run read-only SQL `SELECT` over the bioactivity rows `chembl_get_bioactivities` staged on a canvas (rank, group, dedupe, aggregate across the **full** set). Two independent bounds, each on its own field: the canvas row limit caps the result set (`truncated`), and a character budget caps the markdown table rendered into `content[]` (`rendered_rows`). SQL `LIMIT`/`OFFSET` pages past both. | `true` | `false` | `canvas_id`, `sql` | `{ rows[], row_count, rendered_rows, truncated }` — `truncated` signals the SQL result was row-capped by the canvas (not the spill); `rendered_rows` signals the rendered table was budget-capped (not the data) |
| `chembl_dataframe_describe` | List tables + columns staged on a canvas, so the agent can write correct SQL before calling `chembl_dataframe_query`. | `true` | `false` | `canvas_id` | `{ tables[] }` — name, kind (`table`\|`view`), row_count, columns (name + type) |
| `chembl_dataframe_drop` | Drop a named staged table from a canvas (`instance.drop`). **Opt-in** behind `CHEMBL_DATAFRAME_DROP_ENABLED=true` (default off) and **conditionally registered** — absent from `tools/list` when the flag is off. Off by default because the canvas's sliding TTL already reclaims staged tables; the tool only matters when an agent wants to free a large table early within a long session. | `false` | `false` | `canvas_id`, `table_name` | `{ dropped }` — `true` if the table existed and was dropped, `false` if the live canvas holds no table by that name; an unknown or expired `canvas_id` fails as `canvas_not_found` |

**8 tools** (7 always registered; `chembl_dataframe_drop` registers only when its env flag is on). The 5
from `idea.md`'s sketch, plus the 3 standardized DataCanvas consumer tools the spill in
`chembl_get_bioactivities` makes the home for — `idea.md` names `chembl_dataframe_query` explicitly
(Design Notes), and the framework's DataCanvas contract requires a `dataframe_query` tool wherever a
tool emits a `canvas_id` (a token with no query tool is dead output), with `dataframe_describe`
required alongside it so the agent can discover staged table/column names and `dataframe_drop` the
opt-in third (off by default; TTL handles cleanup). See **Design Decisions**.

### Resources

| URI template | Returns |
|---|---|
| `chembl://molecule/{chemblId}` | A molecule record by ChEMBL ID — the same shape a `chembl_search_molecules` row carries (ID, names, structures, properties, max_phase, family `parent_chembl_id`). Convenience injectable-context mirror of the per-molecule fetch. |
| `chembl://target/{chemblId}` | A target record by ChEMBL target ID — pref_name, type, organism, component accessions + gene symbols. |

Both are read-only, URI-addressable, and fully covered by the tool surface (a tool-only client never
needs them) — they exist only as injectable context for clients that support resources. `{chemblId}`
is a ChEMBL ID in any case, read as the uppercase ID (`chembl://molecule/chembl25` → `CHEMBL25`); anything
else is rejected before a fetch. **Shipped in v1** as optional convenience.

### Prompts

**None in v1.** The surface is data/action-oriented; the canonical workflows (below) are short tool
chains an agent composes directly, not multi-step templates worth shipping as prompts. The cross-server
chain guidance lives in `createApp()` `instructions` instead (see Config).

---

## Overview

`chembl-mcp-server` exposes [ChEMBL](https://www.ebi.ac.uk/chembl/) — EBI's manually-curated database
of bioactive drug-like molecules — over MCP. ChEMBL's unique value is the **curated link between
compounds, protein targets, and measured bioactivity** (IC50/Ki/EC50), plus drug mechanism-of-action
and clinical-indication data. The upstream is one keyless REST provider at
`https://www.ebi.ac.uk/chembl/api/data/`; everything is keyed by **ChEMBL IDs** (`CHEMBL25` = aspirin,
`CHEMBL203` = EGFR target) and resources are richly filterable with Django-style `field__op=` query
params (e.g. `standard_type=IC50&pchembl_value__gte=6`).

The server fills the gap between three existing fleet servers: `pubchem` knows a compound's *structure
and properties*, `openfda` knows an *approved drug's label and adverse events*, and `protein`/uniprot
know a *target's structure and function* — but none connects **"which compounds hit this target, how
potently, in what assay,"** the core of early drug discovery and pharmacology. The audience is
medicinal chemists, pharmacologists, cheminformaticians, and computational biologists doing target
validation or lead finding.

Primary agent workflows:

1. **Target → leads** — resolve a UniProt accession to a ChEMBL target, then pull the most potent
   compounds active against it (`chembl_search_targets` → `chembl_get_bioactivities`).
2. **Compound → target profile / selectivity** — what does this compound hit, and how hard
   (`chembl_get_bioactivities` by molecule, ranked on `pchembl_value`).
3. **Drug pharmacology** — mechanism of action, molecular target, and indications for a known drug
   (`chembl_search_molecules` → `chembl_get_drug_info`).
4. **Structure search** — find compounds similar to / containing a query structure
   (`chembl_search_molecules` with `search_type`).

`chembl_get_bioactivities` is the 80% tool and the reason the server exists: a target like a kinase
carries tens of thousands of measurements (confirmed: EGFR `CHEMBL203` has 58,847 in total, 26,600 of
them IC50), so it pairs an inline preview with a DataCanvas spill that the agent SQLs via
`chembl_dataframe_query`.

## Requirements

**Functional**

- Find compounds by name, ChEMBL ID, InChIKey, or structure (exact / similarity / substructure).
- Return bioactivity measurements bidirectionally — by molecule **or** by target — filterable by
  standard type, potency (`pchembl_value`), assay type, organism, and assay variant (wild type or one
  recorded mutant); ranked on `pchembl_value`. Each row carries its activity and data-validity
  comments, its assay variant, and its source document for citation.
- Resolve a protein (UniProt accession / gene symbol / name) to the ChEMBL target ID downstream tools need.
- Return drug pharmacology: mechanism(s) of action, target(s), action type, first-approval, indications.
- Return assay provenance (type, target, organism, confidence) for a given assay ChEMBL ID.
- Spill large bioactivity result sets to a DataCanvas table and expose read-only SQL over the full set.

**Non-functional / constraints**

- **No auth.** ChEMBL is keyless; server runs `MCP_AUTH_MODE=none` for stdio, no scopes on tools.
- **Rate limits.** ChEMBL is generous but unspecified; be a good citizen — a `User-Agent`, modest
  default `limit` (25), the framework's `withRetry` with ~1–2 s backoff on 429/5xx, and at most
  `CHEMBL_MAX_CONCURRENT_PAGES` spill pages in flight across the whole server. No batching
  endpoint exists (`filter.ids`-style bulk GET is not part of the ChEMBL data API), so single-record
  fetches stay single calls.
- **Every call settles under the client's timeout.** MCP SDK clients abandon a request at 60 s by
  default. All the upstream requests of one tool or resource call — chained, concurrent, retried —
  share one deadline: 45 s (`CALL_DEADLINE_MS`), or `CHEMBL_SPILL_DEADLINE_MS` for a canvas-on
  `chembl_get_bioactivities` call without a cursor (its count and spill walk, whether or not the view
  ends up spilling). No request starts once it is spent, each attempt's timeout is
  `CHEMBL_REQUEST_TIMEOUT_MS` or what is left, whichever is less, and `withRetry`'s `deadlineMs` ends the
  ladder at the expiry, or before an exponential backoff that would outlast it. Either stop fails as the
  retryable `upstream_timeout` (a `Retry-After` wait that would outlast the budget rethrows the
  attempt's own error, e.g. `rate_limited`); a caller's cancellation still surfaces as cancelled.
- **Licensing / attribution.** ChEMBL data is **CC BY-SA 3.0**. Share-alike binds downstream
  *redistribution* of the data, not serving it via MCP; the practical obligation is **attribution in
  output** — carry a source/attribution line. Surface it in `instructions` and/or per-tool output.
- **Data fidelity (scientific data).** Never fabricate a missing potency. A measurement without a
  `standard_value` is `null`, never `0`. Numeric fields arrive from ChEMBL as **strings** — coerce at
  the service boundary, and a non-numeric/absent value coerces to `null`, not a silent default.
- **Freshness.** Live API; no local mirror in v1 (the corpus is large but per-query filters keep
  payloads bounded, and the analytical path is the canvas, not a mirror).

**Out of scope (v1)**

- Compound registration / standardization / any write to ChEMBL (read-only database).
- Document/literature endpoints (`/document`), ATC classification, the cell-line and tissue resources —
  not part of the compound↔target↔activity workflow.
- A local bulk mirror (MirrorService) and 3D/conformer structure data — deferred.

## Data Model

ChEMBL identifiers are all opaque `CHEMBL\d+` strings, but they name **different entity classes** —
an agent must not pass a molecule ID where a target ID is expected. How each is obtained is the
load-bearing detail:

| ID | Format | Names | Obtained from |
|---|---|---|---|
| Molecule ChEMBL ID | `CHEMBL\d+` | a compound/drug | `chembl_search_molecules` rows; a bioactivity row's `molecule_chembl_id` |
| Target ChEMBL ID | `CHEMBL\d+` | a protein/complex/cell-line/organism target | `chembl_search_targets` rows; a bioactivity row's `target_chembl_id` |
| Assay ChEMBL ID | `CHEMBL\d+` | one assay | a bioactivity row's `assay_chembl_id` (input to `chembl_get_assay`) |
| `canvas_id` | opaque 10-char | a DataCanvas holding a staged view | returned by `chembl_get_bioactivities` when the view spills (minting the canvas), and echoed back when a supplied one was re-staged |

Because the three ID classes share the `CHEMBL\d+` shape, the **field name** in every schema is the
disambiguator (`molecule_chembl_id` vs `target_chembl_id` vs `assay_chembl_id`), and each `.describe()`
states which class and which tool emits it.

```ts
/** A compound as surfaced by search / molecule fetch. Numeric props are coerced from upstream strings; absent → null. */
interface Molecule {
  molecule_chembl_id: string;        // "CHEMBL25"
  pref_name: string | null;          // "ASPIRIN" — null for many research compounds
  canonical_smiles: string | null;   // from molecule_structures.canonical_smiles
  standard_inchi_key: string | null; // chain to pubchem for richer chemistry
  full_molformula: string | null;    // "C9H8O4"
  mw_freebase: number | null;        // 180.16  (upstream "180.16")
  alogp: number | null;              // 1.31
  num_ro5_violations: number | null; // Lipinski rule-of-five violations
  qed_weighted: number | null;       // 0.55  drug-likeness
  max_phase: number | null;          // 4 = approved, 3–1 trial, 0.5 early phase 1, −1 phase unknown, null = no clinical record
  molecule_type: string | null;      // "Small molecule"
  parent_chembl_id: string;          // family parent — see the parent rule below
  similarity?: number | null;        // percent — present only on search_type=similarity
}

/** One bioactivity measurement — the compound↔target↔assay link. standard_* is the normalized view; raw carried alongside. */
interface Activity {
  activity_id: number;
  molecule_chembl_id: string;
  molecule_pref_name: string | null;
  target_chembl_id: string;
  target_pref_name: string | null;
  target_organism: string | null;
  assay_chembl_id: string;           // → chembl_get_assay
  assay_type: string | null;         // B=binding, F=functional, A=ADMET, …
  assay_description: string | null;
  standard_type: string | null;      // "IC50" | "Ki" | "EC50" | … — the comparability key
  standard_relation: string | null;  // "=", ">", "<"
  standard_value: number | null;     // 1270.0  (upstream "1270.0"); MISSING → null, never 0
  standard_units: string | null;     // "nM"
  pchembl_value: number | null;      // 5.90 = −log10(molar potency); the rank field. null when underivable
  // raw upstream fields carried alongside (before standardization):
  type: string | null;               // original activity type string from upstream
  value: string | null;              // original value string from upstream (not coerced)
  units: string | null;              // original units string from upstream
  relation: string | null;           // original relation string from upstream
  activity_comment: string | null;   // "Not Active" — often the only result when standard_value is null
  data_validity_comment: string | null;   // "Outside typical range", "Manually validated", …
  assay_variant_mutation: string | null;  // "T315I", "L858R,T790M", "UNDEFINED MUTATION"; null = none recorded
  assay_variant_accession: string | null; // UniProt accession of the variant; null for UNDEFINED MUTATION
  document_chembl_id: string | null; // source publication or deposited dataset — the citation
  document_year: number | null;      // null for deposited datasets
}

/** A target — resolves a protein into the ChEMBL target ID get_bioactivities needs. */
interface Target {
  target_chembl_id: string;          // "CHEMBL203"
  pref_name: string | null;          // "Epidermal growth factor receptor"
  target_type: string | null;        // "SINGLE PROTEIN" | "PROTEIN COMPLEX" | "CELL-LINE" | "ORGANISM" | …
  organism: string | null;           // "Homo sapiens"
  components: Array<{
    accession: string | null;        // UniProt accession "P00533"
    gene_symbols: string[];          // flattened from target_component_synonyms where syn_type startsWith GENE_SYMBOL
  }>;
}

/** Retrieval state of one secondary list on a composed DrugInfo. */
type ListStatus = 'complete' | 'truncated' | 'failed';

/** Why a 'failed' list failed: it ran out of time, or ChEMBL answered with an error / was unreachable. */
type ListFailure = 'timeout' | 'upstream_error';

/** Drug pharmacology — one molecule's record, joined to the lists recorded across its family. */
interface DrugInfo {
  molecule_chembl_id: string;            // as the molecule's own record writes it
  parent_molecule_chembl_id: string;     // the family parent both lists were requested by
  pref_name: string | null;
  max_phase: number | null;
  first_approval: number | null;         // year, from the molecule record
  mechanisms: Array<{
    molecule_chembl_id: string | null;   // the form the mechanism is recorded on
    target_chembl_id: string | null;
    mechanism_of_action: string | null;  // "Epidermal growth factor receptor erbB1 inhibitor"
    action_type: string | null;          // "INHIBITOR" | "AGONIST" | …
  }>;
  mechanisms_status: ListStatus;         // empty [] is authoritative only when 'complete'
  mechanisms_total_count: number | null; // upstream total; null when the fetch failed — never 0
  mechanisms_failure: ListFailure | null; // why a 'failed' list failed; null otherwise
  indications: Array<{                   // one per (mesh_id, efo_id) across the forms
    mesh_id: string | null;              // "D002289"
    mesh_heading: string | null;         // "Carcinoma, Non-Small-Cell Lung"
    efo_id: string | null;               // "EFO:0003060"
    efo_term: string | null;             // "non-small cell lung carcinoma"
    max_phase_for_ind: number | null;    // highest phase any form reached for THIS indication
    forms: Array<{                       // the forms it is recorded on, in upstream order
      molecule_chembl_id: string;
      max_phase_for_ind: number | null;  // THIS form's highest phase for the indication
    }>;
  }>;
  indications_status: ListStatus;
  indications_total_count: number | null; // distinct when complete; upstream row total (upper bound) when truncated
  indications_rows_fetched: number | null; // upstream rows fetched, before merging; null when the fetch failed
  indications_failure: ListFailure | null;
}
```

**One parent rule, derived where the molecule record is normalized.** `parent_chembl_id` is
`molecule_hierarchy.parent_chembl_id`, or the record's own `molecule_chembl_id` when ChEMBL records no
hierarchy — it is then its family's parent (rapacuronium `CHEMBL1201352` records none, and its one
mechanism sits on another form filed under it). `active_chembl_id` is never followed: a prodrug's active
metabolite is a different molecule. Every endpoint behind `chembl_search_molecules` and
`chembl://molecule` carries `molecule_hierarchy`, so every row names its parent, and both family reads —
`chembl_get_drug_info` and `chembl_get_bioactivities` under `include_alternate_forms` — take the parent
from the same normalized record. The family can hold isotope-labelled and deuterated analogs as well as
salts (sorafenib's holds donafenib, `CHEMBL4297490`), hence "alternate forms".

**Drug info keys every list off the molecule record, never the caller's string.** ChEMBL often records a
drug's mechanisms and approved indications on a salt (erlotinib `CHEMBL553` holds none of its own; its
EGFR mechanism sits on the hydrochloride `CHEMBL1079742`), so `getDrugInfo` fetches `/molecule/{id}`
first and requests `/mechanism` and `/drug_indication` by `parent_molecule_chembl_id` — a salt's ID
passed there matches nothing — under the call's one deadline. A family records an indication once per
form, often at different phases, so rows sharing a (`mesh_id`, `efo_id`) pair merge into one at the
highest phase, listing each form at its own highest phase — the family maximum alone would hand
sorafenib's deuterated analog donafenib (`CHEMBL4297490`, phase 2 for hepatocellular carcinoma) the
tosylate's phase 4; a row with neither ID has nothing to match on and stays its own. The
anchor costs one round trip before the lists start. A caller cancellation
while the lists are in flight fails the call as the cancellation, never as two failed lists.

**The two secondary lists carry their own retrieval state.** `mechanisms` and `indications` are
fetched independently of the molecule record, so an empty array has three possible causes an agent must
be able to tell apart: ChEMBL records none (`complete`), the single-request page cap bounded the list
(`truncated`: the family's `page_meta.total_count` exceeds the rows fetched), or the fetch failed
(`failed`, count `null` — unknown, never `0`, the same fidelity rule the numeric coercion follows).
`*_failure` says why a list failed: `timeout` when the request ran out of time (a sanitized `Timeout`:
the attempt's own timeout, or the call's budget spent before, during, or between attempts), else
`upstream_error` — so a list that ran out of time is never worded as ChEMBL rejecting it. A
complete list's `*_total_count` is its array length — for indications, the distinct pairs after
deduplication; a truncated one reports the upstream row total, for indications an upper bound on the
distinct pairs. `indications_rows_fetched` carries the rows the page held: each row not fetched adds
at most one indication, so the truncation notice bounds the missing indications by total minus rows
fetched, and marks each shown indication's phase and forms as lower bounds. Each list is one request at `CHEMBL_MAX_PAGE_SIZE` rather than a page walk: a family's
indication rows run to the low hundreds at the extreme (211 for metformin's, the largest observed), which
one round trip covers, and `page_meta.total_count` rides back so a list that still overflows reports
itself truncated instead of passing itself off as complete.

**Canvas tables — `bioactivities` and `bioactivities_null_potency`.** When `chembl_get_bioactivities`
spills, the staged table holds flat `Activity` rows (coerced numerics) so SQL aggregates are honest.
Each `potency_view` stages its own table, and the two partition the match set exactly — run both
against one `canvas_id` and `UNION ALL` over the pair rebuilds the honest full rowset in SQL, without
ever putting the unrankable rows at the head of a potency-ranked stream. Both tables carry the same
schema: the spill registers every field the handler yields — all **24 columns** available for SQL:
`activity_id`, `molecule_chembl_id`, `molecule_pref_name`, `target_chembl_id`, `target_pref_name`,
`target_organism`, `assay_chembl_id`, `assay_type`, `assay_description`, `standard_type`,
`standard_relation`, `standard_value` (DOUBLE), `standard_units`, `pchembl_value` (DOUBLE),
the raw upstream `type`, `value`, `units`, `relation` (carried as-is, uncoerced strings),
`activity_comment`, `data_validity_comment`, `assay_variant_mutation`, `assay_variant_accession`,
`document_chembl_id`, and `document_year` (INTEGER).
Aggregate signal (median potency, distinct-compound count) MUST be computed in SQL over the full
table, never over the inline preview — and rank on the `standard_*` / `pchembl_value` columns, not the
raw `type`/`value`/`units`/`relation` (those are present for audit but are not normalized for comparison).

## Services

| Service | Responsibility | Key methods |
|---|---|---|
| `ChemblService` (`src/services/chembl/chembl-service.ts`) | The single upstream client. Wraps `https://www.ebi.ac.uk/chembl/api/data/`; builds Django-style filtered URLs, fetches `.json`, walks a bioactivity view by offset, asking every activity page (inline, cursor, and spill alike) for only the 24 raw fields the per-measurement output reads (`only=`, from one field list the raw type and the normalizer are checked against — ChEMBL drops an unknown name with HTTP 200, so a missing one would read as a silent `null`; a page is about half the bytes of the 47-field default), **coerces string numerics → number/null at the boundary**, flattens nested structures (`molecule_structures`, `molecule_properties`, `target_components`) into the flat domain types above. Each method wraps its full fetch+parse in `withRetry` under one call deadline (`CallDeadline`), started at entry or passed in by a caller chaining methods; one `createPacer({ maxConcurrent })` per service caps the spill-page requests in flight across all calls. | `searchMolecules(opts)`, `structureSearch(opts)`, `countActivities(opts)`, `streamActivities(opts)` (the sequential inline page walk), `spillActivities(opts, walk)` (the concurrent, offset-ordered spill walk for spillover), `searchTargets(opts)`, `getMolecule(id)`, `getMechanisms(parentId)`, `getIndications(parentId)`, `getDrugInfo(molId)`, `getAssay(id)` |
| `canvas-accessor` (`src/services/canvas-accessor.ts`) | Module-level holder for the optional `DataCanvas` wired in `createApp({ setup })`. `getCanvas()` returns `undefined` when canvas is disabled. | `setCanvas(core.canvas)`, `getCanvas()` |

`chembl_get_bioactivities` uses `spillover({ canvas, source: chembl.spillActivities(...), previewChars, tableName: <the view's table, or its staging table>, schema: ACTIVITY_CANVAS_SCHEMA, caps: { maxRows: CHEMBL_MAX_SPILL_ROWS }, signal })`
(with `previewChars = max(50_000, limit * 800)`: real rows serialize to 690–870 characters on
average, so the fit-vs-spill line sits at about `limit` average rows and a view much larger than
`limit` spills) — preview rows inline, the selected `potency_view`
staged as its own table. The walk fetches the first page alone (it carries the view total), then
every remaining offset below the view total and `CHEMBL_MAX_SPILL_ROWS` through an ordered window of
`CHEMBL_MAX_CONCURRENT_PAGES` pending pages, yielding rows in offset order whatever order the pages
land in; each page request queues on the service's pacer inside its retry. The first page failure
abandons the walk's other pages. One `CHEMBL_SPILL_DEADLINE_MS` deadline covers the count and the walk:
at expiry the contiguous prefix stages with `truncated_by: 'time_budget'`, and with nothing fetched the
call fails as `upstream_timeout`. A page whose retries `withRetry` stops short of an exponential backoff
the budget cannot hold counts as expiry too: it fails while the deadline still has time left, and its sanitized
`upstream_timeout` carries `retry_deadline_exceeded` on `cause`. No page starts unless more of the
budget is left than the latest page to land took on its final attempt (queueing included, its failed
attempts and their backoff not): once the budget would not hold another page, the walk ends after the
pages in flight and the prefix stages the same way, before the deadline expires. `spillover()` never closes a source it stops reading early, so the
handler closes the walk afterwards, releasing pages still in flight. `previewChars` is a character budget on the drain buffer, not a row cap, so the
handler keeps the walk's first `limit` rows as they pass to `spillover()` and returns those, a full
`limit` on a spill however few rows the buffer held (see *Output Design Notes*). Without a
`canvas_id`, `spillover()` receives a stand-in instance that mints the canvas on its first
`registerTable` — which `spillover()` makes only on a spill — so a call whose view fits inline never
holds a tenant canvas slot, and a spill whose registration fails releases the canvas it minted before
the error propagates (the stand-in goes once the framework acquires lazily, cyanheads/mcp-ts-core#501).
A supplied `canvas_id` is acquired up front and re-staged on every non-cursor call. A spill goes
through `spillover()` under a per-call staging table (`<view table>_staging_<12 hex>`), since
registering under the view's own name drops its earlier table before the first row lands: once the
spill succeeds (a deadline-cut prefix included), the handler drops the view's table, copies the
staging table in with `query('SELECT * FROM <staging>', { registerAs, preview: 0 })`, and drops the
staging table. `registerAs` refuses a name that exists (`register_as_clash`) rather than replacing
it, so the swap is drop-then-copy; it takes no signal, so a cancellation cannot land inside it, and
one already observed when it would begin drops the staging table and leaves the earlier table. A
spill that fails or is cancelled leaves only its staging table to `spillover()`'s cleanup. An inline
fit (zero rows included) is registered under the view's name with the declared schema, capped at
`CHEMBL_MAX_SPILL_ROWS`; one whose call was cancelled by the time it would write leaves the earlier
table. Every write onto a supplied canvas's view table, swap or re-stage, waits for the one before it,
so two same-view calls that finish together both land, the later one last; a failed write hands the
turn on. A minted canvas has no earlier table and spills straight to the view's name. A view always ends up under its own fixed table name, so a second query of
the **same** view **replaces (overwrites)** its prior rows rather than appending to them, while the
other view's table is left intact. `chembl_get_drug_info` fetches `getMoleculeApproval` first (its
failure fails the call), then composes `getMechanisms` + `getIndications` on the record's parent with
`Promise.allSettled`, so one secondary list failing degrades that list rather than tanking the call — but
it degrades to `status: 'failed'` with a `null` count, never to a bare empty array that would read as
"ChEMBL records none". `getMechanisms` / `getIndications` return `ListPage<T>` (items, upstream rows
fetched, upstream `total_count`), which is what lets the composer classify each list `complete` /
`truncated` / `failed` even after deduplication leaves fewer items than rows. `chembl_search_targets` validates at least one of `query`,
`accession`, or `gene_symbol` is non-empty at the handler level — Zod marks all three optional for
form-client compatibility, but the handler throws `missing_input` when all are absent/blank.

No `MirrorService` and no second upstream — ChEMBL is the only source, so there is no multi-source
fan-out or fallback chain.

## Config

`src/config/server-config.ts` — lazy `parseEnvConfig` over a Zod schema, env-var names mapped so errors
name the variable, not the path.

| Env var | Field | Required | Default | Purpose |
|---|---|---|---|---|
| `CHEMBL_API_BASE_URL` | `apiBaseUrl` | no | `https://www.ebi.ac.uk/chembl/api/data` | Override the upstream base (private mirror / pinned host). |
| `CHEMBL_REQUEST_TIMEOUT_MS` | `requestTimeoutMs` | no | `30000` | Per-attempt timeout for an upstream request, capped by what is left of the call's deadline (45 s, or `CHEMBL_SPILL_DEADLINE_MS` for a spill). |
| `CHEMBL_MAX_PAGE_SIZE` | `maxPageSize` | no | `1000` | Rows per upstream ChEMBL page. The bioactivity spill walks pages of this size; an inline bioactivity page (canvas off, or a cursor page) requests `min(limit, CHEMBL_MAX_PAGE_SIZE)` rows, since nothing past `limit` would be kept. |
| `CHEMBL_DEFAULT_LIMIT` | `defaultLimit` | no | `25` | Default `limit` applied when callers omit it; keeps preview sizes sane. |
| `CHEMBL_MAX_SPILL_ROWS` | `maxSpillRows` | no | `50000` | Hard ceiling on rows staged to a canvas table, and so on the upstream page walk behind it: no page is requested at or past it (50,000 rows = 50 ChEMBL page fetches at the 1,000-row page cap). Over the cap the response reports `truncated: true`, `truncated_by: 'row_cap'`. Deployment-shaped — a shared hosted instance tightens it, a local stdio session can raise it. |
| `CHEMBL_MAX_CONCURRENT_PAGES` | `maxConcurrentPages` | no | `4` | Spill-page requests in flight at once (1–6), shared by every call on the server through one pacer; each spill keeps at most this many pages pending, so concurrent calls interleave. |
| `CHEMBL_SPILL_DEADLINE_MS` | `spillDeadlineMs` | no | `45000` | Time budget for one spill's count and page walk (10,000–600,000). At expiry the fetched prefix stages with `truncated: true`, `truncated_by: 'time_budget'`; with nothing fetched the call fails as `upstream_timeout`. The default settles under a client's 60 s request timeout; raise it only for a client that waits longer. |
| `CANVAS_PROVIDER_TYPE` | (framework) | no | `duckdb` | DataCanvas provider for the bioactivity spill + SQL path. The framework defaults it to `none`; `src/index.ts` sets `duckdb` once `.env` is loaded. Set to `none` to disable it: `chembl_get_bioactivities` then inlines a preview but never spills, and `chembl_dataframe_*` return a "canvas disabled" error. |
| `CHEMBL_DATAFRAME_DROP_ENABLED` | `dataframeDropEnabled` | no | `false` | Opt-in toggle for the `chembl_dataframe_drop` tool. Off by default — the canvas's sliding TTL already reclaims staged tables, so the explicit drop is unnecessary in the common case. Set `true` only when agents need to free a large staged table early within a long session; the tool is conditionally registered, so it is absent from `tools/list` when this is off. `z.stringbool()` so `=false` actually disables. |

No API key — ChEMBL is keyless, so there is no degraded-without-key mode to document. The capability
gate is `CANVAS_PROVIDER_TYPE`: under `none`, the analytical SQL path is off and the flagship tool
returns the view a page at a time through `cursor` / `nextCursor` (documented in its description and
surfaced via `enrichment`).
`CHEMBL_DATAFRAME_DROP_ENABLED` is the only other toggle — a feature flag for the opt-in drop tool, not
a degraded mode.

`createApp({ instructions })` carries the cross-server chain guidance and the CC BY-SA attribution line
(session-level context, set once rather than repeated across every tool description).

## Implementation Order

Each step is independently buildable + testable.

1. **Config + identity** — `server-config.ts` (Zod schema, env mapping); set `createApp()`
   `name`/`title` to `chembl-mcp-server`, add `instructions` (cross-server chain + attribution), wire
   the `setup(core)` → `setCanvas(core.canvas)` callback. Delete the echo tool/resource/prompt scaffold.
2. **`ChemblService`** — URL builder, `.json` fetch + the offset page walk, the string→number/null
   coercion layer, nested-structure flattening into the flat domain types. Add the canvas-accessor
   module. Unit-test coercion (string "180.16" → 180.16; absent → null) and a sparse-payload case.
3. **`chembl_search_targets`** — needed first; it produces the target IDs the flagship consumes.
   Accession / gene-symbol / name / organism filters; flatten components + gene symbols.
4. **`chembl_search_molecules`** — name/ID/InChIKey search + the three structure modes via
   `search_type`. Coerce + surface `max_phase` on every row.
5. **`chembl_get_bioactivities`** — the flagship. molecule/target at-least-one input gate; standard_type /
   pchembl / assay_type / organism / variant filters; `spillover()` to the `potency_view`'s table; inline preview;
   `enrichment` truncation/total + spill notice.
6. **`chembl_dataframe_query` + `chembl_dataframe_describe` + `chembl_dataframe_drop`** — the
   standardized 3-tool canvas surface (query + describe mandatory once step 5 emits a `canvas_id`; drop
   opt-in behind `CHEMBL_DATAFRAME_DROP_ENABLED`, conditionally registered so it is absent from
   `tools/list` when off).
7. **`chembl_get_drug_info`** — the molecule record, then a `Promise.allSettled` compose of the family's mechanisms + indications by its parent.
8. **`chembl_get_assay`** — single fetch, confidence decode.
9. **Resources (optional)** — `chembl://molecule/{chemblId}`, `chembl://target/{chemblId}` if shipping in v1.
10. **Polish** — `format()` parity per tool, field `.describe()` audit, `devcheck`, field-test the flagship against a real kinase target.

## Workflow Analysis

The cross-tool ID hops are the heart of this server — each is made explicit in schemas (`.describe()`
states which tool emits the ID) so a weaker model chains correctly.

**W1 — Target → potent leads (the flagship path).** "What are the most potent inhibitors of EGFR?"

| # | Call | Why / what it emits |
|---|---|---|
| 1 | `chembl_search_targets({ accession: 'P00533' })` or `({ gene_symbol: 'EGFR', organism: 'Homo sapiens' })` | Resolves the protein → `target_chembl_id` (e.g. `CHEMBL203`). The accession comes from the `uniprot`/`protein` server. |
| 2 | `chembl_get_bioactivities({ target_chembl_id: 'CHEMBL203', standard_type: 'IC50', pchembl_value_min: 7 })` | Bioactivity rows for that target. 10,618 EGFR IC50 rows at pChEMBL ≥ 7 (of 26,600 IC50 measurements, 19,378 of which carry a `pchembl_value`) → **spills**; returns `canvas_id` + `bioactivities` table + inline top-N preview. |
| 3 | `chembl_dataframe_describe({ canvas_id })` then `chembl_dataframe_query({ canvas_id, sql })` | SQL the full set: `SELECT molecule_chembl_id, MEDIAN(pchembl_value) … GROUP BY molecule_chembl_id ORDER BY 2 DESC` — honest aggregate over all rows, not the preview. |

> **Correctness trap surfaced here:** mixing IC50 and Ki is invalid. The `standard_type` filter is
> prominent on `chembl_get_bioactivities` precisely so the agent ranks within one measurement type.

**W2 — Compound → target profile / selectivity.** "What does this compound hit?"

`chembl_search_molecules({ query: 'imatinib' })` → take `molecule_chembl_id` →
`chembl_get_bioactivities({ molecule_chembl_id })` ranked on `pchembl_value`. Same spill+SQL path when
the compound is promiscuous. To judge whether two measurements are comparable, take an
`assay_chembl_id` from a row → `chembl_get_assay` for type + confidence.

**W3 — Drug pharmacology.** "What is gefitinib for, and how does it work?"

`chembl_search_molecules({ query: 'gefitinib' })` → `molecule_chembl_id` (`CHEMBL939`) →
`chembl_get_drug_info({ molecule_chembl_id: 'CHEMBL939' })` → mechanism (EGFR inhibitor, `INHIBITOR`,
target `CHEMBL203`) + indications (non-small-cell lung carcinoma, max phase 4). Distinct from
`openfda`'s label/adverse-event view. When the search ranks a salt first (`ERLOTINIB HYDROCHLORIDE`,
`CHEMBL1079742`, ahead of `CHEMBL553`), either ID returns the same family pharmacology, and the row's
`parent_chembl_id` names the parent to pass to `chembl_get_bioactivities` with
`include_alternate_forms` for the family's measurements.

**W4 — Cross-server identity (the payoff, documented in `instructions`).**

- UniProt accession (`uniprot`/`protein`) → `chembl_search_targets` → `chembl_get_bioactivities` — canonical.
- A molecule's `standard_inchi_key` → `pubchem` (`pubchem_search_compounds` by InChIKey) for richer chemistry / safety / interactions.
- An approved drug (`max_phase: 4`) → `openfda` for the FDA label and real-world adverse events.

## Design Decisions

- **Structure search consolidated under `chembl_search_molecules` via a `search_type` enum**
  (`name` \| `exact` \| `similarity` \| `substructure`) rather than three tools. ChEMBL exposes them as
  distinct endpoints (`/molecule/search` for name text, `/molecule/{id}` for an exact ChEMBL ID or InChIKey, `/molecule/{smiles}` for exact, `/similarity/{smiles}/{threshold}` for similarity, `/substructure/{smiles}` for substructure); the handler routes by `search_type`. Default is `name`. `structure` (SMILES string) is required for `exact`/`similarity`/`substructure`; `query` is required for `name`. `similarity_threshold` is an integer 40–100 (ChEMBL rejects values below 40); default 70. Keeps the discovery surface one tool. Handler validates at least one of `query`/`structure` is present and that `structure` accompanies structure-mode `search_type` values — throws `missing_input` otherwise.
- **`chembl_get_bioactivities` is one bidirectional tool, not `get_compound_activities` +
  `get_target_activities`.** The molecule↔target bridge is symmetric and shares all filters; an
  at-least-one input gate (`molecule_chembl_id`, `target_chembl_id`, or both) keeps the surface tight.
  The gate is enforced at the handler level (not Zod — Zod can't express a cross-field requirement over two optionals): both absent → `ctx.fail('missing_filter', …)`. Both present is a legitimate query — ChEMBL ANDs the two filters, so the pair resolves to that one compound against that one target. This is the tool the server exists for, so it gets the prominent `standard_type` filter and the spill.
- **Input normalization at the schema edge** (`src/mcp-server/input-normalization.ts`). ChEMBL's
  by-resource lookups (`/molecule/chembl941`) match a ChEMBL ID in any case, but every list filter
  matches exactly, so a lowercase ID or code would return an empty success. Each input schema
  parses a value to the form ChEMBL records before the handler sees it: ChEMBL IDs trimmed and
  uppercased, a blank optional value read as unset; `accession` and `target_type` uppercased (every
  live accession and all target types are uppercase; ChEMBL answers `target_type__iexact` with HTTP
  500); `assay_type` mapped from a code or ChEMBL's name for it (`binding`, `ADMET`, `Unclassified`, …)
  to `B` / `F` / `A` / `T` / `P` / `U`. JSON Schema `pattern` takes no flags, so each advertised pattern
  spells the case and whitespace variants out (`^\s*[Cc][Hh][Ee][Mm][Bb][Ll]\d+\s*$`, the linear
  `^\s*(?:…\s*)?$` form on optional fields), and a schema-validating client refuses none of the forms the
  server maps. `standard_type` stays exact — ChEMBL holds distinct types that differ only by case
  (`Kd`/`KD`, `Inhibition`/`INHIBITION`, `Activity`/`activity`) — and on a zero-row result one
  `standard_type__iexact` request (`limit: 1`, no retry, on a 5 s budget of its own capped by what the
  call's deadline has left) names a recorded case variant in the notice; its failure or timeout leaves
  the plain zero-hit notice. `limit` above a tool's cap (100 /
  100 / 1,000) is served at the cap with a notice, up to a schema ceiling of 10,000. Untouched:
  `chembl_search_molecules` `query` (a lowercase ID stays on the fuzzy path, #7), and the `gene_symbol`,
  `organism`, and `variant` filters, which already match case-insensitively.
- **Molecule references stay open where the molecule record resolves them.** `chembl_get_drug_info`'s
  `molecule_chembl_id`, and `chembl_get_bioactivities`'s under `include_alternate_forms`, go to
  `/molecule/{ref}`, which answers a ChEMBL ID in any case, an uppercase InChIKey, and a SMILES
  (`CC(=O)Oc1ccccc1C(=O)O` → `CHEMBL25`). Their schemas carry no ID pattern, so no call that resolves
  today is refused: a ChEMBL ID or InChIKey in any case is uppercased, and anything else passes trimmed,
  its case intact. Only the exact `molecule_chembl_id` filter (without `include_alternate_forms`) gates
  on the ChEMBL ID shape, as `not_a_chembl_id`, since nothing else can match it.
- **DataCanvas spill — bioactivities only.** It clears both gates: the data is *analytical* (agents run
  `GROUP BY` / `MEDIAN` over potency across thousands of rows) and *too big to inline* (a single target
  = thousands of measurements). Search/target/drug/assay results are discovery or single-record — they
  inline, no canvas. This is why only `chembl_get_bioactivities` emits a `canvas_id`.
- **The three `dataframe_*` tools are the standardized canvas surface, not scope creep.** The framework's
  DataCanvas contract defines a three-tool standard wherever a tool emits a `canvas_id`:
  `chembl_dataframe_query` (mandatory — a token with no query tool is dead output),
  `chembl_dataframe_describe` (required alongside it so the agent learns table/column names before
  writing SQL), and `chembl_dataframe_drop` (the **opt-in** third — drops a named staged table by name).
  Drop is **off by default** (`CHEMBL_DATAFRAME_DROP_ENABLED=false`) and **conditionally registered** —
  absent from `tools/list` when off — because the canvas already self-cleans: no staged table is
  registered with a TTL of its own, so each lives exactly as long as its canvas, which expires on its
  sliding TTL (`CANVAS_TTL_MS`, 24 h) or its absolute cap (`CANVAS_ABSOLUTE_CAP_MS`, 7 days). An
  explicit drop only earns its place when an agent wants to reclaim a large table early inside a long
  session. `idea.md` already names `chembl_dataframe_query` (Design Notes). These
  three are the only additions beyond the 5-tool sketch, and the drop tool keeps the `canvas_id` +
  `table_name` model unchanged — it operates on the same primitive, adding no new architecture.
- **Standardize, carry raw alongside.** Surface ChEMBL's `standard_*` + `pchembl_value` as the primary
  fields; carry the original `type`/`value`/`units` too. Rank on `pchembl_value`.
- **Numerics coerced to `number | null` at the service boundary.** ChEMBL returns numbers as JSON
  strings (`"180.16"`, `"5.90"`, `max_phase: "4.0"`). Coercing once in the service means schemas/output
  are clean numbers; a missing/non-numeric value becomes `null` (never `0`) — a potency the agent must
  see as absent, not zero. Honors the scientific-data fidelity rule.
- **`max_phase` on every molecule row.** The cheap druggability signal — lets the agent tell an approved
  drug (phase 4) from a research compound (null; ChEMBL records no phase 0) without a follow-up call. `max_phase_min` is an
  optional search filter for the same reason.
- **No auth, no scopes.** Public keyless data over stdio; `MCP_AUTH_MODE=none`. Adding scopes would be
  ceremony with no security value.
- **Gene-symbol resolution flattens `target_component_synonyms`.** ChEMBL stores gene symbols nested in
  component synonyms (`syn_type` = `GENE_SYMBOL`/`GENE_SYMBOL_OTHER`); the service flattens them to a
  `gene_symbols[]` per component so `gene_symbol` search and output are first-class.
- **Resources optional, prompts none.** Tool-only clients can do everything; the molecule/target
  resources are pure convenience and the workflows are short chains, not template-worthy prompts.

## Error Contract

Most tools are simple reads — `sanitizeUpstreamError` maps an upstream failure by code (404 → `NotFound`
`not_found`, 429 → `RateLimited` `rate_limited`, timeout → `Timeout` `upstream_timeout`, rejected params →
`ValidationError` `invalid_query`, 5xx/network → `ServiceUnavailable` `upstream_unavailable`), and every
upstream tool and resource declares the two non-baseline reasons, `not_found` and `rate_limited`, with
`thrownBy: 'service'`. One 500 is the caller's input, not an outage: `/similarity` and `/substructure`
answer a query SMILES they cannot parse with HTTP 500 and a JSON `error_message` naming the query
molecule (`Problem standardizing the query molecule`, `SanitizeMol(NoneType)`). On those two routes
only, a 500 whose captured body carries either marker is excluded from `withRetry`'s transient set (one
upstream attempt) and maps to `ValidationError` `invalid_structure`; the overloaded front end's HTML
500 page carries neither, so it keeps the retries and `upstream_unavailable`. These tools also declare a
domain failure:

| Tool | `reason` | code | When | Recovery |
|---|---|---|---|---|
| `chembl_get_bioactivities` | `missing_filter` | `InvalidParams` | Neither `molecule_chembl_id` nor `target_chembl_id` supplied, so the query had nothing to scope to. | Supply `molecule_chembl_id` (from `chembl_search_molecules`), `target_chembl_id` (from `chembl_search_targets`), or both to narrow to one compound–target pair. |
| `chembl_get_bioactivities` | `not_a_chembl_id` | `InvalidParams` | `molecule_chembl_id` is not a ChEMBL ID and `include_alternate_forms` is off, so the exact filter could match no measurement. | Find the compound with `chembl_search_molecules` and pass the `molecule_chembl_id` it returns. |
| `chembl_get_bioactivities` | `alternate_forms_without_molecule` | `InvalidParams` | `include_alternate_forms` set without `molecule_chembl_id`, so there was no molecule whose family to read. | Supply `molecule_chembl_id` (from `chembl_search_molecules`) alongside `include_alternate_forms`, or drop the flag to query the target alone. |
| `chembl_get_bioactivities` | `contradictory_potency_filter` | `InvalidParams` | `pchembl_value_min` supplied alongside `potency_view: 'null_potency'`, whose rows have no `pchembl_value` to compare against. | Drop `pchembl_value_min` to browse the null-potency measurements, or leave `potency_view` at `potency_ranked` to apply the floor. |
| `chembl_get_bioactivities` | `canvas_capacity_exhausted` | `RateLimited` (retryable) | The view spilled with no `canvas_id` supplied, and the tenant already holds `CANVAS_MAX_CANVASES_PER_TENANT` canvases, so none could be minted. `data` carries `cap` and `activeCount`. | Pass a `canvas_id` from an earlier `chembl_get_bioactivities` response to stage on that canvas (replacing its table for the same `potency_view`), narrow the filters until the view fits inline (an inline fit needs no canvas), or retry once idle canvases expire. |
| `chembl_search_molecules` | `missing_input` | `InvalidParams` | Neither `query` nor `structure` supplied, or the `search_type` lacks the one it needs (`query` for `name`, `structure` for a structure mode). | Supply `query` for name/ID/InChIKey search, or `structure` (SMILES) with an appropriate `search_type` for structure search. |
| `chembl_search_molecules` | `invalid_structure` (service) | `ValidationError` | ChEMBL could not parse the SMILES of a `similarity` or `substructure` search (HTTP 500 naming the query molecule). Failed on the first attempt. | Check the SMILES for an atom over its valence (a carbon with five bonds), an unclosed ring-closure digit or parenthesis, or an aromatic ring that cannot be kekulized, then retry. |
| `chembl_search_targets` | `missing_input` | `InvalidParams` | None of `query`, `accession`, or `gene_symbol` supplied. | Supply at least one: `accession` (UniProt, e.g. `P00533`), `gene_symbol` (e.g. `EGFR`), or `query` (free-text name). |
| `chembl_dataframe_query` / `chembl_dataframe_describe` / `chembl_dataframe_drop` | `canvas_disabled` | `InvalidParams` | The server runs with the canvas off (`CANVAS_PROVIDER_TYPE=none`), so no canvas exists. (`chembl_dataframe_drop` reaches this only when registered, i.e. `CHEMBL_DATAFRAME_DROP_ENABLED=true` but canvas is still off.) | The SQL path is off on this server; read the inline rows from `chembl_get_bioactivities` and page with its `nextCursor` (for `chembl_dataframe_drop`: the canvas is off, so no table was ever staged and there is nothing to drop). |
| `chembl_dataframe_drop` | `canvas_not_found` | `NotFound` | The `canvas_id` is unknown or its canvas expired, taking its tables with it. | Nothing is left to drop; check the `canvas_id` was copied exactly if the canvas should still be live. |
| `chembl_dataframe_drop` | `identifier_reserved` | `ValidationError` | `table_name` is a reserved SQL keyword, which no staged table can carry. | Nothing by that name exists to drop; list the staged tables with `chembl_dataframe_describe`. |

A malformed `cursor` on `chembl_get_bioactivities`, `chembl_search_molecules`, or
`chembl_search_targets` fails as `InvalidParams` with `data.reason: 'invalid_cursor'`, raised by the
framework's `decodeCursor` before any upstream request — ChEMBL answers an offset it cannot read with
HTTP 200 and some other page, so a forwarded bad cursor would return rows labelled as a different page. The
framework's recovery hint (omit `cursor`, or pass the previous `nextCursor` unchanged) fits, so no tool
redeclares the reason.

Canvas failures — an unknown or expired `canvas_id`, a missing table, invalid SQL, a rejected table
name — are raised by the DataCanvas primitive with a structured `data.reason` (`canvas_not_found`,
`missing_table`, `invalid_sql`, `non_select_statement`, `identifier_shape`, …) and usually a recovery
hint set at the throw site. They bubble unchanged unless that hint is advice the calling tool cannot
follow. A throw-site hint outranks a declared contract entry, so declaring the reason alone changes
nothing: a tool that needs its own recovery declares the reason in `errors[]` and re-raises the failure
through `ctx.fail(reason, …, { cause })`, keeping the framework's code and reason and carrying the
original on `cause`. `chembl_dataframe_drop` re-raises `canvas_not_found` (the framework's re-stage hint
would have the caller stage data only to remove it) and `identifier_reserved` (its naming advice is for
creating a table, not finding one). `chembl_get_bioactivities` re-raises `canvas_capacity_exhausted` at
its canvas mint: the framework's hint offers "this server's canvas-drop tool", but `chembl_dataframe_drop`
drops a table and frees no canvas, so the tool's own recovery names the levers it has instead.
`chembl_dataframe_describe` and `chembl_dataframe_query` keep the framework's hints, which fit them.

## Output Design Notes

- **Spill envelope.** `chembl_get_bioactivities` returns `{ activities: <preview>, totalCount,
  potency_view, spilled, canvas_id, table_name, staged_row_count, truncated, truncated_by,
  canvasDisabled, nextCursor? }`.
  `totalCount` is the honest full match count spanning both potency views, sourced from a separate
  `limit:1` count request that does NOT apply the `pchembl_value__isnull` filter the stream uses. The
  preview/canvas holds only the selected `potency_view`, echoed back on the output so the agent knows
  which half it has and can re-call for the other. `canvasDisabled` is `true` when
  the server runs with `CANVAS_PROVIDER_TYPE=none` (so no spill is possible and the inline rows are one
  page of the view, not the full set; `nextCursor` continues it). Surface the spill + the `standard_type`/filters-as-parsed via
  `ctx.enrich(...)` so both client surfaces (Claude Code `structuredContent`, Claude Desktop
  `content[]`) see them.
- **`limit` bounds the inline rows on all three branches.** Spilled, fit inline, or canvas disabled,
  `activities` never exceeds `limit` — that is the field's advertised contract ("Maximum rows in the
  inline preview"). `spillover()` sizes its buffer by `previewChars`, a character budget whose 50,000
  floor holds ~55–70 average rows no matter how small `limit` is, so bounding the rows by shrinking that budget is
  not an option: the budget is what decides fit-vs-spill and feeds the overflow sentinel. The handler
  therefore returns the walk's first `limit` rows on both canvas branches, kept as they pass to
  `spillover()` rather than read back from its buffer (which can hold fewer than `limit` wide rows),
  and the canvas-disabled drain breaks at `limit`. What differs is where the remainder lives — on a spill it is on the staged table (SQL it via
  `chembl_dataframe_query`); whenever nothing is staged — the canvas off, or the view fit inline on a
  canvas with no `canvas_id` — `nextCursor` reaches the rest a page at a time, and the notice names
  which rows of the view the page holds; with a `canvas_id` supplied, the whole fit view is re-staged
  on that canvas, so the rest are on its table and the notice says so.
- **A canvas is minted only when a view spills, and a supplied one reflects the latest successful call.**
  Without a `canvas_id`, an inline fit, a zero match, an upstream failure, or a cancellation leaves the
  tenant's canvas count unchanged — no acquire, no extra request on the fit path — and a spill whose
  registration fails releases the canvas it minted, rethrowing the original error. With a `canvas_id`,
  every non-cursor call re-stages the selected view's table: an inline fit returns `spilled: false`
  alongside the `canvas_id`, `table_name`, and `staged_row_count` it wrote, and a zero match leaves an
  empty table with the declared schema, so neither `chembl_dataframe_describe` nor a `UNION ALL` of the
  two views can serve an earlier query's rows as current. A spill onto a supplied canvas replaces the
  view's table only once it succeeds, so an upstream failure or a cancellation mid-spill leaves the
  earlier table as it was. The other view's table is never touched.
- **A cursor page is inline-only.** The canvas-off branch and every cursor page share one path: a
  count request plus pages of `min(limit, CHEMBL_MAX_PAGE_SIZE)` rows from the decoded offset, on the
  view's total order. With the canvas on, a supplied `cursor` takes that same path — no canvas is
  acquired, a supplied `canvas_id` is left as it was, and the notice says the page was not staged. A
  canvas-on first page that stages — a spill, or a re-stage on a supplied `canvas_id` — mints no
  cursor; one that fits inline with no `canvas_id` stages nothing, so it mints `nextCursor` at the
  offset its page ends at whenever rows remain, including a fit the time budget or the row cap cut
  short, and the next page takes the cursor path. `nextCursor` comes from the view's own
  `page_meta.total_count`; it is omitted on the last page and on an empty one, and a cursor past the end
  returns zero rows with a notice that the walk is complete.
- **A capped spill says so.** The spill is bounded by `caps: { maxRows: CHEMBL_MAX_SPILL_ROWS }` and by
  `CHEMBL_SPILL_DEADLINE_MS`; the walk requests no page at or past the cap. `staged_row_count` reports
  the rows actually registered, `truncated` is true exactly when a bound stopped the walk short of the
  view's `page_meta.total_count`, and `truncated_by` names it — `time_budget` when the budget ended the
  walk, `row_cap` when the registered rows reached the cap — so the table is read as a bounded slice,
  not the complete view, and aggregates over it as a sample. A walk that ends on a short page below the
  cap, before that total, names neither and reports `truncated: false`. All three are rendered by `format()` as well as carried in `structuredContent`; a cap
  without that disclosure is the same "capped rows read as complete" trap the canvas-disabled preview
  already avoids. An inline fit the deadline cut short with no `canvas_id` stages nothing, so it reports no truncation, but
  its notice names the time budget, and `nextCursor` continues the view from the end of its page.
- **The rendered table has its own budget, disclosed separately.** `chembl_dataframe_query` returns
  every materialized row on `structuredContent.rows`, but `format()` can only put so much of that into
  `content[]` before it becomes a context-destroying wall of text. The bound is a **character budget**
  (`RENDER_CHAR_BUDGET`, 40,000 ≈ 10k tokens — the `api-canvas` preview tier the bioactivity spill is
  already sized against), measured on the markdown lines `format()` actually emits, so a small result
  renders in full and only a genuinely large one is capped. A row cap would be a leaky proxy: two ID
  columns and a column of assay prose differ by an order of magnitude at the same row count.
  `rendered_rows` reports how many rows the table holds and is a **distinct field from `truncated`** —
  that one means the canvas engine hit `CANVAS_DEFAULT_ROW_LIMIT` on the SQL result itself. The two are
  independent in both directions: a response can be `truncated: false` and still render fewer rows than
  `row_count`, or `truncated: true` with every returned row rendered. When the budget caps the table,
  `format()` says so above it (never below — a note under a 40,000-character table is the first thing a
  reader loses) and names the retrieval action: re-run the same SQL with `LIMIT`/`OFFSET`, which already
  reaches rows past the canvas row cap too, so no tool-level pagination parameter is needed.
- **Capped lists disclose truncation.** Every search tool takes a `limit` and returns an array → use
  `ctx.enrich.truncated({ shown, cap })` + `ctx.enrich.total(totalCount)` (from ChEMBL `page_meta.total_count`)
  so the agent never treats a capped page as complete.
- **`format()` parity.** Each tool's `format()` renders every output field as markdown (bold ChEMBL IDs,
  potency tables) — not just a count — so `content[]`-only clients see the same data as
  `structuredContent` clients.
- **Upstream text renders inert in `content[]`.** ChEMBL's strings are Markdown-active: as of October
  2026, 828 assay descriptions contain `](` (`[125I](R)-DOI` renders as a link), and 761,386 SMILES do
  (`C[C@H](N)…`).
  So every upstream string a `format()` prints passes through the escape in
  `src/mcp-server/markdown-text.ts`, and a CommonMark parse of the line reads back the field exactly:
  - **Structures** (`canonical_smiles`, `standard_inchi_key` on `chembl_search_molecules`) render as
    code spans from the framework's `markdown().inlineCode()`, which sizes the fence to the value; a
    null one renders `—`.
  - **Everything else** — names, descriptions, comments, types, organisms, units, IDs, and
    `chembl_dataframe_query` cells — takes `mdInline`, a backslash before only the characters that
    would become markup where they would (`*` and backticks anywhere; `_` except between two letters
    or digits, so `MONDO_0005148` stays as written; a tag- or autolink-shaped `<`; an `&` heading a
    character reference; `]` before `(` or `:`; a backslash before what it would escape). A line
    break is written as `&#10;` (`&#13;` for a CR), which a reader decodes back inside the line, so
    no value can start a new block. A value that begins a line — the assay description, a row's
    `standard_type`, a mechanism or MeSH heading after its list marker — takes `mdLineStart`, which
    also escapes a leading `#`, `>`, `-`, `+`, `1.`, `===`, or `~~~` that would open a block there.
  - Server-built values (counts, phases, years, `canvas_id`, `table_name`, cursors, enum states) and
    the enrichment notices are not escaped; the upstream strings a notice quotes are ChEMBL IDs and
    the `standard_type` spelling ChEMBL records, a case variant of the caller's own input.
  - `structuredContent` is untouched: the escape runs in `format()` only. The one field it moves is
    `chembl_dataframe_query`'s `rendered_rows`, since the render budget measures the lines `format()`
    emits, escapes included.
- **Never fabricate.** `format()` and normalization preserve `null` potency/units; a missing
  `standard_value` renders as "—"/"not reported", never `0`.
- **Attribution.** Carry the ChEMBL CC BY-SA attribution in `instructions` (and optionally an
  `enrichment` line) — the practical share-alike obligation.

## Known Limitations

- **Name and substructure searches stop at a ceiling.** `/molecule/search` stops at its 10,000-hit
  Elasticsearch result window and `/substructure` at 30,000 hits; each reports the ceiling as
  `page_meta.total_count` and serves no row at or past it (pyridine `c1ccncc1`: offset 29,999 returns
  one row, 30,000 none). `chembl_search_molecules` passes that total through unchanged, flags it
  `totalCountCapped: true`, and says on every page of the search — the past-the-end cursor included —
  that at least that many compounds match and the rest cannot be paged to; narrowing the query (a
  larger substructure, a more specific name, `max_phase_min`) is the way through. A true count of
  exactly the ceiling reads the same, so the wording is "at least". `/similarity`, the exact lookups,
  and `chembl_search_targets`' filtered `/target` list report exact counts (`/target` pages past 15,000).
- **No bulk/batch GET.** The ChEMBL data API has no `filter.ids`-style multi-ID endpoint, so per-record
  fetches (`getMolecule`, `getAssay`) are one call each. Acceptable — these are single-target by nature.
- **Activity sets are huge.** A popular target carries 10⁴–10⁵ measurements; with the canvas off
  (`CANVAS_PROVIDER_TYPE=none`, as in the `.mcpb` bundle) the flagship returns them a page at a time (at
  most 1,000 rows a call, through `cursor` / `nextCursor`) and cross-set aggregation is unavailable.
- **The spill is bounded, so the largest sets are sampled.** `CHEMBL_MAX_SPILL_ROWS` (default 50,000)
  caps the staged table and the upstream page walk behind it. Real single-protein targets fit under it
  (EGFR `CHEMBL203` has 21,342 measurements carrying a `pchembl_value`), but ChEMBL's catch-all targets
  do not — `CHEMBL612545` ("Unchecked") alone has 405,219, which uncapped would be 406
  upstream page fetches in one tool call. Over the cap the response reports `truncated: true`; narrowing
  with `standard_type` / `pchembl_value_min` is what brings a view back under it.
- **A large spill can outrun its time budget.** ChEMBL takes 3–9 s of server time per 1,000-row page,
  so even four pages at a time do not fit the 50,000-row cap inside the 45 s `CHEMBL_SPILL_DEADLINE_MS`
  default. Measured on EGFR `CHEMBL203`'s IC50 view (19,378 ranked rows): four pages at a time staged
  17,000 rows in the 45 s budget, one at a time 7,000. A view the budget cuts short stages its fetched
  prefix with `truncated_by: 'time_budget'`; narrowing the filters, or raising the budget for a client
  that waits past 60 s, reaches the rest.
- **A page that fails every retry near the budget's end can fail the spill or truncate it.** When its
  retries run out inside the budget, the call fails as `upstream_unavailable` with nothing staged, as
  any page that fails after its retries does; when the budget stops them first, the fetched prefix
  stages with `truncated_by: 'time_budget'`. The retry ladder's three backoffs total 7.9–13.1 s with
  jitter, so for a page that starts failing that close to the budget's end the jitter decides which: a
  page-two HTTP 500 under a 10 s `CHEMBL_SPILL_DEADLINE_MS` failed the call in 12 of 42 runs. Under the
  45 s default the same holds for a page that starts failing about 35 s into the walk.
- **`pchembl_value` sparsity.** Not every activity row has a derivable `pchembl_value` (non-standard
  types, censored relations). The default `potency_ranked` view excludes them via
  `pchembl_value__isnull=false` on the stream, while the honest `totalCount` (a separate `limit:1` count
  request without the isnull filter) counts them. They are retrieved by re-calling with
  `potency_view: 'null_potency'`, which stages them as their own `bioactivities_null_potency` table —
  a separate call, not a merged stream, because ChEMBL sorts null-`pchembl_value` rows FIRST under the
  descending `order_by=-pchembl_value` and merging would put them back at the head of the ranked view.
  On these rows potency lives only in the raw `value`/`type`/`relation` fields.
- **Mixed measurement types.** ChEMBL aggregates IC50, Ki, EC50, etc.; comparing across types is a
  scientific error the server can warn about (prominent `standard_type` filter) but not prevent.
- **In-memory canvas.** Spilled tables live in a process-local, tenant-scoped canvas and are dropped on restart (DataCanvas v1) — re-fetch
  is cheap for public data, but a `canvas_id` doesn't survive a server restart.
- **No 3D / conformer data, no document/literature endpoints** in v1.
- **Live-API latency / rate limits.** Unspecified upstream limits; `withRetry`, modest defaults, and the
  shared spill-page pacer mitigate, but a burst of large spills queues behind one in-flight ceiling, so
  each takes longer and the time budget cuts it shorter.
- **One stalled spill can hold every shared page slot.** A spill whose pages hang keeps up to all
  `CHEMBL_MAX_CONCURRENT_PAGES` slots of the server-wide pacer until each hung attempt's
  `CHEMBL_REQUEST_TIMEOUT_MS` timeout or that call's `CHEMBL_SPILL_DEADLINE_MS` deadline, whichever
  comes first. A concurrent call's spill waits behind it and may be cut short by its own budget
  (`truncated_by: 'time_budget'`) — the accepted cost of one in-flight ceiling across calls.

## v1 Scope vs. Deferred

**Ships in v1**

- 8 tools: `chembl_search_molecules`, `chembl_get_bioactivities`, `chembl_search_targets`,
  `chembl_get_drug_info`, `chembl_get_assay`, `chembl_dataframe_query`, `chembl_dataframe_describe`,
  and `chembl_dataframe_drop` (opt-in, `CHEMBL_DATAFRAME_DROP_ENABLED`-gated, conditionally registered —
  the standardized 3-tool DataCanvas surface; drop is off by default since TTL handles cleanup).
- `ChemblService` (single upstream client) + canvas-accessor; DataCanvas spill on the flagship.
- `chembl://molecule/{chemblId}` + `chembl://target/{chemblId}` resources.
- String→number/null numeric coercion; structure search (exact/similarity/substructure) under one tool;
  bidirectional bioactivity; `max_phase` on every molecule row.
- Cross-server chain guidance + CC BY-SA attribution via `createApp({ instructions })`.

**Deferred**

- Prompts (no template-worthy workflow yet).
- A local bulk **MirrorService** index (the corpus is large; revisit if live-API latency bites).
- 3D/conformer structures, document/literature endpoints, ATC classification, cell-line/tissue resources.
- Write operations (compound registration/standardization) — out of scope by design; ChEMBL is read-only here.

---

## Decision record (for later sessions)

| Decision | Why |
|---|---|
| 8 tools, not 5 | DataCanvas spill on the flagship pulls in the standardized 3-tool canvas surface: `dataframe_query` (contractually required), `dataframe_describe` (required alongside it), and the opt-in `dataframe_drop` (off by default, env-gated, conditionally registered — TTL already handles cleanup). `chembl_dataframe_query` was already named in `idea.md`. |
| Structure search = `search_type` enum on `chembl_search_molecules` | Three ChEMBL endpoints, one agent action ("find molecules") — consolidate, don't fan out. |
| `search_type` defaults to `name` | The most common case is name/ID/InChIKey lookup; callers opt in to structure modes explicitly. |
| `similarity_threshold` typed as integer 40–100 | ChEMBL's `/similarity` endpoint rejects thresholds below 40; exposing the validated range in the schema prevents silent 400 errors from the upstream. |
| ID and code inputs normalized in the schema, with patterns that spell out every variant | ChEMBL's list filters match exactly, so a lowercase ID or code returned an empty success; a pattern stating only the canonical form would have a JSON-Schema-validating client refuse the variants the server maps, since `pattern` takes no flags. |
| `standard_type` stays exact; a zero-row result gets one best-effort case-variant lookup | ChEMBL holds distinct types that differ only by case, so `__iexact` would change answers that are correct as sent. The lookup is one `limit: 1` request with no retry on a 5 s budget of its own, capped by the call's deadline, and its failure leaves the plain notice. The zero-row answer is already in hand when the lookup starts, so the short budget only bounds how long a hung lookup can hold it back; on the call's full deadline, the 30 s per-attempt timeout would. |
| Over-cap `limit` clamps with a notice instead of rejecting | A read with one obvious reading; a rejection only costs the caller a round trip. The 10,000 schema ceiling still bounds absurd input. |
| Drug info and family-read molecule inputs carry no ID pattern | `/molecule/{ref}` resolves an InChIKey and a SMILES as well as a ChEMBL ID, so a pattern would refuse calls that answer correctly today. |
| Cross-field input gates enforced in handler, not Zod | Zod can't cleanly express a requirement spanning two `.optional()` fields. Runtime check with `ctx.fail('missing_filter'/'missing_input', …)` keeps the schema simple for form clients and produces a typed, recoverable error for agents. |
| Raw upstream fields named `type`/`value`/`units`/`relation` in `Activity` | Carried alongside `standard_*` for auditability and staged to the canvas with the rest of the row (the full `Activity` spills); analytical queries should still rank on the normalized `standard_*` / `pchembl_value` columns, not the raw ones. |
| `bioactivities` canvas table column list is explicit | Agents writing SQL against the canvas need the exact column names; prose-only was a gap that would cause repeated `invalid_sql` errors. |
| `CHEMBL_DEFAULT_LIMIT` config field | The same default (25) applies to all search tools; centralizing it in config avoids scattered magic numbers and lets operators tune for slower connections. |
| Bidirectional `chembl_get_bioactivities` with an at-least-one input gate | The compound↔target bridge is symmetric; one tool with a molecule/target gate beats two near-duplicates, and accepting both together reaches the compound×target pair that neither single-sided tool could express. |
| Numerics coerced once in the service | ChEMBL ships numbers as strings; coercing at the boundary keeps schemas clean and absent→`null` honors scientific-data fidelity (never `0`). |
| DataCanvas defaults to `duckdb` in `src/index.ts`; the `.mcpb` fixes it to `none` | Cross-set aggregation on the flagship needs the canvas, and `@duckdb/node-api` is a direct dependency, so npm, `bunx`, and Docker installs already carry the native binding; the framework's own default stays `none`. The default is set after `.env` loads so a `.env` value of `none` still wins, followed by `resetConfig()` because the framework logger parses config at import. The bundle strips the native binding, so it pins `none` and pages inline rather than failing on its first spill. |
| Canvas only for bioactivities | Only that result is both analytical and oversized; search/drug/assay inline. |
| `potency_view` selects one view per call, never a merged stream | ChEMBL sorts null-`pchembl_value` rows FIRST under `order_by=-pchembl_value`, so any stream carrying both leads with the unrankable rows — the exact defect the potency filter was added to fix. Two calls staging two tables keeps the ranked view honest while making the excluded rows reachable, and a `UNION ALL` across the pair reconstructs the full set in SQL where arrival order does not matter. |
| Each view pages on a total order, walked by offset: `order_by=-pchembl_value&order_by=activity_id` for the ranked view, `order_by=activity_id` for the null-potency view | ChEMBL's order inside a `-pchembl_value` tie is not stable from one request to the next, so a tie group that straddles a page edge repeats some rows and drops others: CHEMBL203's default view (21,342 rows) repeated 138 measurements and dropped 138 before the tie-break, and `pchembl_value_min: 8` staged 5,816 rows holding 5,800 distinct `activity_id`s. The unique `activity_id` makes the order total. ChEMBL reads the two keys only as a repeated param (the comma form is HTTP 400), and `page_meta.next` writes them back as a Python list (`order_by=['-pchembl_value', 'activity_id']`, also HTTP 400), so the walk builds each page's URL from its offset and stops at a short page or the view's `page_meta.total_count`. Every null-potency row has a null `pchembl_value`, so only the primary key orders that view. |
| Drug info always reads the family; bioactivities reads it only under `include_alternate_forms` (default `false`) | A drug's pharmacology is one fact across its forms, and ChEMBL often files it on a salt, so a per-form drug-info read reported approved drugs as mechanism-less. Measurements are the opposite: widening every molecule-scoped call by default would change what existing calls return (imatinib `CHEMBL941` 4,878 → 5,802, its mesylate 902 → 5,802), so the family read is opt-in. A pass-through `parent_molecule_chembl_id` input was rejected: a salt's ID there matches nothing, an empty success. |
| Both family reads take the parent from the molecule record, never the caller's string or `active_chembl_id` | Keying off the record's canonical ID and resolved parent makes any identifier `/molecule/{id}` resolves work unchanged. A failed lookup fails the call (404 as `not_found`) rather than falling back to the one form, which would answer a different question. `active_chembl_id` names the active metabolite of a prodrug — a different molecule. |
| A potency floor on the null-potency view is an error, not an empty result | `pchembl_value__gte` and `pchembl_value__isnull=true` can only ever match zero rows. Returning empty would read as "ChEMBL has no such measurements"; silently dropping one filter would mask the caller's mistake. `contradictory_potency_filter` names the conflict and both ways out. |
| The spill cap is config (`CHEMBL_MAX_SPILL_ROWS`), not a hardcoded constant | The right ceiling is deployment-shaped: a shared hosted instance wants a tighter bound on per-request upstream fanout than a local stdio session doing bulk analysis. It sits alongside `maxPageSize`/`defaultLimit`, the other upstream-tuning knobs, and has a default that needs no attention. |
| The spill fetches its pages through an ordered window under one service-wide pacer | One page at a time at 3–9 s each outran the 60 s client timeout past about ten pages. Per-call concurrency without a shared limiter would multiply upstream load with concurrent calls, so the pacer bounds pages in flight across the server, and the window yields in offset order, so the staged table and preview match a sequential walk. |
| The spill's time budget stages the fetched prefix rather than failing | Failing at the deadline discards pages already fetched; a disclosed partial (`truncated_by: 'time_budget'`) follows the row cap's choice of honest truncation over failure or silent incompleteness. A page whose retries `withRetry` stops before an exponential backoff the budget cannot hold counts the same: the budget ended it, though the deadline has not yet expired, and failing it lost the whole prefix (a page-two 500 under a 10 s budget failed at 4.8 s with 0 rows). A page whose retries run out inside the budget still fails the call, so near the budget's end the retry jitter decides which of the two a failing page gets (*Known Limitations*). |
| The spill walk starts no page the budget would not hold, timing a page by the latest one to land, on its final attempt with its queueing | A page started with less budget left than pages take is abandoned at the deadline after ChEMBL has computed it (4 s stub pages under a 10 s budget: 9 page requests, 4 abandoned; with the stop 5 and none, the same 5,000 rows, 8.2 s instead of 10.0 s). A running maximum let a slow first page stop a 40,000-row walk at 13,000 rows, and counting a retried page's failed attempt and backoff cut a walk from 21,000 rows to 17,000; the cost kept is a first page slower than the budget it leaves, which ends the walk after it however fast later pages would be. |
| `truncated_by` names a bound only when that bound cut the walk | A walk that ends on a short page below the cap, before the `page_meta.total_count` ChEMBL reported, hit neither bound; labelling it `row_cap` sent the caller to narrow filters under a cap it never reached (90 rows staged under a 100-row cap read "Capped … CHEMBL_MAX_SPILL_ROWS=100"). The cap is read off the registered rows reaching it, not `spillover()`'s own `truncated` flag: the walk requests no page at or past the cap, so a cap hit exactly on a full last page ends the source there and `spillover()` reports nothing cut. |
| Every other call gets a constant 45 s budget (`CALL_DEADLINE_MS`), passed explicitly from method to method | The client's 60 s timeout is fixed whatever `CHEMBL_REQUEST_TIMEOUT_MS` is set to, so deriving the budget from it would track the wrong number; per-attempt timeouts × retries, and chained requests each with their own, ran past 60 s. A method takes an optional deadline so a caller chaining methods (a count before a page) keeps them on one budget, with no per-context state to hold it. |
| No auth / no scopes | Public keyless data over stdio — scopes would be empty ceremony. |
| `chembl_dataframe_query` renders `content[]` against a character budget, not a row cap | A fixed row cut is wrong in both directions: it truncated a 60-row result nobody needed truncated, and it left a wide result over budget anyway. Characters are the quantity that actually bounds context; rows are a proxy that varies by an order of magnitude with column width. |
| `rendered_rows` is a separate field from `truncated`, not an overload of it | They report different bounds — the renderer's budget vs. the canvas engine's `CANVAS_DEFAULT_ROW_LIMIT` on the SQL result — and either can fire without the other. Collapsing them would make a `truncated: false` response that under-renders `content[]` undetectable from `structuredContent` alone. |
| `chembl_dataframe_query` takes no pagination parameter — SQL `LIMIT`/`OFFSET` is its retrieval path past both bounds | Offsets already reach rows beyond the canvas row cap (verified: `LIMIT 2000 OFFSET 10000` against a 19,378-row staged table returns exactly those 2,000). A second, tool-level knob would duplicate a mechanism the caller's own SQL already has. |
| `chembl_get_bioactivities` pages its inline rows with an offset cursor, and a cursor page never stages | With the canvas off, `limit` (max 1,000) was the only bound and nothing reached the rows past it: `totalCount` disclosed the gap but retrieval stopped there. The cursor's resume offset is the only field read back (`encodeCursor`/`decodeCursor`, the search tools' pattern; the minting `limit` rides along unread), redeemed with the filters and `potency_view` that minted it, and each page walks the view's tie-broken total order, so following `nextCursor` returns every `activity_id` once. A cursor page stays inline even with the canvas on: staging it would replace that view's table with one page of rows, while the first, cursor-less call already stages the whole view for SQL. A canvas-on first page that fits inline with no `canvas_id` stages nothing either, so it mints a cursor the same way: a larger `limit` cannot reach rows past a 1,000-row page. |
| `chembl_get_bioactivities` mints a canvas only on a spill, and re-stages a supplied `canvas_id` on every non-cursor call | Acquiring before fit-or-spill was known held a tenant canvas slot for the 24 h TTL on every inline fit, zero match, failure, and cancellation; under `MCP_AUTH_MODE=none` all callers share one tenant, so small queries exhausted `CANVAS_MAX_CANVASES_PER_TENANT`. Staging only on a spill left a supplied canvas holding the previous query's rows whenever the next one fit inline, which `chembl_dataframe_describe` and SQL then served as current. Re-staging an inline fit costs one in-memory `registerTable` (a 0.6–1.5 ms median for 0–68 rows on DuckDB) and no upstream request. |
| `chembl_get_bioactivities` decides fit-vs-spill on `max(50_000, limit * 800)` characters and takes its inline rows from the walk's first `limit`, not from `spillover()`'s buffer | One budget cannot both hold `limit` wide rows and keep the fit line near `limit`: at 1,500 characters a row, CHEMBL203 Ki's 1,511-row null-potency view and CHEMBL1862 Ki's 1,146-row ranked view fit inline at `limit` 1000 and returned one page and a cursor with nothing staged, so neither view could be queried in SQL, and a buffer of 3,500-character rows still held only 432 of 1,000. Keeping the walk's first `limit` rows as they pass decouples the two: real rows average 690–870 characters, so 800 a row keeps the line at about `limit` rows, and every spill shows a full `limit`. |
| A spill onto a supplied `canvas_id` registers under a per-call staging table and replaces the view's table only once it succeeds | Registering under the view's own name drops its earlier table before the first row lands, and `spillover()` drops a partly appended table on failure, so an upstream error or a cancellation mid-spill took the earlier rows with it. `registerAs` refuses an existing name, so the swap is drop-then-copy: one copy of the staged rows, measured on DuckDB at medians of 3.7 ms for 70 rows, 4.5 ms for 1,000, 19 ms for 17,000, and 45 ms for 50,000, against upstream pages that take 3–9 s per 1,000 rows. The drop and the copy run without the call's signal, so a cancellation cannot leave the view with no table; an engine fault inside the copy is the one outcome that still can. Swaps onto one table take turns in-process: two that interleaved failed the second in 20 of 20 simultaneous DuckDB trials (`Table with name bioactivities does not exist!`). An inline fit's re-stage of that table takes the same turn: unqueued, a re-stage started across the moment of a swap failed a call in 32 of 62 DuckDB races, the spill in 22 (`register_as_clash`, or the table missing at the copy) and the re-stage itself in 13 (a catalog write-write conflict, or the table dropped mid-append); with the turn, none of 62 failed. |
| Non-primitive cells render as JSON, take the shared escape, and escape pipes | `String()` flattens a DuckDB STRUCT/LIST to `[object Object]`, which drops from `content[]` a value `structuredContent` carries in full — the same parity gap the row cap caused. Escaping keeps one cell from breaking the table row it sits in; a line break is written as `&#10;` rather than folded to a space, which lost it. |
| Upstream strings are escaped in `format()`, never in the value | `structuredContent` is the record as ChEMBL wrote it; a backslash written into the value would reach it. One leaf module serves every `format()`, so the rules cannot drift per tool. |
| The escape marks only what CommonMark would read as markup, where it would | A backslash before every punctuation character would mangle what callers copy out of `content[]` — IDs, units, `[3H]` labels — for no rendering gain. `_` between two letters or digits can neither open nor close emphasis, and a `[` opens nothing until a `](` closes it. |
| Line breaks become character references, not hard breaks | A hard break drops the whitespace around it and leaves the next line free to open a heading or list item; `&#10;` keeps the value on one line and parses back to the same character. |
| Structures render as code spans, not escaped text | A SMILES is an identifier callers copy into other tools; an escaped one would carry backslashes, while a fence-sized span's literal is the SMILES byte for byte. |
