# chembl-mcp-server — Design

> Formalizes [`docs/idea.md`](./idea.md) into a buildable spec. The MCP surface is the contract;
> everything below it grounds implementation in the [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)
> framework and the live ChEMBL REST API (probed against `www.ebi.ac.uk/chembl/api/data/` during design).

Display identity is the hyphenated repo name **`chembl-mcp-server`** on every surface (`createApp()`
`name`/`title`, manifest `display_name`, docs headers) — never a Title-Cased "ChEMBL MCP Server".

---

## MCP Surface

### Tools

| Tool | Summary | readOnlyHint | openWorldHint | Key inputs | Output shape |
|---|---|---|---|---|---|
| `chembl_search_molecules` | Discovery entry point. Find compounds by name / ChEMBL ID / InChIKey, or run a structure search (exact \| similarity \| substructure) from a SMILES/InChI. `search_type` defaults to `name`; `structure` is required when `search_type` is `exact`, `similarity`, or `substructure`. At least one of `query` or `structure` must be supplied. | `true` | `true` | `query?`, `structure?`, `search_type` (default `name`), `similarity_threshold?` (integer 40–100, default 70), `max_phase_min?`, `limit` | `{ molecules[], totalFound }` — ChEMBL ID, pref_name, canonical SMILES, formula, MW, AlogP, RO5 violations, QED, max_phase, (similarity score 0–100 when structure search) |
| `chembl_get_bioactivities` | **Flagship.** Bioactivity measurements for a molecule **or** a target (the compound↔target↔assay bridge). Exactly one of `molecule_chembl_id` or `target_chembl_id` is required — supplying both or neither is a `missing_filter` error. Filters by standard_type, potency, assay type, organism. Large sets spill to DataCanvas. | `true` | `true` | `molecule_chembl_id?` XOR `target_chembl_id?`, `standard_type?`, `pchembl_value_min?`, `assay_type?`, `organism?`, `limit`, `canvas_id?` | `{ activities[], totalFound, spilled, canvas_id?, table_name? }` per-measurement: molecule, target, assay, standard_type/value/units, pchembl_value, assay confidence |
| `chembl_search_targets` | Resolve a protein/gene/UniProt accession → ChEMBL target ID that `get_bioactivities` needs. At least one of `query`, `accession`, or `gene_symbol` must be supplied; omitting all returns a `ValidationError`. | `true` | `true` | `query?`, `accession?`, `gene_symbol?`, `organism?`, `target_type?`, `limit` | `{ targets[], totalFound }` — target_chembl_id, pref_name, target_type, organism, component accessions + gene symbols |
| `chembl_get_drug_info` | Pharmacology for a drug (molecule): mechanism(s) of action, molecular target(s), action type, first-approval year, indications + max phase. `molecule_chembl_id` comes from `chembl_search_molecules`. | `true` | `true` | `molecule_chembl_id` (from `chembl_search_molecules`) | `{ molecule_chembl_id, pref_name, max_phase, first_approval?, mechanisms[], indications[] }` |
| `chembl_get_assay` | Assay detail by assay ChEMBL ID — provenance behind a bioactivity row (type, target, organism, confidence). `assay_chembl_id` comes from a bioactivity row's `assay_chembl_id` field. | `true` | `true` | `assay_chembl_id` (from a bioactivity row) | `{ assay_chembl_id, description, assay_type, target_chembl_id?, organism?, confidence_score?, confidence_description? }` — confidence_score is ChEMBL's 1–9 scale (9 = direct assay on protein target) |
| `chembl_dataframe_query` | Run read-only SQL `SELECT` over the bioactivity rows `chembl_get_bioactivities` spilled to a canvas (rank, group, dedupe, aggregate across the **full** set). Returns up to the canvas row limit; `truncated: true` when the result exceeds that cap. | `true` | `false` | `canvas_id`, `sql` | `{ rows[], row_count, truncated }` — `truncated` signals the SQL result was row-capped by the canvas, not the spill |
| `chembl_dataframe_describe` | List tables + columns staged on a canvas, so the agent can write correct SQL before calling `chembl_dataframe_query`. | `true` | `false` | `canvas_id` | `{ tables[] }` — name, kind (`table`\|`view`), row_count, columns (name + type) |
| `chembl_dataframe_drop` | Drop a named staged table from a canvas (`instance.drop`). **Opt-in** behind `CHEMBL_DATAFRAME_DROP_ENABLED=true` (default off) and **conditionally registered** — absent from `tools/list` when the flag is off. Off by default because per-table/canvas TTL already reclaims staged tables; the tool only matters when an agent wants to free a large table early within a long session. | `false` | `false` | `canvas_id`, `table_name` | `{ dropped }` — `true` if the table existed and was dropped, `false` if it was already gone |

