/**
 * @fileoverview Tests for the shared input-edge normalization (#41): the ChEMBL
 * ID and assay_type patterns the input schemas advertise (every raw form a
 * handler maps is admitted, nothing else is, and each stays linear on
 * adversarial input), the molecule-reference and assay_type mappings, and the
 * limit clamp.
 * @module tests/mcp-server/input-normalization
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  ASSAY_TYPE_INPUT,
  assayTypeInput,
  CHEMBL_ID_INPUT,
  chemblIdInput,
  clampLimit,
  normalizeMoleculeRef,
  OPTIONAL_CHEMBL_ID_INPUT,
  optionalChemblIdInput,
  optionalCodeInput,
} from '@/mcp-server/input-normalization.js';

const CHEMBL_ID_FORMS = ['CHEMBL941', 'chembl941', 'ChEmBl941', '  CHEMBL941  ', '\tchembl941\n'];
const NOT_CHEMBL_IDS = [
  'imatinib',
  'CHEMBL',
  'CHEMBL941x',
  'CHEMBL 941',
  'KTUFNOKKBVMGRW-UHFFFAOYSA-N',
  'P00533',
];

describe('ChEMBL ID patterns', () => {
  it('admit a ChEMBL ID in any case with surrounding whitespace', () => {
    for (const raw of CHEMBL_ID_FORMS) {
      expect(CHEMBL_ID_INPUT.test(raw), raw).toBe(true);
      expect(OPTIONAL_CHEMBL_ID_INPUT.test(raw), raw).toBe(true);
    }
  });

  it('refuse anything that is not a ChEMBL ID', () => {
    for (const raw of NOT_CHEMBL_IDS) {
      expect(CHEMBL_ID_INPUT.test(raw), raw).toBe(false);
      expect(OPTIONAL_CHEMBL_ID_INPUT.test(raw), raw).toBe(false);
    }
  });

  it('admit a blank only on the optional form', () => {
    for (const blank of ['', '   ', '\r\n']) {
      expect(CHEMBL_ID_INPUT.test(blank)).toBe(false);
      expect(OPTIONAL_CHEMBL_ID_INPUT.test(blank)).toBe(true);
    }
  });

  it('parse to the canonical ID, a blank optional value to unset', () => {
    const required = chemblIdInput('Must be a ChEMBL ID.');
    const optional = z.object({ id: optionalChemblIdInput('Must be a ChEMBL ID.') });
    for (const raw of CHEMBL_ID_FORMS) {
      expect(required.parse(raw)).toBe('CHEMBL941');
      expect(optional.parse({ id: raw })).toEqual({ id: 'CHEMBL941' });
    }
    expect(optional.parse({ id: '' }).id).toBeUndefined();
    expect(optional.parse({ id: '   ' }).id).toBeUndefined();
    expect(optional.parse({}).id).toBeUndefined();
    expect(required.safeParse('imatinib').error?.issues[0]?.message).toBe('Must be a ChEMBL ID.');
    expect(optional.safeParse({ id: 'imatinib' }).success).toBe(false);
  });
});

describe('assay_type', () => {
  const MAPPINGS: Array<[string, string]> = [
    ['B', 'B'],
    [' B ', 'B'],
    ['b', 'B'],
    ['binding', 'B'],
    ['Binding', 'B'],
    ['F', 'F'],
    ['functional', 'F'],
    ['a', 'A'],
    ['ADME', 'A'],
    ['admet', 'A'],
    ['T', 'T'],
    ['Toxicity', 'T'],
    ['p', 'P'],
    ['PHYSICOCHEMICAL', 'P'],
    ['U', 'U'],
    ['Unassigned', 'U'],
    ['unclassified', 'U'],
  ];
  const REFUSED = ['X', 'BF', 'B F', 'bind', 'ADMETX', 'binding assay'];
  const schema = z.object({ assay_type: assayTypeInput });

  it('maps a code or ChEMBL name in any case to the code', () => {
    for (const [raw, code] of MAPPINGS) {
      expect(ASSAY_TYPE_INPUT.test(raw), raw).toBe(true);
      expect(schema.parse({ assay_type: raw }), raw).toEqual({ assay_type: code });
    }
  });

  it('refuses every other value, at the advertised pattern and the parse alike', () => {
    for (const raw of REFUSED) {
      expect(ASSAY_TYPE_INPUT.test(raw), raw).toBe(false);
      expect(schema.safeParse({ assay_type: raw }).success, raw).toBe(false);
    }
  });

  it('reads a blank as unset', () => {
    for (const blank of ['', '  ']) {
      expect(ASSAY_TYPE_INPUT.test(blank)).toBe(true);
      expect(schema.parse({ assay_type: blank }).assay_type).toBeUndefined();
    }
  });
});

describe('optionalCodeInput', () => {
  it('trims and uppercases, a blank to unset', () => {
    const schema = z.object({ code: optionalCodeInput });
    expect(schema.parse({ code: ' p00533 ' })).toEqual({ code: 'P00533' });
    expect(schema.parse({ code: 'single protein' })).toEqual({ code: 'SINGLE PROTEIN' });
    expect(schema.parse({ code: '  ' }).code).toBeUndefined();
  });
});

describe('normalizeMoleculeRef', () => {
  it.each([
    ['chembl941', 'CHEMBL941'],
    ['  CHEMBL941 ', 'CHEMBL941'],
    [' ktufnokkbvmgrw-uhfffaoysa-n ', 'KTUFNOKKBVMGRW-UHFFFAOYSA-N'],
    ['KTUFNOKKBVMGRW-UHFFFAOYSA-N', 'KTUFNOKKBVMGRW-UHFFFAOYSA-N'],
    // Anything else is passed through trimmed only: case carries meaning in a structure.
    [' CC(=O)Oc1ccccc1C(=O)O ', 'CC(=O)Oc1ccccc1C(=O)O'],
    ['c1ccccc1', 'c1ccccc1'],
    ['imatinib', 'imatinib'],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeMoleculeRef(raw)).toBe(expected);
  });
});

describe('clampLimit', () => {
  it('serves a limit above the cap at the cap, with a notice naming both values', () => {
    expect(clampLimit(101, 100)).toEqual({
      limit: 100,
      notice: 'limit 101 is above the maximum of 100, so 100 was applied.',
    });
  });

  it('leaves a limit at or below the cap alone, with no notice', () => {
    expect(clampLimit(100, 100)).toEqual({ limit: 100, notice: undefined });
    expect(clampLimit(1, 1000)).toEqual({ limit: 1, notice: undefined });
  });
});

/**
 * Each row drives one quantifier of its pattern to the end of a long run and then
 * fails, so the engine backtracks across the run: the `\d+` of an ID, the leading
 * `\s*`, or the trailing `\s*` after an ID or a code. The anchored patterns reject
 * an input whose first character they cannot start on in constant time, where no
 * bound could fail, so every shape opens with what its pattern accepts. Each run
 * doubles from 5k to 320k characters; a quadratic quantifier passes 100 ms of
 * thread CPU by 40k, and a linear one keeps the full-span ratio near 64, under 256.
 */
