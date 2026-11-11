/**
 * @fileoverview A fake ChEMBL over a few drug families, for the tests of the
 * parent-family rule (#36, #37) and the family's regulatory record (#51). It
 * behaves like the live API on the points those rules depend on: `/molecule/{id}`
 * answers the record with its `molecule_hierarchy` (or 404), matching a ChEMBL ID
 * in any case and any other reference (an InChIKey) only as written;
 * `/mechanism`, `/drug_indication`, and `/drug_warning` filter on
 * `molecule_chembl_id` (the one form) or `parent_molecule_chembl_id` (the whole
 * family); `/molecule` lists a family by `molecule_hierarchy__parent_chembl_id`,
 * which matches no molecule ChEMBL records no hierarchy for. Every list honors
 * `limit` and reports the filtered `page_meta.total_count`, and `only=` keeps the
 * named fields alone, dropping the rest as ChEMBL does — so a field a reader
 * needs but never asks for reads as absent here too. A salt's ID passed as the
 * parent filter matches nothing, as it does upstream.
 * @module tests/_fake-drug-family-upstream
 */

type Row = Record<string, unknown>;

/** The molecules, mechanisms, indications, and warnings the fake serves. */
export interface DrugFamilyCorpus {
  indications: Row[];
  mechanisms: Row[];
  /** `/molecule/{id}` records, keyed by the ID the request path names. */
  molecules: Record<string, Row>;
  /** `/drug_warning` rows; none when omitted. */
  warnings?: Row[];
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
      withdrawn_flag: false,
      black_box_warning: 0,
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
      withdrawn_flag: false,
      black_box_warning: 0,
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

/** A family member's `/molecule/{id}` record: hierarchy, phase, approval, and the two flags. */
function form(
  id: string,
  parent: string,
  fields: {
    pref_name?: string | null;
    max_phase: string | null;
    first_approval: number | null;
    withdrawn_flag: boolean;
    black_box_warning: number;
  },
): Row {
  return {
    molecule_chembl_id: id,
    pref_name: null,
    ...fields,
    molecule_hierarchy: {
      active_chembl_id: parent,
      molecule_chembl_id: id,
      parent_chembl_id: parent,
    },
  };
}

/** A `/drug_warning` row filed on `form` under `parent`. */
function warning(form: string, parent: string, fields: Row): Row {
  return {
    molecule_chembl_id: form,
    parent_molecule_chembl_id: parent,
    warning_id: 0,
    efo_id: null,
    efo_term: null,
    efo_id_for_warning_class: null,
    warning_class: null,
    warning_country: null,
    warning_description: null,
    warning_year: null,
    warning_refs: [],
    ...fields,
  };
}

/**
 * Rofecoxib (CHEMBL122): the parent carries both flags; its two other forms
 * carry neither and record no phase. A boxed warning with no class, year,
 * description, EFO term, or reference, and a worldwide withdrawal with three.
 */
export const ROFECOXIB: DrugFamilyCorpus = {
  molecules: {
    CHEMBL122: form('CHEMBL122', 'CHEMBL122', {
      pref_name: 'ROFECOXIB',
      max_phase: '4.0',
      first_approval: 1999,
      withdrawn_flag: true,
      black_box_warning: 1,
    }),
    CHEMBL4465601: form('CHEMBL4465601', 'CHEMBL122', {
      max_phase: null,
      first_approval: null,
      withdrawn_flag: false,
      black_box_warning: 0,
    }),
    CHEMBL5171570: form('CHEMBL5171570', 'CHEMBL122', {
      max_phase: null,
      first_approval: null,
      withdrawn_flag: false,
      black_box_warning: 0,
    }),
  },
  mechanisms: [
    {
      molecule_chembl_id: 'CHEMBL122',
      parent_molecule_chembl_id: 'CHEMBL122',
      target_chembl_id: 'CHEMBL230',
      mechanism_of_action: 'Cyclooxygenase-2 inhibitor',
      action_type: 'INHIBITOR',
    },
  ],
  indications: [
    {
      molecule_chembl_id: 'CHEMBL122',
      parent_molecule_chembl_id: 'CHEMBL122',
      mesh_id: 'D012216',
      mesh_heading: 'Rheumatic Diseases',
      efo_id: 'EFO:0005755',
      efo_term: 'rheumatic disease',
      max_phase_for_ind: '4.0',
    },
  ],
  warnings: [
    warning('CHEMBL122', 'CHEMBL122', {
      warning_type: 'Black Box Warning',
      warning_country: 'United States',
    }),
    warning('CHEMBL122', 'CHEMBL122', {
      warning_type: 'Withdrawn',
      warning_class: 'cardiotoxicity',
      warning_country: 'Worldwide',
      warning_year: 2004,
      warning_description: 'Risk for heart attack and stroke',
      efo_id: 'EFO:0000712',
      efo_term: 'stroke',
      warning_refs: [
        {
          ref_id: 'FR-2014-07-02/pdf/2014-15371.pdf',
          ref_type: 'USGPO',
          ref_url: 'https://www.govinfo.gov/content/pkg/FR-2014-07-02/pdf/2014-15371.pdf',
        },
        {
          ref_id: 'WHO/PSM/QSM/2005.2',
          ref_type: 'WHO',
          ref_url: 'https://apps.who.int/iris/handle/10665/66869',
        },
        {
          ref_id: '21574210',
          ref_type: 'PubMed',
          ref_url: 'http://europepmc.org/abstract/MED/21574210',
        },
      ],
    }),
  ],
};

/**
 * Rosiglitazone (CHEMBL121) and its maleate (CHEMBL843): the boxed warning is
 * filed on the salt only, the withdrawals on both forms.
 */
export const ROSIGLITAZONE: DrugFamilyCorpus = {
  molecules: {
    CHEMBL121: form('CHEMBL121', 'CHEMBL121', {
      pref_name: 'ROSIGLITAZONE',
      max_phase: '4.0',
      first_approval: 1999,
      withdrawn_flag: true,
      black_box_warning: 0,
    }),
    CHEMBL843: form('CHEMBL843', 'CHEMBL121', {
      pref_name: 'ROSIGLITAZONE MALEATE',
      max_phase: '4.0',
      first_approval: 1999,
      withdrawn_flag: true,
      black_box_warning: 1,
    }),
  },
  mechanisms: [],
  indications: [],
  warnings: [
    warning('CHEMBL843', 'CHEMBL121', {
      warning_type: 'Black Box Warning',
      warning_class: 'cardiotoxicity',
      warning_country: 'United States',
      warning_refs: [
        {
          ref_id: 'ec682aec-e98f-41a1-9d21-eb7580ea3a8a',
          ref_type: 'DailyMed',
          ref_url:
            'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=ec682aec-e98f-41a1-9d21-eb7580ea3a8a',
        },
      ],
    }),
    warning('CHEMBL121', 'CHEMBL121', {
      warning_type: 'Withdrawn',
      warning_class: 'cardiotoxicity',
      warning_country: 'Armenia; Guatemala; Egypt; New Zealand; Madagascar; European Union',
      warning_year: 2010,
      warning_description: 'Elevated risk of cardiovascular events',
      efo_id: 'EFO:1001482',
      efo_term: 'cardiotoxicity',
    }),
    warning('CHEMBL843', 'CHEMBL121', {
      warning_type: 'Withdrawn',
      warning_class: 'cardiotoxicity',
      warning_country: 'Armenia; Guatemala; Egypt; New Zealand; Madagascar; European Union',
      warning_year: 2010,
      warning_description: 'Increased risk of ischaemic heart disease',
      efo_id: 'EFO:0003144',
      efo_term: 'heart failure',
    }),
  ],
};

/**
 * Dicyclomine hydrochloride (CHEMBL1200479) carries no flag of its own; its
 * parent (CHEMBL1123) was withdrawn in Norway alone, with no class, year, or
 * reference recorded.
 */
export const DICYCLOMINE: DrugFamilyCorpus = {
  molecules: {
    CHEMBL1123: form('CHEMBL1123', 'CHEMBL1123', {
      pref_name: 'DICYCLOMINE',
      max_phase: '4.0',
      first_approval: 1950,
      withdrawn_flag: true,
      black_box_warning: 0,
    }),
    CHEMBL1200479: form('CHEMBL1200479', 'CHEMBL1123', {
      pref_name: 'DICYCLOMINE HYDROCHLORIDE',
      max_phase: '4.0',
      first_approval: 1950,
      withdrawn_flag: false,
      black_box_warning: 0,
    }),
  },
  mechanisms: [],
  indications: [],
  warnings: [
    warning('CHEMBL1123', 'CHEMBL1123', {
      warning_type: 'Withdrawn',
      warning_country: 'Norway',
      warning_description: 'Serious adverse reactions in infants under six months',
      efo_id: 'EFO:0009658',
      efo_term: 'adverse effect',
    }),
  ],
};

/**
 * Almitrine mesylate (CHEMBL3181957) records phase −1 and no approval; its
 * parent (CHEMBL1183717) reached phase 4 for the indication filed on it, and was
 * withdrawn. No form records an approval year.
 */
export const ALMITRINE: DrugFamilyCorpus = {
  molecules: {
    CHEMBL1183717: form('CHEMBL1183717', 'CHEMBL1183717', {
      pref_name: 'ALMITRINE',
      max_phase: '4.0',
      first_approval: null,
      withdrawn_flag: true,
      black_box_warning: 0,
    }),
    CHEMBL3181957: form('CHEMBL3181957', 'CHEMBL1183717', {
      pref_name: 'ALMITRINE MESYLATE',
      max_phase: '-1.0',
      first_approval: null,
      withdrawn_flag: false,
      black_box_warning: 0,
    }),
    CHEMBL314610: form('CHEMBL314610', 'CHEMBL1183717', {
      max_phase: null,
      first_approval: null,
      withdrawn_flag: false,
      black_box_warning: 0,
    }),
  },
  mechanisms: [],
  indications: [
    {
      molecule_chembl_id: 'CHEMBL1183717',
      parent_molecule_chembl_id: 'CHEMBL1183717',
      mesh_id: 'D012140',
      mesh_heading: 'Respiratory Tract Diseases',
      efo_id: 'EFO:0000684',
      efo_term: 'respiratory system disease',
      max_phase_for_ind: '4.0',
    },
  ],
  warnings: [],
};

/**
 * Inotersen (CHEMBL4297770) carries no boxed warning and no approval year of its
 * own; its sodium salt (CHEMBL4297537) carries both.
 */
export const INOTERSEN: DrugFamilyCorpus = {
  molecules: {
    CHEMBL4297770: form('CHEMBL4297770', 'CHEMBL4297770', {
      pref_name: 'INOTERSEN',
      max_phase: '4.0',
      first_approval: null,
      withdrawn_flag: false,
      black_box_warning: 0,
    }),
    CHEMBL4297537: form('CHEMBL4297537', 'CHEMBL4297770', {
      pref_name: 'INOTERSEN SODIUM',
      max_phase: '4.0',
      first_approval: 2018,
      withdrawn_flag: false,
      black_box_warning: 1,
    }),
  },
  mechanisms: [],
  indications: [],
  warnings: [
    warning('CHEMBL4297537', 'CHEMBL4297770', {
      warning_type: 'Black Box Warning',
      warning_country: 'United States',
      warning_refs: [
        {
          ref_id: '8513207e-b55f-417b-9473-af785146a543',
          ref_type: 'DailyMed',
          ref_url:
            'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=8513207e-b55f-417b-9473-af785146a543',
        },
      ],
    }),
  ],
};

/**
 * Tetrabenazine (CHEMBL117785, approved 2008) and the deuterated forms ChEMBL
 * files under it: deutetrabenazine (CHEMBL3137326), approved on its own in 2017,
 * and a synthetic deuterated analog (CHEMBL900020) at phase 2 with no approval
 * year and no flag. The boxed warnings are filed on the two approved forms.
 */
export const TETRABENAZINE: DrugFamilyCorpus = {
  molecules: {
    CHEMBL117785: form('CHEMBL117785', 'CHEMBL117785', {
      pref_name: 'TETRABENAZINE',
      max_phase: '4.0',
      first_approval: 2008,
      withdrawn_flag: false,
      black_box_warning: 1,
    }),
    CHEMBL3137326: form('CHEMBL3137326', 'CHEMBL117785', {
      pref_name: 'DEUTETRABENAZINE',
      max_phase: '4.0',
      first_approval: 2017,
      withdrawn_flag: false,
      black_box_warning: 1,
    }),
    CHEMBL900020: form('CHEMBL900020', 'CHEMBL117785', {
      pref_name: 'DEUTERATED ANALOG',
      max_phase: '2.0',
      first_approval: null,
      withdrawn_flag: false,
      black_box_warning: 0,
    }),
  },
  mechanisms: [],
  indications: [],
  warnings: [
    warning('CHEMBL3137326', 'CHEMBL117785', {
      warning_type: 'Black Box Warning',
      warning_class: 'psychiatric toxicity',
      warning_country: 'United States',
    }),
    warning('CHEMBL117785', 'CHEMBL117785', {
      warning_type: 'Black Box Warning',
      warning_class: 'psychiatric toxicity',
      warning_country: 'United States',
    }),
  ],
};

/** Gefitinib (CHEMBL939): one form, neither flag, no warning. */
export const GEFITINIB: DrugFamilyCorpus = {
  molecules: {
    CHEMBL939: form('CHEMBL939', 'CHEMBL939', {
      pref_name: 'GEFITINIB',
      max_phase: '4.0',
      first_approval: 2003,
      withdrawn_flag: false,
      black_box_warning: 0,
    }),
  },
  mechanisms: [
    {
      molecule_chembl_id: 'CHEMBL939',
      parent_molecule_chembl_id: 'CHEMBL939',
      target_chembl_id: 'CHEMBL203',
      mechanism_of_action: 'Epidermal growth factor receptor erbB1 inhibitor',
      action_type: 'INHIBITOR',
    },
  ],
  indications: [],
  warnings: [],
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

/** `row` cut to the fields `only=` names, as ChEMBL cuts it; the whole row without one. */
function project(row: Row, params: URLSearchParams): Row {
  const only = params.get('only');
  if (only === null) return row;
  return Object.fromEntries(
    only.split(',').flatMap((field) => (field in row ? [[field, row[field]]] : [])),
  );
}

/** A list envelope over the selected rows, `limit` and `only=` applied as ChEMBL applies them. */
function listResponse(key: string, selected: Row[], params: URLSearchParams): Response {
  const limit = Number(params.get('limit') ?? 20);
  return jsonResponse({
    [key]: selected.slice(0, limit).map((row) => project(row, params)),
    page_meta: { total_count: selected.length },
  });
}

/**
 * The forms `/molecule.json` lists under `molecule_hierarchy__parent_chembl_id`,
 * each record once however many references key it. A molecule ChEMBL records no
 * hierarchy for has no parent to match.
 */
function family(corpus: DrugFamilyCorpus, parent: string): Row[] {
  const records = new Set(Object.values(corpus.molecules));
  return [...records].filter(
    (record) =>
      (record.molecule_hierarchy as { parent_chembl_id?: unknown } | null | undefined)
        ?.parent_chembl_id === parent,
  );
}

/** A `fetch` implementation over `corpus`; anything else it is sent rejects. */
export function drugFamilyUpstream(
  corpus: DrugFamilyCorpus,
): (input: string | URL | Request) => Promise<Response> {
  return (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname.replace('/chembl/api/data/', '');
    const params = url.searchParams;
    if (path === 'mechanism.json') {
      return Promise.resolve(listResponse('mechanisms', select(corpus.mechanisms, params), params));
    }
    if (path === 'drug_indication.json') {
      return Promise.resolve(
        listResponse('drug_indications', select(corpus.indications, params), params),
      );
    }
    if (path === 'drug_warning.json') {
      return Promise.resolve(
        listResponse('drug_warnings', select(corpus.warnings ?? [], params), params),
      );
    }
    const parent = params.get('molecule_hierarchy__parent_chembl_id');
    if (path === 'molecule.json' && parent !== null) {
      return Promise.resolve(listResponse('molecules', family(corpus, parent), params));
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
