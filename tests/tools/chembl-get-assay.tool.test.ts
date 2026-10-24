/**
 * @fileoverview Behavior tests for chembl_get_assay: the happy path with a full
 * confidence decode, a sparse assay (null confidence/target preserved as null),
 * canonical ID input (#41), and the pure format() rendering the — fallbacks for
 * absent fields and upstream text as recorded (#44).
 * @module tests/tools/chembl-get-assay.tool
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblGetAssay } from '@/mcp-server/tools/definitions/chembl-get-assay.tool.js';
import { initChemblService } from '@/services/chembl/chembl-service.js';
import { markupNodes, parseMarkdown } from '../_commonmark.js';

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

const ctx = () => createMockContext({ tenantId: 'default', errors: chemblGetAssay.errors });

describe('chembl_get_assay — provenance', () => {
  it('returns a fully-decoded assay with a coerced confidence score', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        assay_chembl_id: 'CHEMBL674637',
        description: 'Inhibition of EGFR',
        assay_type: 'B',
        assay_type_description: 'Binding',
        target_chembl_id: 'CHEMBL203',
        assay_organism: 'Homo sapiens',
        confidence_score: '9',
        confidence_description: 'Direct single protein target assigned',
      }),
    );
    const result = await chemblGetAssay.handler(
      chemblGetAssay.input.parse({ assay_chembl_id: 'CHEMBL674637' }),
      ctx(),
    );
    expect(result).toMatchObject({
      assay_chembl_id: 'CHEMBL674637',
      assay_type: 'B',
      target_chembl_id: 'CHEMBL203',
      organism: 'Homo sapiens',
      confidence_score: 9,
    });
  });

  it("preserves a sparse assay's missing fields as null", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ assay_chembl_id: 'CHEMBL1' }));
    const result = await chemblGetAssay.handler(
      chemblGetAssay.input.parse({ assay_chembl_id: 'CHEMBL1' }),
      ctx(),
    );
    expect(result.confidence_score).toBeNull();
    expect(result.target_chembl_id).toBeNull();
    expect(result.assay_type).toBeNull();
  });

  it('rejects an empty assay_chembl_id at the schema boundary', () => {
    expect(() => chemblGetAssay.input.parse({ assay_chembl_id: '' })).toThrow();
  });

  it('looks a lowercase or padded ID up as the canonical ID (#41)', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ assay_chembl_id: 'CHEMBL674637', assay_type: 'B' })),
    );
    for (const raw of ['chembl674637', '  CHEMBL674637\n']) {
      fetchMock.mockClear();
      const result = await chemblGetAssay.handler(
        chemblGetAssay.input.parse({ assay_chembl_id: raw }),
        ctx(),
      );
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        'https://www.ebi.ac.uk/chembl/api/data/assay/CHEMBL674637.json',
      );
      expect(result.assay_chembl_id).toBe('CHEMBL674637');
    }
  });

  it('rejects an ID that is no ChEMBL ID at the schema, routing to chembl_get_bioactivities (#41)', () => {
    for (const raw of ['imatinib', '   ', 'CHEMBL']) {
      const parsed = chemblGetAssay.input.safeParse({ assay_chembl_id: raw });
      expect(parsed.success, raw).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe(
        'Must be a ChEMBL assay ID like CHEMBL674637 — take one from a chembl_get_bioactivities row.',
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('chembl_get_assay format()', () => {
  it('renders the confidence line and target', () => {
    const blocks = chemblGetAssay.format!({
      assay_chembl_id: 'CHEMBL674637',
      description: 'Inhibition of EGFR',
      assay_type: 'B',
      assay_type_description: 'Binding',
      target_chembl_id: 'CHEMBL203',
      organism: 'Homo sapiens',
      confidence_score: 9,
      confidence_description: 'Direct single protein target assigned',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**CHEMBL674637**');
    expect(text).toContain('Confidence: 9');
    expect(text).toContain('Target: CHEMBL203');
  });

  it('renders — for absent fields on a sparse assay', () => {
    const blocks = chemblGetAssay.format!({
      assay_chembl_id: 'CHEMBL1',
      description: null,
      assay_type: null,
      assay_type_description: null,
      target_chembl_id: null,
      organism: null,
      confidence_score: null,
      confidence_description: null,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Confidence: —');
    expect(text).toContain('Target: —');
  });

  it('renders every line of markup-free values unescaped', () => {
    const blocks = chemblGetAssay.format!({
      assay_chembl_id: 'CHEMBL674637',
      description: 'Inhibition of EGFR',
      assay_type: 'B',
      assay_type_description: 'Binding',
      target_chembl_id: 'CHEMBL203',
      organism: 'Homo sapiens',
      confidence_score: 9,
      confidence_description: 'Direct single protein target assigned',
    });
    expect((blocks[0] as { text: string }).text.split('\n')).toEqual([
      '**CHEMBL674637**',
      'Inhibition of EGFR',
      'Type: Binding (B) | Target: CHEMBL203 | Organism: Homo sapiens',
      'Confidence: 9 (Direct single protein target assigned)',
    ]);
  });

  /**
   * #44: the description takes the line under the bold ID, so a leading `#`, `>`,
   * `-`, or `1.` would open a block there; every other field sits inside a line.
   */
  it.each([
    'Affinity in displacing [125I](R)-DOI from rat cortical homogenate 5-HT2 receptor.',
    '# Heading-like description',
    '> quoted',
    '- listed',
    '1. numbered',
    '---',
    'two *starred* and _under_ words<br>with a tag',
    String.raw`a backslash \* before punctuation`,
    'first line\n# second line',
  ])('renders the description %j as the text recorded', (description) => {
    const blocks = chemblGetAssay.format!({
      assay_chembl_id: 'CHEMBL615616',
      description,
      assay_type: 'B*',
      assay_type_description: '_Binding_',
      target_chembl_id: 'CHEMBL[1](x)',
      organism: 'Rattus <b>norvegicus</b>',
      confidence_score: 8,
      confidence_description: 'Homologous `single` protein',
    });
    const { text, nodes } = parseMarkdown((blocks[0] as { text: string }).text);
    expect(text).toBe(
      [
        'CHEMBL615616',
        description,
        'Type: _Binding_ (B*) | Target: CHEMBL[1](x) | Organism: Rattus <b>norvegicus</b>',
        'Confidence: 8 (Homologous `single` protein)',
      ].join('\n'),
    );
    expect(markupNodes(nodes)).toEqual([]);
  });

  /**
   * The issue's repro end to end: structuredContent carries the description as
   * ChEMBL recorded it, and content[] reads back to the same text.
   */
  it('keeps structuredContent as recorded while content[] reads back the same text', async () => {
    const description =
      'Affinity in displacing [125I](R)-DOI from rat cortical homogenate 5-HT2 receptor.';
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        assay_chembl_id: 'CHEMBL615616',
        description,
        assay_type: 'B',
        assay_type_description: 'Binding',
        target_chembl_id: 'CHEMBL224',
        assay_organism: 'Rattus norvegicus',
        confidence_score: '8',
        confidence_description: 'Homologous single protein target assigned',
      }),
    );
    const result = await runToolContract(chemblGetAssay, { assay_chembl_id: 'CHEMBL615616' });
    expect(result.structuredContent).toEqual({
      assay_chembl_id: 'CHEMBL615616',
      description,
      assay_type: 'B',
      assay_type_description: 'Binding',
      target_chembl_id: 'CHEMBL224',
      organism: 'Rattus norvegicus',
      confidence_score: 8,
      confidence_description: 'Homologous single protein target assigned',
    });
    const content = result.content.map((block) => (block as { text: string }).text).join('');
    const { text, nodes } = parseMarkdown(content);
    expect(text).toBe(
      [
        'CHEMBL615616',
        description,
        'Type: Binding (B) | Target: CHEMBL224 | Organism: Rattus norvegicus',
        'Confidence: 8 (Homologous single protein target assigned)',
      ].join('\n'),
    );
    expect(markupNodes(nodes)).toEqual([]);
  });
});