describe('pattern timing', () => {
  /** Thread CPU milliseconds for one `pattern.test(input)`, best of three. */
  function cpuMs(pattern: RegExp, input: string): number {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const before = process.threadCpuUsage();
      pattern.test(input);
      const spent = process.threadCpuUsage(before);
      best = Math.min(best, (spent.user + spent.system) / 1000);
    }
    return best;
  }

  /** Runs that reach a ChEMBL ID pattern's `\d+` and both of its `\s*`. */
  const ID_SHAPES: Array<[string, (n: number) => string]> = [
    ['a digit run that fails at its end', (n) => `chembl${'1'.repeat(n)}x`],
    ['breaks throughout before a stray character', (n) => `${'  \r\n'.repeat(n / 4)}x`],
    ['padding around an ID', (n) => `${' '.repeat(n / 2)}chembl1${' '.repeat(n / 2)}x`],
    ['line breaks after an ID', (n) => `chembl1${'\r\n'.repeat(n / 2)}x`],
  ];
  /** Runs that reach the assay_type pattern's `\s*` on either side of a code. */
  const ASSAY_TYPE_SHAPES: Array<[string, (n: number) => string]> = [
    ['breaks throughout before a stray character', (n) => `${'  \r\n'.repeat(n / 4)}x`],
    ['padding around a code', (n) => `${' '.repeat(n / 2)}binding${' '.repeat(n / 2)}x`],
    ['line breaks after a code', (n) => `b${'\r\n'.repeat(n / 2)}x`],
  ];
  const ROWS = [
    ...ID_SHAPES.map(([shape, build]) => ['CHEMBL_ID_INPUT', shape, CHEMBL_ID_INPUT, build]),
    ...ID_SHAPES.map(([shape, build]) => [
      'OPTIONAL_CHEMBL_ID_INPUT',
      shape,
      OPTIONAL_CHEMBL_ID_INPUT,
      build,
    ]),
    ...ASSAY_TYPE_SHAPES.map(([shape, build]) => [
      'ASSAY_TYPE_INPUT',
      shape,
      ASSAY_TYPE_INPUT,
      build,
    ]),
  ] as Array<[string, string, RegExp, (n: number) => string]>;

  it.each(ROWS)('%s stays linear over %s', (_name, _shape, pattern, build) => {
    const times: number[] = [];
    for (let n = 5_000; n <= 320_000; n *= 2) {
      const ms = cpuMs(pattern, build(n));
      expect(ms).toBeLessThan(100);
      times.push(ms);
    }
    expect((times.at(-1) ?? 0) / Math.max(times[0] ?? 0, 0.05)).toBeLessThan(256);
  });
});
