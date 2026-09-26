/**
 * @fileoverview Exercise bioactivity staging and SQL through real DuckDB so
 * schema inference cannot hide numeric loss behind a canvas fake.
 * @module tests/tools/chembl-canvas-precision
 */

import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
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
  initChemblService(getServerConfig());
});

afterEach(async () => {
  await canvas.shutdown(createMockContext(context));
  setCanvas(undefined);
  vi.unstubAllGlobals();
});

describe('bioactivity precision through DuckDB', () => {
  it.each([
    ['fractional preview', '8.1', '0.5', 'potency_ranked'],
    ['integer preview', '8', '0', 'potency_ranked'],
    ['sparse preview', '8', null, 'potency_ranked'],
    ['null-potency preview', null, null, 'null_potency'],
  ] as const)('preserves later fractions after a %s', async (_name, potency, value, view) => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!url.searchParams.has('order_by')) {
        return Promise.resolve(Response.json({ page_meta: { total_count: 240 } }));
      }
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return Promise.resolve(
        Response.json({
          activities: Array.from({ length: 120 }, (_, i) => ({
            activity_id: offset + i + 1,
            molecule_chembl_id: 'CHEMBL25',
            target_chembl_id: 'CHEMBL203',
            assay_chembl_id: 'CHEMBL674637',
            assay_description: 'Assay measurement '.repeat(40),
            pchembl_value: view === 'null_potency' ? null : offset === 0 ? potency : '7.39',
            standard_value: offset === 0 ? value : i < 60 ? '1' : '0.25',
            value: '001',
          })),
          page_meta: {
            total_count: 240,
            next:
              offset === 0
                ? '/chembl/api/data/activity.json?offset=120&order_by=-pchembl_value'
                : null,
          },
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
    expect(staged.structuredContent).toMatchObject({ spilled: true, staged_row_count: 240 });
    const output = chemblGetBioactivities.output.parse(staged.structuredContent);
    const result = await runToolContract(
      chemblDataframeQuery,
      chemblDataframeQuery.input.parse({
        canvas_id: output.canvas_id,
        sql: `SELECT pchembl_value, standard_value, value FROM ${output.table_name} WHERE activity_id = 240`,
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
