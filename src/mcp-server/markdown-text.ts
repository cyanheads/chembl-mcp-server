/**
 * @fileoverview The escape every upstream string passes through on its way into
 * the Markdown a tool's `format()` writes, so a CommonMark reader of `content[]`
 * sees the text ChEMBL recorded rather than markup made from it. Without it,
 * `[125I](R)-DOI` in an assay description renders as a link to `R`, `*a*` as
 * emphasis, and `<br>` as an HTML tag.
 *
 * The escape is lossless: a CommonMark parse of the escaped value yields the
 * value exactly, so `content[]` and `structuredContent` agree on every character.
 * It is applied in `format()` only, never to the value itself, so
 * `structuredContent` keeps ChEMBL's text as recorded.
 *
 * Two entry points, because one class of construct depends on where the value
 * sits rather than on what it contains: {@link mdInline} for a value inside a
 * line, {@link mdLineStart} for one that begins a line — at column zero or right
 * after a list marker — where a leading `#`, `>`, `-`, or `1.` opens a block.
 * @module mcp-server/markdown-text
 */

/**
 * The ASCII punctuation CommonMark lets a backslash escape. A backslash before
 * any other character is already literal and is left alone.
 */
const ASCII_PUNCTUATION = String.raw`!-\/:-@\[-\x60{-~`;

/**
 * Every character a CommonMark reader would take as markup rather than as
 * itself, and only where it would. Each alternative is one character plus a
 * lookaround whose scan is bounded or stops at the next `<`, so matching costs
 * linear time however the value is shaped.
 */
const INLINE_MARKUP = new RegExp(
  [
    /**
     * A backslash in front of what it would escape — punctuation, a line break
     * (a hard break), or the end of the value, since the server's own text that
     * follows (`)`, `|`) is often punctuation. Its own escape makes it a pair
     * with the backslash it precedes, so `[x\](y)` cannot become a live link.
     */
    String.raw`\\(?=[${ASCII_PUNCTUATION}\r\n]|$)`,
    /** Emphasis and code-span markers: `*` opens emphasis even between two letters. */
    '[*`]',
    /**
     * `_` wherever it could delimit emphasis, which is everywhere except between
     * two letters or digits, so identifiers such as `MONDO_0005148` stay as written.
     */
    String.raw`(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])`,
    /**
     * `<` that could open raw HTML, a comment or declaration, a URI autolink, or
     * an email autolink (`<a@b.c>`, the only one that can begin with a digit or
     * symbol). The email scan stops at the next `<`, so a run of brackets costs
     * one step each, and `< 10 nM` or `<=` stay as written.
     */
    String.raw`<(?=[A-Za-z/!?]|[^\s<>@]*@)`,
    /** `&` only where it heads a character reference a reader would decode. */
    '&(?=(?:[A-Za-z][A-Za-z0-9]{0,31}|#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6});)',
    /**
     * `]` before the `(` that completes an inline link or image, or the `:` that
     * makes a link reference definition. The `[` that opens one is far more often
     * an isotope label (`[125I]`, `[3H]`) and needs nothing.
     */
    String.raw`\](?=[(:])`,
    /**
     * A line break. Any one of them would let the next line open a heading, a
     * list item, or a quote, so each is written as a numeric character reference,
     * which a reader decodes back to the same character inside the line.
     */
    String.raw`\r\n?|\n`,
  ].join('|'),
  'gu',
);

/** The character references a line break is written as. */
const LINE_BREAKS: Readonly<Record<string, string>> = {
  '\n': '&#10;',
  '\r': '&#13;',
  '\r\n': '&#13;&#10;',
};

/**
 * Escape an upstream string for a position inside a Markdown line.
 *
 * Precondition, met by every call site: the server's text directly after the
 * value never opens a link (`(`) or a definition (`:`), so a `]` closing the
 * value needs no escape. Values arrive trimmed from the service, so leading and
 * trailing whitespace, which a reader drops at a line's edges, is outside the
 * guarantee.
 */
export function mdInline(value: string): string {
  return value.replace(INLINE_MARKUP, (markup) => LINE_BREAKS[markup] ?? `\\${markup}`);
}

/**
 * The blocks a value can open when it begins a line, each as the construct's own
 * opening condition rather than its bare marker, so `-Log Ki`, `2.5-fold`, and
 * `#5` stay as written. The end of the value counts as the space a marker needs,
 * since the server's text after it usually starts with one. Matched against the
 * {@link mdInline} output, where `*`, `_`, a backtick, and a tag-shaped `<` are
 * already escaped and no line break remains.
 */
const BLOCK_OPENER = new RegExp(
  `^(?:${[
    /** An ATX heading: one to six `#`, then a space, a tab, or the end. */
    String.raw`#{1,6}(?=[ \t]|$)`,
    /** A block quote opens on the `>` alone. */
    '>',
    /** A bullet list item, or the first marker of a `- - -` thematic break. */
    String.raw`[-+](?=[ \t]|$)`,
    /** An ordered list item: up to nine digits, then `.` or `)`. */
    String.raw`\d{1,9}[.)](?=[ \t]|$)`,
    /** A setext heading underline or `---` thematic break: the line is nothing else. */
    '[-=]+$',
    /** A tilde code fence. */
    '~{3}',
  ].join('|')})`,
);

/**
 * Escape an upstream string for a position that begins a Markdown line: column
 * zero, or the content right after a list marker, where a block can open too.
 *
 * The escape lands on the marker's last character — the `.` or `)` of an
 * ordered-list marker, since `\1` is not an escape and would show its backslash.
 */
export function mdLineStart(value: string): string {
  return mdInline(value).replace(
    BLOCK_OPENER,
    (opener) => `${opener.slice(0, -1)}\\${opener.slice(-1)}`,
  );
}
