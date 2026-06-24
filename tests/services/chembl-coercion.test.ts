/**
 * @fileoverview Tests for the ChEMBL numeric coercion boundary — the
 * scientific-data fidelity rule. Upstream ships numbers as JSON strings; a
 * missing/non-numeric value must coerce to null, never 0.
 * @module tests/services/chembl-coercion
 */

import { describe, expect, it } from 'vitest';
import { toNumberOrNull } from '@/services/chembl/chembl-service.js';

describe('toNumberOrNull', () => {
  it('parses a numeric string to a number', () => {
    expect(toNumberOrNull('180.16')).toBe(180.16);
    expect(toNumberOrNull('4.0')).toBe(4);
    expect(toNumberOrNull('7.39')).toBe(7.39);
  });

  it('passes a real number through', () => {
    expect(toNumberOrNull(1950)).toBe(1950);
    expect(toNumberOrNull(0)).toBe(0);
  });

  it('coerces absent/empty to null, never 0', () => {
    expect(toNumberOrNull(null)).toBeNull();
    expect(toNumberOrNull(undefined)).toBeNull();
    expect(toNumberOrNull('')).toBeNull();
    expect(toNumberOrNull('   ')).toBeNull();
  });

  it('coerces non-numeric strings to null', () => {
    expect(toNumberOrNull('N/A')).toBeNull();
    expect(toNumberOrNull('not reported')).toBeNull();
  });

  it('rejects non-finite numbers', () => {
    expect(toNumberOrNull(Number.NaN)).toBeNull();
    expect(toNumberOrNull(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('does not coerce object/array shapes to a number', () => {
    expect(toNumberOrNull({})).toBeNull();
    expect(toNumberOrNull([1])).toBeNull();
  });
});