**8 tools** (7 always registered; `chembl_dataframe_drop` registers only when its env flag is on). The 5
from `idea.md`'s sketch, plus the 3 standardized DataCanvas consumer tools the spill in
`chembl_get_bioactivities` makes the home for — `idea.md` names `chembl_dataframe_query` explicitly
(Design Notes), and the framework's DataCanvas contract requires a `dataframe_query` tool wherever a
tool emits a `canvas_id` (a token with no query tool is dead output), with `dataframe_describe`
strongly recommended so the agent can discover staged table/column names and `dataframe_drop` the
opt-in third (off by default; TTL handles cleanup). See **Design Decisions**.

### Resources

| URI template | Returns |
|---|---|
| `chembl://molecule/{chemblId}` | A molecule record by ChEMBL ID — the same shape a `chembl_search_molecules` row carries (ID, names, structures, properties, max_phase). Convenience injectable-context mirror of the per-molecule fetch. |
| `chembl://target/{chemblId}` | A target record by ChEMBL target ID — pref_name, type, organism, component accessions + gene symbols. |

Both are read-only, URI-addressable, and fully covered by the tool surface (a tool-only client never
needs them) — they exist only as injectable context for clients that support resources. `{chemblId}`
is validated against the `CHEMBL\d+` pattern. **Optional for v1** — ship if cheap, defer without loss.

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
carries tens of thousands of measurements (confirmed: EGFR `CHEMBL203` had 3,920 IC50 rows alone), so
it pairs an inline preview with a DataCanvas spill that the agent SQLs via `chembl_dataframe_query`.

## Requirements

**Functional**

- Find compounds by name, ChEMBL ID, InChIKey, or structure (exact / similarity / substructure).
- Return bioactivity measurements bidirectionally — by molecule **or** by target — filterable by
  standard type, potency (`pchembl_value`), assay type, and organism; ranked on `pchembl_value`.
- Resolve a protein (UniProt accession / gene symbol / name) to the ChEMBL target ID downstream tools need.
- Return drug pharmacology: mechanism(s) of action, target(s), action type, first-approval, indications.
- Return assay provenance (type, target, organism, confidence) for a given assay ChEMBL ID.
- Spill large bioactivity result sets to a DataCanvas table and expose read-only SQL over the full set.

**Non-functional / constraints**

- **No auth.** ChEMBL is keyless; server runs `MCP_AUTH_MODE=none` for stdio, no scopes on tools.
- **Rate limits.** ChEMBL is generous but unspecified; be a good citizen — a `User-Agent`, modest
  default `limit` (25), the framework's `withRetry` with ~1–2 s backoff on 429/5xx. No batching
  endpoint exists (`filter.ids`-style bulk GET is not part of the ChEMBL data API), so single-record
  fetches stay single calls.
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
| `canvas_id` | opaque 10-char | a spilled DataCanvas | returned by `chembl_get_bioactivities` when `spilled: true` |

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
  max_phase: number | null;          // 4 = marketed, 0/null = research — the cheap "druggability" signal
  molecule_type: string | null;      // "Small molecule"
  similarity?: number | null;        // present only on similarity/substructure search (percent)
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

