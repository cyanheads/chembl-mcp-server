/**
 * @fileoverview Exercise bioactivity staging and SQL through real DuckDB so
 * schema inference cannot hide numeric loss behind a canvas fake.
 * @module tests/tools/chembl-canvas-precision
 */

import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { chemblDataframeDescribe } from '@/mcp-server/tools/definitions/chembl-dataframe-describe.tool.js';
import { chemblDataframeQuery } from '@/mcp-server/tools/definitions/chembl-dataframe-query.tool.js';
import { chemblGetBioactivities } from '@/mcp-server/tools/definitions/chembl-get-bioactivities.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { initChemblService } from '@/services/chembl/chembl-service.js';

let canvas: DataCanvas;
const context = { tenantId: 'precision-test' };

beforeEach(() => {
  const provider = new DuckdbProvider({
    defaultRowLimit: 1000,
    exportRootPath: '.canvas-exports',
    memoryLimitMb: 64,
    schemaSniffRows: 100,
  });
  canvas = new DataCanvas(provider, new CanvasRegistry(provider));
  setCanvas(canvas);
  // Two 120-row pages: the walk advances by offset at this page size.
  initChemblService({ ...getServerConfig(), maxPageSize: 120 });
});

afterEach(async () => {
  await canvas.shutdown(createMockContext(context));
  setCanvas(undefined);
  vi.unstubAllGlobals();
});

/**
 * The smallest view that crosses both boundaries the table exists for: two 2-row
 * pages of ~31,000-character rows. The 50,000-character fit line falls on the
 * first page's second row, so the preview buffer a schema would be inferred from
 * holds only first-page values; the fractions sit on the second page, past it.
 */
const PAGE_ROWS = 2;
const VIEW_ROWS = 2 * PAGE_ROWS;

