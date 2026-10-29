# SQL recipes for chembl_dataframe_query

DuckDB SQL over the tables `chembl_get_bioactivities` stages: `bioactivities` (the `potency_ranked` view) and `bioactivities_null_potency`. Both have the same columns; `chembl_dataframe_describe` lists them. Swap in your own IDs.

## Leads on one target, per compound

Stage the target with one `standard_type` and `variant: "wild_type"` first.

```sql
SELECT molecule_chembl_id, COUNT(*) AS n, MEDIAN(pchembl_value) AS med_p, COUNT(DISTINCT document_chembl_id) AS docs
FROM bioactivities
WHERE assay_type = 'B'
GROUP BY 1
ORDER BY med_p DESC, n DESC
LIMIT 20
```

## How much of a target view is mutant

Run on a view staged without `variant`.

```sql
SELECT assay_variant_mutation, COUNT(*) AS n, COUNT(DISTINCT molecule_chembl_id) AS mols, MAX(pchembl_value) AS maxp
FROM bioactivities
GROUP BY 1
ORDER BY 2 DESC
```

A null `assay_variant_mutation` is the wild-type group.

## A compound's targets with a potency

```sql
SELECT target_chembl_id, target_pref_name AS tname, target_organism AS org, COUNT(*) AS n, MEDIAN(pchembl_value) AS med
FROM bioactivities
GROUP BY ALL
ORDER BY n DESC
LIMIT 30
```

## Targets with no potency value

Needs both views staged on one canvas. These targets have only censored, single-point, or comment-only results; read each one's `standard_relation`, `standard_value`, and `activity_comment` before calling it inactive, since a single-concentration `Inhibition` percentage is a result without a potency.

```sql
SELECT target_chembl_id, ANY_VALUE(target_pref_name) AS tname, STRING_AGG(DISTINCT standard_type, ', ') AS types, COUNT(*) AS n
FROM bioactivities_null_potency
WHERE target_chembl_id NOT IN (SELECT target_chembl_id FROM bioactivities)
GROUP BY 1
ORDER BY n DESC
LIMIT 30
```

## Selectivity between two targets, per document

Each row is one document that measured the compound on both targets; compare `abl1` and `kit` within a row, never across rows.

```sql
SELECT document_chembl_id, standard_type,
  MAX(pchembl_value) FILTER (WHERE target_chembl_id = 'CHEMBL1862') AS abl1,
  MAX(pchembl_value) FILTER (WHERE target_chembl_id = 'CHEMBL1936') AS kit
FROM bioactivities
WHERE target_chembl_id IN ('CHEMBL1862', 'CHEMBL1936') AND assay_variant_mutation IS NULL
GROUP BY ALL
HAVING COUNT(DISTINCT target_chembl_id) = 2
ORDER BY 1
```

## All evidence for one target, ranked and inactive together

```sql
SELECT target_pref_name AS tname, standard_type, standard_relation, standard_value, pchembl_value, activity_comment, document_chembl_id
FROM (SELECT * FROM bioactivities UNION ALL SELECT * FROM bioactivities_null_potency)
WHERE target_chembl_id = 'CHEMBL203'
ORDER BY pchembl_value DESC NULLS LAST
LIMIT 20
```
