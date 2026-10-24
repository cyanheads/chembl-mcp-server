/**
 * @fileoverview Input-edge normalization shared by the tool and resource
 * definitions: ChEMBL IDs, molecule references, the assay_type code, upper-case
 * codes (UniProt accessions, target types), and the limit clamp. ChEMBL's
 * by-resource lookups match a ChEMBL ID in any case, but its list filters match
 * exactly, so each value is brought to the form ChEMBL records before any request.
 * JSON Schema `pattern` takes no flags, so every pattern a schema advertises spells
 * out the case and whitespace variants the parse maps — a schema-validating client
 * refuses none of them.
 * @module mcp-server/input-normalization
 */

import { z } from '@cyanheads/mcp-ts-core';

/** A ChEMBL ID in any case, padded with whitespace: what a required ID input admits. */
export const CHEMBL_ID_INPUT = /^\s*[Cc][Hh][Ee][Mm][Bb][Ll]\d+\s*$/;

/** {@link CHEMBL_ID_INPUT} for an optional input, which also admits a blank (read as unset). */
export const OPTIONAL_CHEMBL_ID_INPUT = /^\s*(?:[Cc][Hh][Ee][Mm][Bb][Ll]\d+\s*)?$/;

const CHEMBL_ID = /^CHEMBL\d+$/;
const INCHI_KEY = /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/;

/** Whether a normalized value is a ChEMBL ID — the only form a list filter on one matches. */
export function isChemblId(value: string): boolean {
  return CHEMBL_ID.test(value);
}

/** Trim and uppercase a string, a blank to `undefined`; anything else passes to the schema as sent. */
function upperOrUnset(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() || undefined : value;
}

/** A required ChEMBL ID input, parsed to the canonical ID; `message` is the rejection text. */
export function chemblIdInput(message: string) {
  return z.preprocess(
    (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
    z.string().regex(CHEMBL_ID_INPUT, message),
  );
}

/** An optional ChEMBL ID input, parsed to the canonical ID; a blank reads as unset. */
export function optionalChemblIdInput(message: string) {
  return z.preprocess(upperOrUnset, z.string().regex(OPTIONAL_CHEMBL_ID_INPUT, message).optional());
}

/** An optional code ChEMBL records only in uppercase (a UniProt accession, a target type). */
export const optionalCodeInput = z.preprocess(upperOrUnset, z.string().optional());

/**
 * Normalize a molecule reference for a `/molecule/{ref}` lookup: trimmed, and
 * uppercased when it is a ChEMBL ID or a standard InChIKey in any case — the lookup
 * matches a ChEMBL ID in any case but an InChIKey only in uppercase. Anything else
 * passes through trimmed only, since case carries meaning in a structure string.
 */
export function normalizeMoleculeRef(raw: string): string {
  const value = raw.trim();
  const upper = value.toUpperCase();
  return CHEMBL_ID.test(upper) || INCHI_KEY.test(upper) ? upper : value;
}

/** A required molecule reference input, normalized by {@link normalizeMoleculeRef}; a blank fails. */
export const moleculeRefInput = z.preprocess(
  (value) => (typeof value === 'string' ? normalizeMoleculeRef(value) : value),
  z.string().min(1),
);

/** An optional molecule reference input, normalized by {@link normalizeMoleculeRef}; a blank reads as unset. */
export const optionalMoleculeRefInput = z.preprocess(
  (value) => (typeof value === 'string' ? normalizeMoleculeRef(value) || undefined : value),
  z.string().optional(),
);

/**
 * ChEMBL's assay type codes, keyed by every spelling the assay_type input maps:
 * the code itself and ChEMBL's name for it (`assay_type_description`, plus the
 * ADMET and Unclassified forms of two). No other code exists upstream.
 */
const ASSAY_TYPE_CODES = new Map([
  ['B', 'B'],
  ['BINDING', 'B'],
  ['F', 'F'],
  ['FUNCTIONAL', 'F'],
  ['A', 'A'],
  ['ADME', 'A'],
  ['ADMET', 'A'],
  ['T', 'T'],
  ['TOXICITY', 'T'],
  ['P', 'P'],
  ['PHYSICOCHEMICAL', 'P'],
  ['U', 'U'],
  ['UNASSIGNED', 'U'],
  ['UNCLASSIFIED', 'U'],
]);

/** Spell an uppercase word case-insensitively for a flagless pattern: `ADME` → `[Aa][Dd][Mm][Ee]`. */
const anyCase = (word: string) => word.replace(/[A-Z]/g, (c) => `[${c}${c.toLowerCase()}]`);

/** Every {@link ASSAY_TYPE_CODES} spelling in any case, padded with whitespace, or a blank. */
export const ASSAY_TYPE_INPUT = new RegExp(
  `^\\s*(?:(?:${[...ASSAY_TYPE_CODES.keys()].map(anyCase).join('|')})\\s*)?$`,
);

/**
 * The optional assay_type input, parsed to its one-letter code; a blank reads as
 * unset. A value the table does not map reaches the pattern unchanged and fails it.
 */
export const assayTypeInput = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const key = value.trim().toUpperCase();
  return key ? (ASSAY_TYPE_CODES.get(key) ?? value) : undefined;
}, z
  .string()
  .regex(
    ASSAY_TYPE_INPUT,
    'Must be an assay type code — B (binding), F (functional), A (ADMET), T (toxicity), P (physicochemical), or U (unassigned) — or its name.',
  )
  .optional());

/** The schema ceiling on every `limit` input: past a tool's own cap, a request clamps up to here. */
export const LIMIT_CEILING = 10_000;

/**
 * Serve a requested page size at the tool's per-call cap. A larger request has
 * one obvious reading, so it is applied at the cap and disclosed rather than
 * rejected; `notice` names both values, and is undefined when nothing was clamped.
 */
export function clampLimit(
  requested: number,
  cap: number,
): { limit: number; notice: string | undefined } {
  return requested > cap
    ? {
        limit: cap,
        notice: `limit ${requested} is above the maximum of ${cap}, so ${cap} was applied.`,
      }
    : { limit: requested, notice: undefined };
}