describe('bioactivity precision through DuckDB', () => {
  it.each([
    ['fractional preview', '8.1', '0.5', 'potency_ranked'],
    ['integer preview', '8', '0', 'potency_ranked'],
    ['sparse preview', '8', null, 'potency_ranked'],
    ['null-potency preview', null, null, 'null_potency'],
  ] as const)('preserves later fractions after a %s', async (_name, potency, value, view) => {
    initChemblService({ ...getServerConfig(), maxPageSize: PAGE_ROWS });
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!url.searchParams.has('order_by')) {
        return Promise.resolve(Response.json({ page_meta: { total_count: VIEW_ROWS } }));
      }
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return Promise.resolve(
        Response.json({
          activities: Array.from({ length: PAGE_ROWS }, (_, i) => ({
            activity_id: offset + i + 1,
            molecule_chembl_id: 'CHEMBL25',
            target_chembl_id: 'CHEMBL203',
            assay_chembl_id: 'CHEMBL674637',
            assay_description: 'Assay measurement '.repeat(1700),
            pchembl_value: view === 'null_potency' ? null : offset === 0 ? potency : '7.39',
            standard_value: offset === 0 ? value : i < PAGE_ROWS / 2 ? '1' : '0.25',
            value: '001',
          })),
          page_meta: { total_count: VIEW_ROWS },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const staged = await runToolContract(
      chemblGetBioactivities,
      {
        target_chembl_id: 'CHEMBL203',
        limit: 1,
        potency_view: view,
      },
      { context },
    );
    expect(staged.isError).toBeFalsy();
    expect(staged.structuredContent).toMatchObject({ spilled: true, staged_row_count: VIEW_ROWS });
    const output = chemblGetBioactivities.output.parse(staged.structuredContent);
    // One row fits the 50,000-character budget a limit of 1 buys and two do not: the fit line is row 2.
    const rowWidth = JSON.stringify(output.activities[0]).length;
    expect(rowWidth).toBeGreaterThan(25_000);
    expect(rowWidth).toBeLessThanOrEqual(50_000);
    const result = await runToolContract(
      chemblDataframeQuery,
      chemblDataframeQuery.input.parse({
        canvas_id: output.canvas_id,
        sql: `SELECT pchembl_value, standard_value, value FROM ${output.table_name} WHERE activity_id = ${VIEW_ROWS}`,
      }),
      { context },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      rows: [
        {
          pchembl_value: view === 'null_potency' ? null : 7.39,
          standard_value: 0.25,
          value: '001',
        },
      ],
      row_count: 1,
    });
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    if (view === 'potency_ranked') expect(text).toContain('7.39');
    expect(text).toContain('0.25');
    expect(text).toContain('001');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('comment, variant, and document columns through DuckDB (#38, #39)', () => {
  /** 240 rows: every third commented, every fifth flagged, every fourth a mutant, every sixth from a deposited dataset. */
  function serve(view: 'potency_ranked' | 'null_potency') {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (!url.searchParams.has('order_by')) {
          return Promise.resolve(Response.json({ page_meta: { total_count: 480 } }));
        }
        const offset = Number(url.searchParams.get('offset') ?? 0);
        return Promise.resolve(
          Response.json({
            activities: Array.from({ length: 120 }, (_, i) => {
              const n = offset + i;
              return {
                activity_id: n + 1,
                molecule_chembl_id: 'CHEMBL941',
                target_chembl_id: 'CHEMBL1862',
                assay_chembl_id: 'CHEMBL674637',
                assay_description: 'Assay measurement '.repeat(40),
                pchembl_value: view === 'null_potency' ? null : '7.39',
                activity_comment: n % 3 === 0 ? 'Not Active' : null,
                data_validity_comment: n % 5 === 0 ? 'Outside typical range' : null,
                assay_variant_mutation: n % 4 === 0 ? 'T315I' : null,
                assay_variant_accession: n % 4 === 0 ? 'P00519' : null,
                document_chembl_id: `CHEMBL${1_100_000 + (n % 7)}`,
                document_year: n % 6 === 0 ? null : 2000 + (n % 20),
              };
            }),
            page_meta: { total_count: 240 },
          }),
        );
      }),
    );
  }

  async function sql(canvasId: string, query: string) {
    const result = await runToolContract(
      chemblDataframeQuery,
      chemblDataframeQuery.input.parse({ canvas_id: canvasId, sql: query }),
      { context },
    );
    expect(result.isError).toBeFalsy();
    return (result.structuredContent as { rows: Record<string, unknown>[] }).rows;
  }

  it('stages all six as typed columns on both view tables, queryable by SQL', async () => {
    let canvasId: string | undefined;
    for (const view of ['potency_ranked', 'null_potency'] as const) {
      serve(view);
      const staged = await runToolContract(
        chemblGetBioactivities,
        {
          target_chembl_id: 'CHEMBL1862',
          limit: 1,
          potency_view: view,
          ...(canvasId && { canvas_id: canvasId }),
        },
        { context },
      );
      expect(staged.isError).toBeFalsy();
      expect(staged.structuredContent).toMatchObject({ spilled: true, staged_row_count: 240 });
      canvasId =
        chemblGetBioactivities.output.parse(staged.structuredContent).canvas_id ?? undefined;
    }
    if (!canvasId) throw new Error('nothing was staged');

    const described = await runToolContract(
      chemblDataframeDescribe,
      chemblDataframeDescribe.input.parse({ canvas_id: canvasId }),
      { context },
    );
    const tables = (
      described.structuredContent as {
        tables: { name: string; columns: { name: string; type: string }[] }[];
      }
    ).tables;
    for (const name of ['bioactivities', 'bioactivities_null_potency']) {
      const columns = Object.fromEntries(
        (tables.find((t) => t.name === name)?.columns ?? []).map((c) => [c.name, c.type]),
      );
      expect(columns).toMatchObject({
        activity_comment: 'VARCHAR',
        data_validity_comment: 'VARCHAR',
        assay_variant_mutation: 'VARCHAR',
        assay_variant_accession: 'VARCHAR',
        document_chembl_id: 'VARCHAR',
        document_year: 'INTEGER',
      });
    }

    expect(
      await sql(
        canvasId,
        'SELECT data_validity_comment, COUNT(*) AS n FROM bioactivities_null_potency GROUP BY 1 ORDER BY 2',
      ),
    ).toEqual([
      { data_validity_comment: 'Outside typical range', n: 48 },
      { data_validity_comment: null, n: 192 },
    ]);
    expect(
      await sql(
        canvasId,
        "SELECT COUNT(*) AS mutants, COUNT(document_year) AS dated, MIN(document_year) AS first FROM bioactivities WHERE assay_variant_mutation = 'T315I'",
      ),
    ).toEqual([{ mutants: 60, dated: 40, first: 2000 }]);
    expect(
      await sql(
        canvasId,
        "SELECT COUNT(*) AS n FROM bioactivities WHERE activity_comment = 'Not Active'",
      ),
    ).toEqual([{ n: 80 }]);
  });
});
