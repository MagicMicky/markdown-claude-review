import { parseHeadings, sectionRange } from './anchor.js';

/**
 * Just enough of a document to judge a passage in place, without re-reading the
 * whole file on every review round.
 */

/** Below this, reading the whole document costs little enough to just do it. */
export const SHORT_DOCUMENT_LINES = 400;

/** Section bodies past this get truncated; at that size, go read the file. */
export const MAX_SECTION_LINES = 200;

const MAX_OUTLINE_ENTRIES = 80;

export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

export function countLines(text: string): number {
  if (text === '') return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') n++;
  return text.endsWith('\n') ? n - 1 : n;
}

export interface OutlineEntry {
  line: number;
  heading: string;
}

/**
 * The heading tree with line numbers. A few dozen lines that say what else the
 * document contains, so Claude can decide whether it needs to read more.
 */
export function documentOutline(text: string): OutlineEntry[] {
  const headings = parseHeadings(text);
  const entries = headings.slice(0, MAX_OUTLINE_ENTRIES).map((h) => ({
    line: lineAt(text, h.start),
    heading: `${'#'.repeat(h.level)} ${h.title}`,
  }));
  if (headings.length > MAX_OUTLINE_ENTRIES) {
    entries.push({ line: 0, heading: `… ${headings.length - MAX_OUTLINE_ENTRIES} more headings` });
  }
  return entries;
}

export function sizeHint(lines: number): string {
  return lines <= SHORT_DOCUMENT_LINES
    ? `short (${lines} lines) — read the whole document before your first edit to it`
    : `long (${lines} lines) — the section context provided may be enough; read further only where your change touches other parts`;
}

/**
 * The section a commented passage sits in, heading line included.
 *
 * This is the point of the whole module: a paragraph judged in isolation gets
 * edited into something that contradicts its neighbours or repeats them, and
 * re-reading the entire document for every comment is the expensive way to
 * avoid that.
 */
export function sectionText(text: string, headingPath: string[]): string | undefined {
  const range = sectionRange(text, headingPath);
  if (!range) return undefined;
  const body = text.slice(range.headingStart, range.end).replace(/\s+$/, '');
  if (!body.trim()) return undefined;

  const lines = body.split('\n');
  if (lines.length <= MAX_SECTION_LINES) return body;
  return (
    lines.slice(0, MAX_SECTION_LINES).join('\n') +
    `\n\n… section truncated after ${MAX_SECTION_LINES} lines; read the file for the rest.`
  );
}