/** Drug pharmacology — mechanisms + indications joined for one molecule. */
interface DrugInfo {
  molecule_chembl_id: string;
  pref_name: string | null;
  max_phase: number | null;
  first_approval: number | null;     // year, from the molecule record
  mechanisms: Array<{
    target_chembl_id: string | null;
    mechanism_of_action: string | null; // "Epidermal growth factor receptor erbB1 inhibitor"
    action_type: string | null;         // "INHIBITOR" | "AGONIST" | …
  }>;
  indications: Array<{
    mesh_heading: string | null;        // "Carcinoma, Non-Small-Cell Lung"
    efo_term: string | null;            // "non-small cell lung carcinoma"
    max_phase_for_ind: number | null;   // phase reached for THIS indication
  }>;
}
```

**Canvas table — `bioactivities`.** When `chembl_get_bioactivities` spills, the staged table holds the
flat `Activity` rows (coerced numerics) so SQL aggregates are honest. Columns available for SQL:
`activity_id`, `molecule_chembl_id`, `molecule_pref_name`, `target_chembl_id`, `target_pref_name`,
`target_organism`, `assay_chembl_id`, `assay_type`, `standard_type`, `standard_relation`,
`standard_value` (DOUBLE), `standard_units`, `pchembl_value` (DOUBLE).
Aggregate signal (median potency, distinct-compound count) MUST be computed in SQL over the full
table, never over the inline preview. The raw `type`/`value`/`units`/`relation` fields are NOT staged
(analytical queries should use the `standard_*` columns).

## Services

| Service | Responsibility | Key methods |
|---|---|---|
| `ChemblService` (`src/services/chembl/chembl-service.ts`) | The single upstream client. Wraps `https://www.ebi.ac.uk/chembl/api/data/`; builds Django-style filtered URLs, fetches `.json`, paginates `page_meta`, **coerces string numerics → number/null at the boundary**, flattens nested structures (`molecule_structures`, `molecule_properties`, `target_components`) into the flat domain types above. Each method wraps its full fetch+parse in `withRetry`. | `searchMolecules(opts)`, `structureSearch(smiles, type, threshold)`, `getActivities(opts)` (returns an async-iterable page stream for spillover), `searchTargets(opts)`, `getMolecule(id)`, `getMechanisms(molId)`, `getIndications(molId)`, `getAssay(id)` |
| `canvas-accessor` (`src/services/canvas-accessor.ts`) | Module-level holder for the optional `DataCanvas` wired in `createApp({ setup })`. `getCanvas()` returns `undefined` when canvas is disabled. | `setCanvas(core.canvas)`, `getCanvas()` |

