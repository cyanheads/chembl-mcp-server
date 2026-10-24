/**
 * @fileoverview Reference CommonMark parse for `content[]` round-trip assertions:
 * the text a reader sees, and every node type the parse built, so a test can
 * assert that no link, emphasis, heading, list, or HTML formed from a value.
 * @module tests/_commonmark
 */

import { type NodeType, Parser } from 'commonmark';

const parser = new Parser();

/** Blocks whose end separates the visible text of what follows with a line break. */
const BLOCKS = new Set<NodeType>([
  'paragraph',
  'heading',
  'code_block',
  'html_block',
  'item',
  'block_quote',
]);

/**
 * Parse Markdown with the CommonMark reference implementation. `text` is the
 * visible text — text, code, and HTML literals in order, soft and hard breaks as
 * `\n`, blocks separated by `\n`, strong and emphasis markers dropped with their
 * content kept. `nodes` lists the distinct node types entered.
 */
export function parseMarkdown(markdown: string): { text: string; nodes: Set<NodeType> } {
  const walker = parser.parse(markdown).walker();
  const nodes = new Set<NodeType>();
  let text = '';
  for (let event = walker.next(); event; event = walker.next()) {
    const { node, entering } = event;
    if (!entering) {
      if (BLOCKS.has(node.type) && !text.endsWith('\n')) text += '\n';
      continue;
    }
    nodes.add(node.type);
    if (node.type === 'softbreak' || node.type === 'linebreak') text += '\n';
    else if (node.literal !== null) text += node.literal;
  }
  return { text: text.replace(/\n+$/, ''), nodes };
}

/** The literal of every inline code span, in document order. */
export function codeSpans(markdown: string): string[] {
  const walker = parser.parse(markdown).walker();
  const spans: string[] = [];
  for (let event = walker.next(); event; event = walker.next()) {
    if (event.entering && event.node.type === 'code') spans.push(event.node.literal ?? '');
  }
  return spans;
}

/** Node types a value rendered inert can produce: none beyond plain text. */
const MARKUP = new Set<NodeType>([
  'emph',
  'link',
  'image',
  'html_inline',
  'html_block',
  'heading',
  'block_quote',
  'code_block',
  'thematic_break',
  'linebreak',
]);

/** The node types in `nodes` that only markup builds — empty when every value stayed text. */
export function markupNodes(nodes: Set<NodeType>): NodeType[] {
  return [...nodes].filter((type) => MARKUP.has(type));
}
