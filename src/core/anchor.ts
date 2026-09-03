import type { Anchor, ResolvedAnchor } from './types.js';

export const CONTEXT_CHARS = 48;

/* ------------------------------------------------------------------ *
 * Document structure
 * ------------------------------------------------------------------ */

export interface Heading {
  level: number;
  title: string;
  /** Offset of the '#' that starts the heading line. */
  start: number;
  /** Offset just past the heading line's newline. */
  bodyStart: number;
}

/**
 * Offsets of fenced code regions, so headings and block splits inside a fence
 * are not mistaken for structure.
 */
function fenceRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = /^([ \t]*)(`{3,}|~{3,})[^\n]*$/gm;
  let open: { idx: number; marker: string } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const marker = m[2][0];
    if (!open) {
      open = { idx: m.index, marker };
    } else if (m[2][0] === open.marker) {
      out.push([open.idx, m.index + m[0].length]);
      open = null;
    }
  }
  if (open) out.push([open.idx, text.length]);
  return out;
}

function inRanges(ranges: Array<[number, number]>, idx: number): boolean {
  for (const [a, b] of ranges) if (idx >= a && idx < b) return true;
  return false;
}

export function parseHeadings(text: string): Heading[] {
  const fences = fenceRanges(text);
  const out: Heading[] = [];
  const re = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (inRanges(fences, m.index)) continue;
    out.push({
      level: m[1].length,
      title: m[2].trim(),
      start: m.index,
      bodyStart: Math.min(text.length, m.index + m[0].length + 1),
    });
  }
  return out;
}

/** Heading trail containing `offset`, outermost first. */
export function headingPathAt(text: string, offset: number): string[] {
  const stack: Heading[] = [];
  for (const h of parseHeadings(text)) {
    if (h.start >= offset) break;
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    stack.push(h);
  }
  return stack.map((h) => h.title);
}

/**
 * Character range of the section named by `path`, body included, ending at the
 * next heading of the same or higher rank. Returns null when the trail no
 * longer exists (Claude renamed or deleted the section).
 */
export interface SectionRange {
  /** Start of the section body, just past the heading line. */
  start: number;
  end: number;
  /** Start of the heading line itself, for quoting the section with its title. */
  headingStart: number;
  level: number;
}

export function sectionRange(text: string, path: string[]): SectionRange | null {
  if (path.length === 0) return null;
  const headings = parseHeadings(text);
  const target = norm(path[path.length - 1]);

  let best: { idx: number; depth: number } | null = null;
  const stack: Heading[] = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    stack.push(h);
    if (norm(h.title) !== target) continue;
    // Prefer the candidate whose ancestor trail overlaps `path` the most.
    const trail = stack.map((x) => norm(x.title));
    let depth = 0;
    for (const p of path.map(norm)) if (trail.includes(p)) depth++;
    if (!best || depth > best.depth) best = { idx: i, depth };
  }
  if (!best) return null;

  const h = headings[best.idx];
  let end = text.length;
  for (let i = best.idx + 1; i < headings.length; i++) {
    if (headings[i].level <= h.level) {
      end = headings[i].start;
      break;
    }
  }
  return { start: h.bodyStart, end, headingStart: h.start, level: h.level };
}

/* ------------------------------------------------------------------ *
 * Similarity
 * ------------------------------------------------------------------ */

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function trigrams(s: string): Map<string, number> {
  const t = `  ${norm(s)}  `;
  const m = new Map<string, number>();
  for (let i = 0; i + 3 <= t.length; i++) {
    const g = t.slice(i, i + 3);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice over character trigrams. Cheap, and forgiving of edits. */
export function similarity(a: string, b: string): number {
  if (!a.trim() || !b.trim()) return 0;
  if (norm(a) === norm(b)) return 1;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  let sizeA = 0;
  let sizeB = 0;
  for (const n of ta.values()) sizeA += n;
  for (const [g, n] of tb) {
    sizeB += n;
    const inA = ta.get(g);
    if (inA) shared += Math.min(inA, n);
  }
  if (sizeA + sizeB === 0) return 0;
  return (2 * shared) / (sizeA + sizeB);
}

/* ------------------------------------------------------------------ *
 * Blocks
 * ------------------------------------------------------------------ */

export interface Block {
  start: number;
  end: number;
  text: string;
}

/** Split into paragraph-ish blocks, keeping fenced code together. */
export function splitBlocks(text: string, from = 0, to = text.length): Block[] {
  const slice = text.slice(from, to);
  const fences = fenceRanges(slice);
  const blocks: Block[] = [];
  let cursor = 0;
  const re = /\n[ \t]*\n/g;
  let m: RegExpExecArray | null;
  const push = (s: number, e: number) => {
    const raw = slice.slice(s, e);
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    if (raw.trim()) blocks.push({ start: from + s + lead, end: from + e - trail, text: raw.trim() });
  };
  while ((m = re.exec(slice))) {
    if (inRanges(fences, m.index)) continue;
    push(cursor, m.index);
    cursor = m.index + m[0].length;
  }
  push(cursor, slice.length);
  return blocks;
}

/* ------------------------------------------------------------------ *
 * Building and resolving anchors
 * ------------------------------------------------------------------ */

export function buildAnchor(text: string, start: number, end: number): Anchor {
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: text.slice(end, Math.min(text.length, end + CONTEXT_CHARS)),
    headingPath: headingPathAt(text, start),
  };
}

function allOccurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = text.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = text.indexOf(needle, i + 1);
  }
  return out;
}

/** Length of the common suffix of two strings. */
function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Length of the common prefix of two strings. */
function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

export interface ResolveOptions {
  /** Minimum Dice similarity for a fuzzy re-attach. Below this: stale. */
  threshold?: number;
}

/**
 * Locate `anchor` in `text`.
 *
 * Cascade, most trustworthy first:
 *   1. exact quote, unique                      -> exact
 *   2. exact quote, ambiguous, best context     -> exact
 *   3. fuzzy paragraph match inside the section -> drifted
 *   4. fuzzy paragraph match document-wide      -> drifted
 *   5. nothing above threshold                  -> null (caller marks stale)
 *
 * Returns null rather than guessing: a comment pointing at the wrong paragraph
 * is worse than one that admits it lost its place.
 */
export function resolveAnchor(
  text: string,
  anchor: Anchor,
  opts: ResolveOptions = {},
): ResolvedAnchor | null {
  const threshold = opts.threshold ?? 0.62;
  const quote = anchor.quote;
  if (!quote) return null;

  // 1 & 2 — exact.
  const hits = allOccurrences(text, quote);
  if (hits.length === 1) {
    return { start: hits[0], end: hits[0] + quote.length, kind: 'exact', score: 1 };
  }
  if (hits.length > 1) {
    let bestIdx = hits[0];
    let bestScore = -1;
    for (const h of hits) {
      const before = text.slice(Math.max(0, h - CONTEXT_CHARS), h);
      const after = text.slice(h + quote.length, h + quote.length + CONTEXT_CHARS);
      const score = commonSuffix(before, anchor.prefix) + commonPrefix(after, anchor.suffix);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = h;
      }
    }
    return { start: bestIdx, end: bestIdx + quote.length, kind: 'exact', score: 1 };
  }

  // Fuzzy matching on a handful of characters is noise, not signal.
  if (quote.trim().length < 8) return null;

  // 3 — scoped to the section the comment was made in.
  const section = sectionRange(text, anchor.headingPath);
  if (section) {
    const hit = bestBlockRun(text, quote, section.start, section.end, threshold);
    if (hit) return hit;
  }

  // 4 — whole document, with a stricter bar since we lost the section context.
  return bestBlockRun(text, quote, 0, text.length, Math.max(threshold, 0.72));
}

/**
 * Best-scoring run of consecutive blocks. Runs (not just single blocks) so a
 * quote spanning a paragraph break can still find its home.
 */
function bestBlockRun(
  text: string,
  quote: string,
  from: number,
  to: number,
  threshold: number,
): ResolvedAnchor | null {
  const blocks = splitBlocks(text, from, to);
  if (blocks.length === 0) return null;

  const quoteBlocks = splitBlocks(quote).length || 1;
  const minLen = Math.max(1, quoteBlocks - 1);
  const maxLen = Math.min(blocks.length, quoteBlocks + 1);

  let best: ResolvedAnchor | null = null;
  for (let len = minLen; len <= maxLen; len++) {
    for (let i = 0; i + len <= blocks.length; i++) {
      const run = blocks.slice(i, i + len);
      const candidate = text.slice(run[0].start, run[run.length - 1].end);
      const score = similarity(quote, candidate);
      if (score >= threshold && (!best || score > best.score)) {
        best = { start: run[0].start, end: run[run.length - 1].end, kind: 'drifted', score };
      }
    }
  }
  return best;
}