`chembl_get_bioactivities` uses `spillover({ canvas, source: chembl.getActivities(...), previewChars: 100_000, signal })`
— preview rows inline, full set staged as the `bioactivities` table. The optional `canvas_id` input
lets callers reuse an existing canvas (e.g. to append a second query's results to the same session);
omit it to mint a fresh canvas. `chembl_get_drug_info` composes `getMolecule` + `getMechanisms` +
`getIndications` with `Promise.allSettled` so a missing mechanism or indication degrades to an empty
array rather than tanking the call. `chembl_search_targets` validates at least one of `query`,
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
| `CHEMBL_REQUEST_TIMEOUT_MS` | `requestTimeoutMs` | no | `30000` | Per-request timeout for upstream fetches. |
| `CHEMBL_MAX_PAGE_SIZE` | `maxPageSize` | no | `1000` | ChEMBL's per-page cap when streaming activity pages for spill. |
| `CHEMBL_DEFAULT_LIMIT` | `defaultLimit` | no | `25` | Default `limit` applied when callers omit it; keeps preview sizes sane. |
| `CANVAS_PROVIDER_TYPE` | (framework) | no | `none` | Set to `duckdb` to enable the bioactivity spill + SQL path. When `none`, `chembl_get_bioactivities` still inlines a preview but never spills; `chembl_dataframe_*` return a "canvas disabled" error. |
| `CHEMBL_DATAFRAME_DROP_ENABLED` | `dataframeDropEnabled` | no | `false` | Opt-in toggle for the `chembl_dataframe_drop` tool. Off by default — per-table/canvas TTL already reclaims staged tables, so the explicit drop is unnecessary in the common case. Set `true` only when agents need to free a large staged table early within a long session; the tool is conditionally registered, so it is absent from `tools/list` when this is off. `z.stringbool()` so `=false` actually disables. |

No API key — ChEMBL is keyless, so there is no degraded-without-key mode to document. The capability
gate is `CANVAS_PROVIDER_TYPE`: without `duckdb`, the analytical SQL path is off and the flagship tool
degrades to preview-only (documented in its description and surfaced via `enrichment`).
`CHEMBL_DATAFRAME_DROP_ENABLED` is the only other toggle — a feature flag for the opt-in drop tool, not
a degraded mode.

`createApp({ instructions })` carries the cross-server chain guidance and the CC BY-SA attribution line
(session-level context, set once rather than repeated across every tool description).

## Implementation Order

Each step is independently buildable + testable.

1. **Config + identity** — `server-config.ts` (Zod schema, env mapping); set `createApp()`
   `name`/`title` to `chembl-mcp-server`, add `instructions` (cross-server chain + attribution), wire
   the `setup(core)` → `setCanvas(core.canvas)` callback. Delete the echo tool/resource/prompt scaffold.
2. **`ChemblService`** — URL builder, `.json` fetch + `page_meta` pagination, the string→number/null
   coercion layer, nested-structure flattening into the flat domain types. Add the canvas-accessor
   module. Unit-test coercion (string "180.16" → 180.16; absent → null) and a sparse-payload case.
3. **`chembl_search_targets`** — needed first; it produces the target IDs the flagship consumes.
   Accession / gene-symbol / name / organism filters; flatten components + gene symbols.
4. **`chembl_search_molecules`** — name/ID/InChIKey search + the three structure modes via
   `search_type`. Coerce + surface `max_phase` on every row.
5. **`chembl_get_bioactivities`** — the flagship. molecule-or-target XOR input gate; standard_type /
   pchembl / assay_type / organism filters; `spillover()` to the `bioactivities` table; inline preview;
   `enrichment` truncation/total + spill notice.
6. **`chembl_dataframe_query` + `chembl_dataframe_describe` + `chembl_dataframe_drop`** — the
   standardized 3-tool canvas surface (query + describe mandatory once step 5 emits a `canvas_id`; drop
   opt-in behind `CHEMBL_DATAFRAME_DROP_ENABLED`, conditionally registered so it is absent from
   `tools/list` when off).
7. **`chembl_get_drug_info`** — `Promise.allSettled` compose of molecule + mechanisms + indications.
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
| 2 | `chembl_get_bioactivities({ target_chembl_id: 'CHEMBL203', standard_type: 'IC50', pchembl_value_min: 7 })` | Bioactivity rows for that target. ~3,920 IC50 rows for EGFR → **spills**; returns `canvas_id` + `bioactivities` table + inline top-N preview. |
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
`openfda`'s label/adverse-event view.

**W4 — Cross-server identity (the payoff, documented in `instructions`).**

- UniProt accession (`uniprot`/`protein`) → `chembl_search_targets` → `chembl_get_bioactivities` — canonical.
- A molecule's `standard_inchi_key` → `pubchem` (`pubchem_search_compounds` by InChIKey) for richer chemistry / safety / interactions.
- An approved drug (`max_phase: 4`) → `openfda` for the FDA label and real-world adverse events.

## Design Decisions

- **Structure search consolidated under `chembl_search_molecules` via a `search_type` enum**
  (`name` \| `exact` \| `similarity` \| `substructure`) rather than three tools. ChEMBL exposes them as
  distinct endpoints (`/molecule` for name/ID/InChIKey, `/molecule/{smiles}` for exact, `/similarity/{smiles}/{threshold}` for similarity, `/substructure/{smiles}` for substructure); the handler routes by `search_type`. Default is `name`. `structure` (SMILES string) is required for `exact`/`similarity`/`substructure`; `query` is required for `name`. `similarity_threshold` is an integer 40–100 (ChEMBL rejects values below 40); default 70. Keeps the discovery surface one tool. Handler validates at least one of `query`/`structure` is present and that `structure` accompanies structure-mode `search_type` values — throws `missing_input` otherwise.
- **`chembl_get_bioactivities` is one bidirectional tool, not `get_compound_activities` +
  `get_target_activities`.** The molecule↔target bridge is symmetric and shares all filters; an
  XOR input gate (`molecule_chembl_id` *or* `target_chembl_id`, exactly one) keeps the surface tight.
  The gate is enforced at the handler level (not Zod — Zod can't XOR two optionals cleanly): both absent or both present → `ctx.fail('missing_filter', …)`. This is the tool the server exists for, so it gets the prominent `standard_type` filter and the spill.
- **DataCanvas spill — bioactivities only.** It clears both gates: the data is *analytical* (agents run
  `GROUP BY` / `MEDIAN` over potency across thousands of rows) and *too big to inline* (a single target
  = thousands of measurements). Search/target/drug/assay results are discovery or single-record — they
  inline, no canvas. This is why only `chembl_get_bioactivities` emits a `canvas_id`.
- **The three `dataframe_*` tools are the standardized canvas surface, not scope creep.** The framework's
  DataCanvas contract defines a three-tool standard wherever a tool emits a `canvas_id`:
  `chembl_dataframe_query` (mandatory — a token with no query tool is dead output),
  `chembl_dataframe_describe` (strongly recommended so the agent learns table/column names before
  writing SQL), and `chembl_dataframe_drop` (the **opt-in** third — drops a named staged table by name).
  Drop is **off by default** (`CHEMBL_DATAFRAME_DROP_ENABLED=false`) and **conditionally registered** —
  absent from `tools/list` when off — because the canvas already self-cleans via sliding per-table and
  per-canvas TTL; an explicit drop only earns its place when an agent wants to reclaim a large table
  early inside a long session. `idea.md` already names `chembl_dataframe_query` (Design Notes). These
  three are the only additions beyond the 5-tool sketch, and the drop tool keeps the `canvas_id` +
  `table_name` model unchanged — it operates on the same primitive, adding no new architecture.
- **Standardize, carry raw alongside.** Surface ChEMBL's `standard_*` + `pchembl_value` as the primary
  fields; carry the original `type`/`value`/`units` too. Rank on `pchembl_value`.
- **Numerics coerced to `number | null` at the service boundary.** ChEMBL returns numbers as JSON
  strings (`"180.16"`, `"5.90"`, `max_phase: "4.0"`). Coercing once in the service means schemas/output
  are clean numbers; a missing/non-numeric value becomes `null` (never `0`) — a potency the agent must
  see as absent, not zero. Honors the scientific-data fidelity rule.
- **`max_phase` on every molecule row.** The cheap druggability signal — lets the agent tell a marketed
  drug (phase 4) from a research compound (phase 0/null) without a follow-up call. `max_phase_min` is an
  optional search filter for the same reason.
- **No auth, no scopes.** Public keyless data over stdio; `MCP_AUTH_MODE=none`. Adding scopes would be
  ceremony with no security value.
- **Gene-symbol resolution flattens `target_component_synonyms`.** ChEMBL stores gene symbols nested in
  component synonyms (`syn_type` = `GENE_SYMBOL`/`GENE_SYMBOL_OTHER`); the service flattens them to a
  `gene_symbols[]` per component so `gene_symbol` search and output are first-class.
- **Resources optional, prompts none.** Tool-only clients can do everything; the molecule/target
  resources are pure convenience and the workflows are short chains, not template-worthy prompts.

## Error Contract

Most tools are simple reads — the framework's auto-classification (404 → `NotFound`, 429/5xx →
`ServiceUnavailable`, bad params → `ValidationError`) covers them, so no typed contract is needed there.
Two tools have a domain failure worth declaring:

| Tool | `reason` | code | When | Recovery |
|---|---|---|---|---|
| `chembl_get_bioactivities` | `missing_filter` | `InvalidParams` | Neither `molecule_chembl_id` nor `target_chembl_id` supplied, or both are supplied. | Supply exactly one of `molecule_chembl_id` (from `chembl_search_molecules`) or `target_chembl_id` (from `chembl_search_targets`), not both and not neither. |
| `chembl_search_molecules` | `missing_input` | `InvalidParams` | Neither `query` nor `structure` supplied. | Supply `query` for name/ID/InChIKey search, or `structure` (SMILES) with an appropriate `search_type` for structure search. |
| `chembl_search_targets` | `missing_input` | `InvalidParams` | None of `query`, `accession`, or `gene_symbol` supplied. | Supply at least one: `accession` (UniProt, e.g. `P00533`), `gene_symbol` (e.g. `EGFR`), or `query` (free-text name). |
| `chembl_dataframe_query` / `chembl_dataframe_describe` / `chembl_dataframe_drop` | `canvas_disabled` | `InvalidParams` | Called while `CANVAS_PROVIDER_TYPE` is `none` (no canvas). (`chembl_dataframe_drop` reaches this only when registered, i.e. `CHEMBL_DATAFRAME_DROP_ENABLED=true` but canvas is still off.) | Set `CANVAS_PROVIDER_TYPE=duckdb` to enable the SQL path; otherwise read the inline preview from `chembl_get_bioactivities`. |

Canvas-resolution failures (`unknown canvas_id`, expired table, invalid SQL) are thrown by the
DataCanvas primitive itself with structured `data.reason` (`missing_table`, `invalid_sql`,
`non_select_statement`) — let them bubble; don't re-wrap.

## Output Design Notes

- **Spill envelope.** `chembl_get_bioactivities` returns `{ activities: <preview>, totalFound, spilled,
  canvas_id?, table_name? }`. When `spilled: false` the preview *is* the full set; when `true`,
  `activities` is the inline slice and the full set lives on the canvas. Surface the spill + the
  `standard_type`/filters-as-parsed via `ctx.enrich(...)` so both client surfaces (Claude Code
  `structuredContent`, Claude Desktop `content[]`) see them.
- **Capped lists disclose truncation.** Every search tool takes a `limit` and returns an array → use
  `ctx.enrich.truncated({ shown, cap })` + `ctx.enrich.total(totalFound)` (from ChEMBL `page_meta.total_count`)
  so the agent never treats a capped page as complete.
- **`format()` parity.** Each tool's `format()` renders every output field as markdown (bold ChEMBL IDs,
  potency tables) — not just a count — so `content[]`-only clients see the same data as
  `structuredContent` clients.
