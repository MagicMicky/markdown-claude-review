/**
 * Line and offset helpers for the renderer.
 *
 * This module used to contain a hand-written markdown stripper that guessed
 * which characters the renderer would treat as markup, so a rendered selection
 * could be matched back to source text. The guess disagreed with markdown-it on
 * tables, fenced code, HTML entities, raw HTML, task lists and `snake_case`
 * identifiers — and disagreeing meant the passage was simply never highlighted.
 *
 * The renderer now emits the source offsets of every run of text directly
 * (`src/extension/markdown.ts`), so nothing has to reconstruct them. What is
 * left is arithmetic.
 */

/** Character offsets of every line start, so line numbers become offsets. */
export function lineOffsets(source: string): number[] {
  const offsets = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') offsets.push(i + 1);
  return offsets;
}

/** A rendered block's extent in the source, from markdown-it's `token.map`. */
export interface BlockRange {
  /** 0-based, inclusive — the `data-line` value on the rendered element. */
  startLine: number;
  /** 0-based, exclusive. */
  endLine: number;
  /** Character offsets of the same span. */
  start: number;
  end: number;
}

/**
 * Resolve a markdown-it `token.map` pair to a character range.
 *
 * Pass `offsets` when converting many blocks of one document: computing them
 * per block is O(blocks x document length), which took 12 seconds on a 600 KB
 * file — synchronously, on the extension host's main thread.
 */
export function blockRange(
  source: string,
  startLine: number,
  endLine: number,
  offsets: readonly number[] = lineOffsets(source),
): BlockRange {
  const start = offsets[Math.min(startLine, offsets.length - 1)] ?? 0;
  const end = endLine < offsets.length ? offsets[endLine] : source.length;
  return { startLine, endLine, start, end };
}
