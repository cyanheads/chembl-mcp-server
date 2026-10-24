/**
 * @fileoverview Tests for the `format()` escape: every value parses back under
 * CommonMark to exactly the text ChEMBL recorded, in each position a tool places
 * one — inside a line, at the start of a paragraph line, and right after a list
 * marker — and the escape leaves the identifiers, units, and prose that need none
 * exactly as written. Expected text is always the source string spliced into the
 * server's line, never the escaper's own output. Ends with the scaling suite for
 * the two patterns, which run over upstream text of any length.
 * @module tests/mcp-server/markdown-text.test
 */

import { describe, expect, it } from 'vitest';
import { mdInline, mdLineStart } from '@/mcp-server/markdown-text.js';
import { markupNodes, parseMarkdown } from '../_commonmark.js';

/**
 * The positions a `format()` puts an upstream value in: the server text around it,
 * the escape the position takes, and the visible text of the server's own part
 * (its `**` markers are consumed as strong, its `- ` as the list marker).
 */
const POSITIONS = [
  {
    name: 'inside a line',
    escape: mdInline,
    before: 'Type: ',
    after: ' | Organism: x',
    shown: 'Type: ',
  },
  { name: 'inside parentheses', escape: mdInline, before: 'A (', after: ')', shown: 'A (' },
  {
    name: 'at the end of a line',
    escape: mdInline,
    before: 'Organism: ',
    after: '',
    shown: 'Organism: ',
  },
  { name: 'inside bold', escape: mdInline, before: '**', after: '** — x', shown: '' },
  {
    name: 'at the start of a paragraph line',
    escape: mdLineStart,
    before: '**CHEMBL1**\n',
    after: ' | x',
    shown: 'CHEMBL1\n',
  },
  {
    name: 'after a list marker',
    escape: mdLineStart,
    before: '- ',
    after: ' (INHIBITOR)',
    shown: '',
  },
] as const;

/** Renders `value` in `position` and returns what a CommonMark reader sees. */
function readBack(position: (typeof POSITIONS)[number], value: string) {
  return parseMarkdown(`${position.before}${position.escape(value)}${position.after}`);
}

/** The visible text `value` must produce in `position`, built without the escaper. */
function expected(position: (typeof POSITIONS)[number], value: string): string {
  return `${position.shown}${value}${position.after.replaceAll('**', '')}`;
}

/** Values whose raw interpolation renders as markup, each with what it would build. */
const HOSTILE = [
  ['an inline link', 'Affinity in displacing [125I](R)-DOI from rat cortex'],
  ['an image', '![alt](https://x.org/a.png)'],
  ['asterisk emphasis', 'a *mutant* receptor'],
  ['underscore emphasis', 'the _apo_ form'],
  ['strong emphasis', '__bold__ and **bold**'],
  ['an HTML tag', 'Inhibition<br>of uptake'],
  ['an HTML comment', 'x <!-- note --> y'],
  ['a URI autolink', 'see <https://www.ebi.ac.uk/chembl>'],
  ['an email autolink', 'contact <1chembl@ebi.ac.uk>'],
  ['a character reference', 'Taylor &amp; Francis, &#169; 2004, &#x3B1;'],
  ['a code span', 'measured with `HPLC`'],
  ['a backslash before punctuation', String.raw`trans-\[N+](=O)[O-]`],
  ['an escaped bracket closing a link', String.raw`[x\](y)`],
  ['a trailing backslash', 'ends with \\'],
  ['a line break', 'first line\nsecond line'],
  ['a CRLF and a lone CR', 'a\r\nb\rc'],
  ['a line break before a heading', 'intro\n# not a heading'],
  ['a line break before a list item', 'intro\n- not an item\n1. nor this'],
  ['a backslash before a line break', 'hard \\\nbreak'],
  ['a reference definition', '[ref]: https://x.org'],
] as const;