- **Never fabricate.** `format()` and normalization preserve `null` potency/units; a missing
  `standard_value` renders as "—"/"not reported", never `0`.
- **Attribution.** Carry the ChEMBL CC BY-SA attribution in `instructions` (and optionally an
  `enrichment` line) — the practical share-alike obligation.

## Known Limitations

- **No bulk/batch GET.** The ChEMBL data API has no `filter.ids`-style multi-ID endpoint, so per-record
  fetches (`getMolecule`, `getAssay`) are one call each. Acceptable — these are single-target by nature.
- **Activity sets are huge.** A popular target carries 10⁴–10⁵ measurements; without
  `CANVAS_PROVIDER_TYPE=duckdb` the flagship degrades to preview-only and cross-set aggregation is
  unavailable. Hosting must enable canvas for the flagship to fully deliver.
- **`pchembl_value` sparsity.** Not every activity row has a derivable `pchembl_value` (non-standard
  types, censored relations); those rank last / are excluded from potency aggregates and surface as `null`.
- **Mixed measurement types.** ChEMBL aggregates IC50, Ki, EC50, etc.; comparing across types is a
  scientific error the server can warn about (prominent `standard_type` filter) but not prevent.
- **In-memory canvas.** Spilled tables are per-session and dropped on restart (DataCanvas v1) — re-fetch
  is cheap for public data, but a `canvas_id` doesn't survive a server restart.
