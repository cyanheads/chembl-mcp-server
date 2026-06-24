/**
 * @fileoverview Behavior tests for chembl_search_targets beyond the input gate:
 * the happy path through a stubbed upstream, the empty-result notice that echoes
 * the filters, truncation enrichment, and the pure format() rendering components
 * and gene symbols (with — fallbacks).
 * @module tests/tools/chembl-search-targets.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblSearchTargets } from '@/mcp-server/tools/definitions/chembl-search-targets.tool.js';
import { initChemblService } from '@/services/chembl/chembl-service.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(() => {
  initChemblService(getServerConfig());
});

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ctx = () => createMockContext({ tenantId: 'default', errors: chemblSearchTargets.errors });

const egfrRaw = {
  target_chembl_id: 'CHEMBL203',
  pref_name: 'Epidermal growth factor receptor',
  target_type: 'SINGLE PROTEIN',
  organism: 'Homo sapiens',
  target_components: [
    {
      accession: 'P00533',
      target_component_synonyms: [{ component_synonym: 'EGFR', syn_type: 'GENE_SYMBOL' }],
    },
  ],
};

describe('chembl_search_targets — resolution', () => {
  it('returns a flattened target for an accession lookup', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ targets: [egfrRaw], page_meta: { total_count: 1 } }),
    );
    const c = ctx();
    const result = await chemblSearchTargets.handler(
      chemblSearchTargets.input.parse({ accession: 'P00533' }),
      c,
    );
    expect(result.targets[0]).toMatchObject({
      target_chembl_id: 'CHEMBL203',
      target_type: 'SINGLE PROTEIN',
    });
    expect(result.targets[0]?.components[0]?.gene_symbols).toEqual(['EGFR']);
    expect(getEnrichment(c)).toMatchObject({ totalCount: 1, truncated: false });
  });

  it('emits a notice echoing the filters when no target matched', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ targets: [], page_meta: { total_count: 0 } }));
    const c = ctx();
    const result = await chemblSearchTargets.handler(
      chemblSearchTargets.input.parse({ accession: 'P99999', gene_symbol: 'ZZZ9' }),
      c,
    );
    expect(result.targets).toEqual([]);
    const enrichment = getEnrichment(c) as { notice?: string };
    expect(enrichment.notice).toContain('P99999');
    expect(enrichment.notice).toContain('ZZZ9');
  });

  it('flags truncation at the limit boundary', async () => {
    const targets = Array.from({ length: 3 }, (_, i) => ({
      ...egfrRaw,
      target_chembl_id: `CHEMBL${i}`,
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ targets, page_meta: { total_count: 40 } }));
    const c = ctx();
    await chemblSearchTargets.handler(
      chemblSearchTargets.input.parse({ query: 'kinase', limit: 3 }),
      c,
    );
    expect(getEnrichment(c)).toMatchObject({ truncated: true, shown: 3, cap: 3 });
  });
});

describe('chembl_search_targets format()', () => {
  it('renders target id, type, organism, and per-component gene symbols', () => {
    const blocks = chemblSearchTargets.format!({
      targets: [
        {
          target_chembl_id: 'CHEMBL203',
          pref_name: 'Epidermal growth factor receptor',
          target_type: 'SINGLE PROTEIN',
          organism: 'Homo sapiens',
          components: [{ accession: 'P00533', gene_symbols: ['EGFR', 'ERBB1'] }],
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**CHEMBL203**');
    expect(text).toContain('Type: SINGLE PROTEIN');
    expect(text).toContain('accession P00533');
    expect(text).toContain('genes: EGFR, ERBB1');
  });

  it('renders — for a component with no gene symbols and a null accession', () => {
    const blocks = chemblSearchTargets.format!({
      targets: [
        {
          target_chembl_id: 'CHEMBL999',
          pref_name: null,
          target_type: null,
          organism: null,
          components: [{ accession: null, gene_symbols: [] }],
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('(unnamed)');
    expect(text).toContain('accession —');
    expect(text).toContain('genes: —');
  });

  it('renders the empty marker for no targets', () => {
    const blocks = chemblSearchTargets.format!({ targets: [] });
    expect((blocks[0] as { text: string }).text).toContain('No matching targets');
  });
});
