/**
 * @fileoverview A fake ChEMBL over a few drug families, for the tests of the
 * parent-family rule (#36, #37). It behaves like the live API on the points that
 * rule depends on: `/molecule/{id}` answers the record with its
 * `molecule_hierarchy` (or 404), matching a ChEMBL ID in any case and any other
 * reference (an InChIKey) only as written, and `/mechanism` and
 * `/drug_indication` filter on `molecule_chembl_id` (the one form) or
 * `parent_molecule_chembl_id` (the whole family), honor `limit`, and report the
 * filtered `page_meta.total_count`. A salt's ID passed as the parent filter
 * matches nothing, as it does upstream.
 * @module tests/_fake-drug-family-upstream
 */

type Row = Record<string, unknown>;

/** The molecules, mechanisms, and indications the fake serves. */
export interface DrugFamilyCorpus {
  indications: Row[];
  mechanisms: Row[];
  /** `/molecule/{id}` records, keyed by the ID the request path names. */
  molecules: Record<string, Row>;
}

/**
 * Imatinib (CHEMBL941) and its mesylate (CHEMBL1642): every mechanism is recorded
 * on the salt, one indication on both forms at different phases, one on the salt
 * only, one on the parent only, and one with neither MeSH nor EFO ID.
 */
export const IMATINIB: DrugFamilyCorpus = {
  molecules: {
    CHEMBL941: {
      molecule_chembl_id: 'CHEMBL941',
      pref_name: 'IMATINIB',
      max_phase: '4.0',
      first_approval: 2001,
      molecule_hierarchy: {
        active_chembl_id: 'CHEMBL941',
        molecule_chembl_id: 'CHEMBL941',
        parent_chembl_id: 'CHEMBL941',
      },
    },
    CHEMBL1642: {
      molecule_chembl_id: 'CHEMBL1642',
      pref_name: 'IMATINIB MESYLATE',
      max_phase: '4.0',
      first_approval: 2001,
      molecule_hierarchy: {
        active_chembl_id: 'CHEMBL941',
        molecule_chembl_id: 'CHEMBL1642',
        parent_chembl_id: 'CHEMBL941',
      },
    },
  },
  mechanisms: [
    {
      molecule_chembl_id: 'CHEMBL1642',
      parent_molecule_chembl_id: 'CHEMBL941',
      target_chembl_id: 'CHEMBL1862',
      mechanism_of_action: 'Tyrosine-protein kinase ABL inhibitor',
      action_type: 'INHIBITOR',
    },
    {
      molecule_chembl_id: 'CHEMBL1642',
      parent_molecule_chembl_id: 'CHEMBL941',
      target_chembl_id: 'CHEMBL1936',
      mechanism_of_action: 'Stem cell growth factor receptor inhibitor',
      action_type: 'INHIBITOR',
    },
  ],
  indications: [
    {
      molecule_chembl_id: 'CHEMBL941',
      parent_molecule_chembl_id: 'CHEMBL941',
      mesh_id: 'D015464',
      mesh_heading: 'Leukemia, Myelogenous, Chronic, BCR-ABL Positive',
      efo_id: 'EFO:0000339',
      efo_term: 'chronic myelogenous leukemia',
      max_phase_for_ind: '2.0',
    },
    {
      molecule_chembl_id: 'CHEMBL1642',
      parent_molecule_chembl_id: 'CHEMBL941',
      mesh_id: 'D015464',
      mesh_heading: 'Leukemia, Myelogenous, Chronic, BCR-ABL Positive',
      efo_id: 'EFO:0000339',
      efo_term: 'chronic myelogenous leukemia',
      max_phase_for_ind: '4.0',
    },
    {
      molecule_chembl_id: 'CHEMBL1642',
      parent_molecule_chembl_id: 'CHEMBL941',
      mesh_id: 'D046152',
      mesh_heading: 'Gastrointestinal Stromal Tumors',
      efo_id: 'EFO:0000703',
      efo_term: 'gastrointestinal stromal tumor',
      max_phase_for_ind: '4.0',
    },
    {
      molecule_chembl_id: 'CHEMBL941',
      parent_molecule_chembl_id: 'CHEMBL941',
      mesh_id: 'D001249',
      mesh_heading: 'Asthma',
      efo_id: 'EFO:0000270',
      efo_term: 'asthma',
      max_phase_for_ind: '2.0',
    },
    {
      molecule_chembl_id: 'CHEMBL1642',
      parent_molecule_chembl_id: 'CHEMBL941',
      mesh_heading: 'Unmapped condition',
      max_phase_for_ind: '1.0',
    },
  ],
};