- **No 3D / conformer data, no document/literature endpoints** in v1.
- **Live-API latency / rate limits.** Unspecified upstream limits; `withRetry` + modest defaults
  mitigate but a burst of large spills can be slow.

## v1 Scope vs. Deferred

**Ships in v1**

- 8 tools: `chembl_search_molecules`, `chembl_get_bioactivities`, `chembl_search_targets`,
  `chembl_get_drug_info`, `chembl_get_assay`, `chembl_dataframe_query`, `chembl_dataframe_describe`,
  and `chembl_dataframe_drop` (opt-in, `CHEMBL_DATAFRAME_DROP_ENABLED`-gated, conditionally registered —
  the standardized 3-tool DataCanvas surface; drop is off by default since TTL handles cleanup).
- `ChemblService` (single upstream client) + canvas-accessor; DataCanvas spill on the flagship.
- String→number/null numeric coercion; structure search (exact/similarity/substructure) under one tool;
  bidirectional bioactivity; `max_phase` on every molecule row.
- Cross-server chain guidance + CC BY-SA attribution via `createApp({ instructions })`.

**Deferred**

- `chembl://molecule/{chemblId}` + `chembl://target/{chemblId}` resources — ship if cheap, else next pass.
- Prompts (no template-worthy workflow yet).
- A local bulk **MirrorService** index (the corpus is large; revisit if live-API latency bites).
- 3D/conformer structures, document/literature endpoints, ATC classification, cell-line/tissue resources.
- Write operations (compound registration/standardization) — out of scope by design; ChEMBL is read-only here.