/** Values that open a block when they begin a line. */
const BLOCK_STARTS = [
  ['an ATX heading', '# Assay summary'],
  ['a level-six heading', '###### deep'],
  ['a bare heading marker', '#'],
  ['a block quote', '> quoted text'],
  ['a bullet', '- item'],
  ['a plus bullet', '+ item'],
  ['an ordered item', '1. first'],
  ['a parenthesized ordered item', '12) twelfth'],
  ['a thematic break', '---'],
  ['a spaced thematic break', '- - -'],
  ['a setext underline', '==='],
  ['a tilde fence', '~~~ info'],
  ['an HTML block', '<div>block</div>'],
  ['a starred thematic break', '* * *'],
] as const;

describe('mdInline and mdLineStart round trips', () => {
  for (const position of POSITIONS) {
    describe(position.name, () => {
      it.each(HOSTILE)('reads %s back as the text recorded', (_name, value) => {
        const { text, nodes } = readBack(position, value);
        expect(text).toBe(expected(position, value));
        expect(markupNodes(nodes)).toEqual([]);
      });
    });
  }

  for (const position of POSITIONS.filter((p) => p.escape === mdLineStart)) {
    it.each(BLOCK_STARTS)(`reads %s back as text ${position.name}`, (_name, value) => {
      const { text, nodes } = readBack(position, value);
      expect(text).toBe(expected(position, value));
      expect(markupNodes(nodes)).toEqual([]);
    });
  }

  it('keeps the server markup around a value: bold IDs, list items, and separators', () => {
    const line = `**CHEMBL25** (${mdInline('*ASPIRIN*')}) | ${mdInline('a_b')}`;
    const { text, nodes } = parseMarkdown(`${line}\n- ${mdLineStart('# x')} → target **CHEMBL2**`);
    expect(text).toBe('CHEMBL25 (*ASPIRIN*) | a_b\n# x → target CHEMBL2');
    expect([...nodes]).toEqual(['document', 'paragraph', 'strong', 'text', 'list', 'item']);
  });

  /**
   * A seeded sweep over strings drawn from the characters CommonMark treats as
   * markup, in every position. The expected text is the source spliced into the
   * line, so any escape the patterns miss or overdo shows as a mismatch.
   */
  it('round-trips seeded random markup-dense values in every position', () => {
    const alphabet = [...'ab12 *_`\\[]()<>&#;!-+=~.:@/|é\n\r', 'amp', '#10', 'http:', '](', '<a'];
    let seed = 20_261_024;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
      return seed / 0x7f_ff_ff_ff;
    };
    const mismatches: string[] = [];
    for (let i = 0; i < 4000; i++) {
      let value = '';
      const length = 1 + Math.floor(next() * 14);
      for (let j = 0; j < length; j++) value += alphabet[Math.floor(next() * alphabet.length)];
      // Upstream values arrive trimmed from the service.
      value = value.trim();
      if (!value) continue;
      for (const position of POSITIONS) {
        const { text, nodes } = readBack(position, value);
        if (text !== expected(position, value) || markupNodes(nodes).length > 0) {
          mismatches.push(`${position.name}: ${JSON.stringify(value)}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe('mdInline and mdLineStart leave inert text as written', () => {
  it.each([
    'MONDO_0005148',
    'EFO:0003060',
    'Orphanet_1234',
    'CHEMBL25',
    'IC50',
    '< 10 nM',
    '<=',
    '<<',
    '~',
    'ug.mL-1',
    'C9H8O4',
    'HLA-A',
    '[3H]spiperone binding to D2 receptors',
    'Iodine [125I] (labelled)',
    'R&D, Taylor & Francis',
    'trans-4-hydroxy-L-proline',
    'Carcinoma, Non-Small-Cell Lung',
    '5-HT2A; 50% inhibition at 10 uM',
    'path\\to (a backslash before a letter)',
  ])('%s', (value) => {
    expect(mdInline(value)).toBe(value);
    expect(mdLineStart(value)).toBe(value);
  });

  it.each(['-Log Ki', '2.5-fold', '#5 site', '1.5 mg/kg', '>50 uM', '>=', '+/- 3', '== x', '~~x'])(
    'escapes %s at a line start only where it opens a block',
    (value) => {
      expect(mdInline(value)).toBe(value);
      const opensBlock = ['>50 uM', '>='].includes(value);
      expect(mdLineStart(value) === value).toBe(!opensBlock);
    },
  );

  it('pins the exact escapes for the issue repro values', () => {
    expect(mdInline('[125I](R)-DOI')).toBe(String.raw`[125I\](R)-DOI`);
    expect(mdInline('a *b* _c_')).toBe(String.raw`a \*b\* \_c\_`);
    expect(mdInline('x<br>y &amp;')).toBe(String.raw`x\<br>y \&amp;`);
    expect(mdInline('a\nb')).toBe('a&#10;b');
    expect(mdLineStart('# x')).toBe(String.raw`\# x`);
    expect(mdLineStart('12. x')).toBe(String.raw`12\. x`);
    expect(mdLineStart('---')).toBe(String.raw`--\-`);
  });
});

/**
 * Both patterns run over upstream text of any length — an assay description, a
 * SQL result cell — so each is timed against the shapes that drive one of its
 * lookarounds or scans across a long run: for `mdInline`'s pattern, a repeated
 * opener with no closer, nested openers, overlapping prefixes, and line breaks;
 * for the anchored block-opener `mdLineStart` adds, a `-`/`=` run that is not a
 * whole line, its one unbounded scan. Neither pattern gets a row it could not
 * fail: a run of characters no `mdInline` alternative starts on (digits, `#`,
 * `-`) is skipped in constant steps, and every other block opener is bounded,
 * while `mdLineStart`'s pass over the hostile shapes repeats the `mdInline` rows.
 * Time is the thread's own CPU time, each run doubling from 5k to 320k characters;
 * a quadratic scan passes 100 ms by 40k, and a linear one keeps the full-span
 * ratio near 64, under the 256 bound.
 */
describe('mdInline and mdLineStart scale linearly', () => {
  function cpuMs(run: (input: string) => string, input: string): number {
    let best = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = process.threadCpuUsage();
      run(input);
      const spent = process.threadCpuUsage(before);
      best = Math.min(best, (spent.user + spent.system) / 1000);
    }
    return best;
  }

  const INLINE_SHAPES: Array<[string, (n: number) => string]> = [
    ['a run of backslashes', (n) => '\\'.repeat(n)],
    ['breaks throughout', (n) => '  \r\n'.repeat(n / 4)],
    ['a repeated < with no closer', (n) => '<'.repeat(n)],
    ['nested tag openers', (n) => '<a'.repeat(n / 2)],
    ['one < before a long email-shaped run', (n) => `<${'1'.repeat(n)}`],
    ['repeated email-shaped openers', (n) => '<1.'.repeat(n / 3)],
    ['a repeated & with no terminator', (n) => '&a'.repeat(n / 2)],
    ['numeric reference prefixes', (n) => '&#1'.repeat(n / 3)],
    ['underscores between letters', (n) => 'a_'.repeat(n / 2)],
    ['a run of closing brackets', (n) => '](:'.repeat(n / 3)],
  ];
  const LINE_START_SHAPES: Array<[string, (n: number) => string]> = [
    ['a dash run that is not a whole line', (n) => `${'-'.repeat(n)}x`],
    ['an = run that is not a whole line', (n) => `${'='.repeat(n)}x`],
    ['a mixed -= run that is not a whole line', (n) => `${'-='.repeat(n / 2)}x`],
  ];
  const ROWS = [
    ...INLINE_SHAPES.map(([shape, build]) => ['mdInline', shape, mdInline, build]),
    ...LINE_START_SHAPES.map(([shape, build]) => ['mdLineStart', shape, mdLineStart, build]),
  ] as Array<[string, string, (input: string) => string, (n: number) => string]>;

  it.each(ROWS)('%s stays linear over %s', (_name, _shape, run, build) => {
    const times: number[] = [];
    for (let n = 5_000; n <= 320_000; n *= 2) {
      const ms = cpuMs(run, build(n));
      expect(ms).toBeLessThan(100);
      times.push(ms);
    }
    expect((times.at(-1) ?? 0) / Math.max(times[0] ?? 0, 0.05)).toBeLessThan(256);
  });
});