/**
 * Rapacuronium (CHEMBL1201352): ChEMBL records no hierarchy on it, and its one
 * mechanism sits on another form whose parent it is.
 */
export const RAPACURONIUM: DrugFamilyCorpus = {
  molecules: {
    CHEMBL1201352: {
      molecule_chembl_id: 'CHEMBL1201352',
      pref_name: 'RAPACURONIUM',
      max_phase: '4.0',
      first_approval: 1999,
      molecule_hierarchy: null,
    },
  },
  mechanisms: [
    {
      molecule_chembl_id: 'CHEMBL1200549',
      parent_molecule_chembl_id: 'CHEMBL1201352',
      target_chembl_id: 'CHEMBL2362997',
      mechanism_of_action: 'Muscle-type nicotinic acetylcholine receptor antagonist',
      action_type: 'ANTAGONIST',
    },
  ],
  indications: [],
};

/**
 * A prodrug whose `active_chembl_id` is a different molecule than its parent: the
 * active metabolite's own family carries a mechanism the prodrug's must not show.
 */
export const PRODRUG: DrugFamilyCorpus = {
  molecules: {
    CHEMBL900001: {
      molecule_chembl_id: 'CHEMBL900001',
      pref_name: 'PRODRUG SODIUM',
      max_phase: '4.0',
      first_approval: 2010,
      molecule_hierarchy: {
        active_chembl_id: 'CHEMBL900003',
        molecule_chembl_id: 'CHEMBL900001',
        parent_chembl_id: 'CHEMBL900002',
      },
    },
  },
  mechanisms: [
    {
      molecule_chembl_id: 'CHEMBL900001',
      parent_molecule_chembl_id: 'CHEMBL900002',
      target_chembl_id: 'CHEMBL1',
      mechanism_of_action: 'Prodrug family mechanism',
      action_type: 'INHIBITOR',
    },
    {
      molecule_chembl_id: 'CHEMBL900003',
      parent_molecule_chembl_id: 'CHEMBL900003',
      target_chembl_id: 'CHEMBL2',
      mechanism_of_action: 'Active metabolite mechanism',
      action_type: 'AGONIST',
    },
  ],
  indications: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The rows a list request selects: its one form, or its whole family by parent. */
function select(rows: Row[], params: URLSearchParams): Row[] {
  const form = params.get('molecule_chembl_id');
  const parent = params.get('parent_molecule_chembl_id');
  return rows.filter(
    (row) =>
      (form === null || row.molecule_chembl_id === form) &&
      (parent === null || row.parent_molecule_chembl_id === parent),
  );
}

/** A list envelope over the selected rows, `limit` applied as ChEMBL applies it. */
function listResponse(key: string, rows: Row[], params: URLSearchParams): Response {
  const selected = select(rows, params);
  const limit = Number(params.get('limit') ?? 20);
  return jsonResponse({
    [key]: selected.slice(0, limit),
    page_meta: { total_count: selected.length },
  });
}

/** A `fetch` implementation over `corpus`; anything else it is sent rejects. */
export function drugFamilyUpstream(
  corpus: DrugFamilyCorpus,
): (input: string | URL | Request) => Promise<Response> {
  return (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname.replace('/chembl/api/data/', '');
    if (path === 'mechanism.json') {
      return Promise.resolve(listResponse('mechanisms', corpus.mechanisms, url.searchParams));
    }
    if (path === 'drug_indication.json') {
      return Promise.resolve(
        listResponse('drug_indications', corpus.indications, url.searchParams),
      );
    }
    const molecule = /^molecule\/([^/]+)\.json$/.exec(path)?.[1];
    if (molecule !== undefined) {
      const ref = decodeURIComponent(molecule);
      const record = corpus.molecules[/^chembl\d+$/i.test(ref) ? ref.toUpperCase() : ref];
      return Promise.resolve(
        record ? jsonResponse(record) : jsonResponse({ error_message: 'Not found.' }, 404),
      );
    }
    return Promise.reject(new Error(`unrouted fetch: ${url.toString()}`));
  };
}