---

## Decision record (for later sessions)

| Decision | Why |
|---|---|
| 8 tools, not 5 | DataCanvas spill on the flagship pulls in the standardized 3-tool canvas surface: `dataframe_query` (contractually required), `dataframe_describe` (recommended), and the opt-in `dataframe_drop` (off by default, env-gated, conditionally registered — TTL already handles cleanup). `chembl_dataframe_query` was already named in `idea.md`. |
| Structure search = `search_type` enum on `chembl_search_molecules` | Three ChEMBL endpoints, one agent action ("find molecules") — consolidate, don't fan out. |
| `search_type` defaults to `name` | The most common case is name/ID/InChIKey lookup; callers opt in to structure modes explicitly. |
| `similarity_threshold` typed as integer 40–100 | ChEMBL's `/similarity` endpoint rejects thresholds below 40; exposing the validated range in the schema prevents silent 400 errors from the upstream. |
| XOR gates enforced in handler, not Zod | Zod can't cleanly XOR two `.optional()` fields. Runtime check with `ctx.fail('missing_filter'/'missing_input', …)` keeps the schema simple for form clients and produces a typed, recoverable error for agents. |
| Raw upstream fields named `type`/`value`/`units`/`relation` in `Activity` | Carried alongside `standard_*` for auditability; not staged to the canvas (analytical queries should rank on `standard_*`). |
| `bioactivities` canvas table column list is explicit | Agents writing SQL against the canvas need the exact column names; prose-only was a gap that would cause repeated `invalid_sql` errors. |
| `CHEMBL_DEFAULT_LIMIT` config field | The same default (25) applies to all search tools; centralizing it in config avoids scattered magic numbers and lets operators tune for slower connections. |
| Bidirectional `chembl_get_bioactivities` with XOR input | The compound↔target bridge is symmetric; one tool with a molecule-or-target gate beats two near-duplicates. |
| Numerics coerced once in the service | ChEMBL ships numbers as strings; coercing at the boundary keeps schemas clean and absent→`null` honors scientific-data fidelity (never `0`). |
| Canvas only for bioactivities | Only that result is both analytical and oversized; search/drug/assay inline. |
| No auth / no scopes | Public keyless data over stdio — scopes would be empty ceremony. |
