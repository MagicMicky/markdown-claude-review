/**
 * Mapping between rendered preview text and markdown source offsets.
 *
 * The preview shows rendered prose; comments must anchor to source characters,
 * because that is what Claude edits and what `resolveAnchor` re-finds later. The
 * renderer only tells us which *block* a selection came from — VS Code's own
 * preview annotates blocks with `data-line` (a 0-based start line) and nothing
 * finer, and we follow that convention. So the last mile, from "this rendered
 * sentence" to "these source characters", happens here.
 *
 * Pure, and free of `node:*` and `vscode` — this is bundled into the webview's
 * sibling code and must stay portable.
 */

/** A rendered block's extent in the source, derived from markdown-it's token.map. */
export interface BlockRange {
  /** 0-based, inclusive — the `data-line` value on the rendered element. */
  startLine: number;
  /** 0-based, exclusive. */
  endLine: number;
  /** Character offsets of the same span. */
  start: number;
  end: number;
}

/** Character offsets of every line start, so line numbers become offsets. */
export function lineOffsets(source: string): number[] {
  const offsets = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') offsets.push(i + 1);
  return offsets;
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

/* ------------------------------------------------------------------ *
 * Stripping inline markdown
 * ------------------------------------------------------------------ */

export interface Stripped {
  /** Source with inline markup removed. */
  text: string;
  /** `map[i]` is the source offset of `text[i]`. Always the same length as text. */
  map: number[];
  /**
   * Source spans of constructs whose delimiters were dropped — links, images,
   * inline code, autolinks. A mapped range that clips one of these is snapped
   * outward to cover it, so an anchor quote never comes back with half a link
   * in it.
   */
  spans: Array<{ start: number; end: number }>;
}

const ESCAPABLE = new Set('\\`*_{}[]()#+-.!>~|'.split(''));

/**
 * Remove inline markdown while recording where every surviving character came
 * from, so a match against the stripped text projects back onto real source
 * positions.
 *
 * Handles what actually appears in prose documents: emphasis and strong,
 * inline code, links and images (label kept, destination dropped), autolinks,
 * backslash escapes, and the leading markers of headings, list items and block
 * quotes. It is deliberately not a markdown parser — anything it fails to strip
 * simply stays in the text, which costs a fuzzy match rather than a wrong one.
 */
export function stripInline(source: string): Stripped {
  const out: string[] = [];
  const map: number[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const push = (ch: string, at: number) => {
    out.push(ch);
    map.push(at);
  };

  // Pair every bracket once, up front. Scanning forward from each `[` for its
  // partner is quadratic when they do not pair up — a paragraph of brackets, an
  // ASCII table, a pasted log — and that ran on every thread push.
  const brackets = bracketPairs(source);
  // Same reasoning for backtick runs that never close.
  const unmatched = new Set<number>();

  let i = 0;
  let atLineStart = true;

  while (i < source.length) {
    const ch = source[i];

    if (atLineStart) {
      // Leading block markers: '> ', '#'+ ' ', '- ', '* ', '1. '.
      const rest = source.slice(i);
      const marker =
        /^[ \t]*(?:>[ \t]?)+/.exec(rest)?.[0] ??
        /^[ \t]*#{1,6}[ \t]+/.exec(rest)?.[0] ??
        /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/.exec(rest)?.[0];
      if (marker) {
        i += marker.length;
        atLineStart = false;
        continue;
      }
      atLineStart = false;
    }

    if (ch === '\n') {
      push('\n', i);
      i++;
      atLineStart = true;
      continue;
    }

    // Backslash escape: the escaped character is literal.
    if (ch === '\\' && i + 1 < source.length && ESCAPABLE.has(source[i + 1])) {
      push(source[i + 1], i + 1);
      i += 2;
      continue;
    }

    // Inline code: keep the contents, drop the backtick fences.
    if (ch === '`' && !unmatched.has(i)) {
      let fence = 0;
      while (source[i + fence] === '`') fence++;
      const close = source.indexOf('`'.repeat(fence), i + fence);
      if (close === -1) for (let k = i; k < i + fence; k++) unmatched.add(k);
      if (close !== -1) {
        for (let k = i + fence; k < close; k++) push(source[k], k);
        spans.push({ start: i, end: close + fence });
        i = close + fence;
        continue;
      }
    }

    // Emphasis / strong markers.
    if (ch === '*' || ch === '_' || ch === '~') {
      i++;
      continue;
    }

    // Image: drop the '!' and fall through to the link handling below. The
    // span starts here so a snap covers the marker too.
    let constructStart = i;
    if (ch === '!' && source[i + 1] === '[') {
      i++;
      constructStart = i - 1;
    }

    // Link: keep the label, drop the destination.
    if (source[i] === '[') {
      const close = brackets.get(i) ?? -1;
      if (close !== -1) {
        const after = source[close + 1];
        if (after === '(' || after === '[') {
          const openTail = after === '(' ? '(' : '[';
          const closeTail = after === '(' ? ')' : ']';
          const tailEnd = matchingPair(source, close + 1, openTail, closeTail);
          if (tailEnd !== -1) {
            for (let k = i + 1; k < close; k++) push(source[k], k);
            spans.push({ start: constructStart, end: tailEnd + 1 });
            i = tailEnd + 1;
            continue;
          }
        }
      }
      i++;
      continue;
    }
    if (ch === ']') {
      i++;
      continue;
    }

    // Autolink <https://…> — keep the target text, drop the angle brackets.
    if (ch === '<') {
      const close = source.indexOf('>', i);
      if (close !== -1 && /^<[a-z][a-z0-9+.-]*:[^\s>]*>$/i.test(source.slice(i, close + 1))) {
        for (let k = i + 1; k < close; k++) push(source[k], k);
        spans.push({ start: i, end: close + 1 });
        i = close + 1;
        continue;
      }
    }

    push(ch, i);
    i++;
  }

  return { text: out.join(''), map, spans };
}

const DELIMITERS = new Set(['*', '_', '~']);

/**
 * Widen a source range so it does not end halfway through markup.
 *
 * Two adjustments: cover any tracked construct the range clips (a link whose
 * label is selected but whose destination is not), and absorb runs of emphasis
 * delimiters at either edge. A quote reading `retained for [one year` is not
 * wrong — it still matches exactly — but it is what Claude and the reviewer
 * both end up reading, so it is worth making whole.
 */
function snapToMarkup(
  source: string,
  range: { start: number; end: number },
  spans: Array<{ start: number; end: number }>,
  offset: number,
): { start: number; end: number } {
  let { start, end } = range;
  for (const s of spans) {
    const a = s.start + offset;
    const b = s.end + offset;
    if (a < end && b > start) {
      start = Math.min(start, a);
      end = Math.max(end, b);
    }
  }
  while (start > 0 && DELIMITERS.has(source[start - 1])) start--;
  while (end < source.length && DELIMITERS.has(source[end])) end++;
  return { start, end };
}

/** Opener offset to closer offset for every bracket pair, in one pass. */
function bracketPairs(s: string): Map<number, number> {
  const stack: number[] = [];
  const pairs = new Map<number, number>();
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === '[') stack.push(i);
    else if (s[i] === ']') {
      const open = stack.pop();
      if (open !== undefined) pairs.set(open, i);
    }
  }
  return pairs;
}

function matchingPair(s: string, open: number, o: string, c: string): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === o) depth++;
    else if (s[i] === c) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/* ------------------------------------------------------------------ *
 * Locating a rendered selection in the source
 * ------------------------------------------------------------------ */

/** Collapse runs of whitespace, so DOM text nodes and source line wraps agree. */
function flatten(s: string): { text: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out.push(' ');
      map.push(i);
      pendingSpace = false;
    }
    out.push(ch);
    map.push(i);
  }
  return { text: out.join(''), map };
}

export interface SourceRange {
  start: number;
  end: number;
  /** How the match was made — 'block' means we could not do better than the whole block. */
  precision: 'exact' | 'stripped' | 'block';
}

/**
 * Locate `rendered` — text the user selected in the preview — within the source
 * span of the block it came from.
 *
 * The cascade mirrors `resolveAnchor`, most trustworthy first:
 *   1. the selection appears verbatim in the block's source (plain prose)
 *   2. it appears once inline markup is stripped (bold, links, code spans)
 *   3. neither — anchor the whole block, which is imprecise but never wrong
 *
 * It never returns a span it is not confident about, because a comment attached
 * to the wrong sentence is worse than one attached to the whole paragraph.
 */
export function locateInSource(
  source: string,
  block: BlockRange,
  rendered: string,
): SourceRange | null {
  const needle = rendered.trim();
  if (!needle) return null;

  const slice = source.slice(block.start, block.end);

  // 1 — verbatim.
  const direct = slice.indexOf(needle);
  if (direct !== -1) {
    return {
      start: block.start + direct,
      end: block.start + direct + needle.length,
      precision: 'exact',
    };
  }

  // 2 — through the stripped text, projected back through both offset maps.
  const stripped = stripInline(slice);
  const flatStripped = flatten(stripped.text);
  const flatNeedle = flatten(needle).text;
  if (flatNeedle) {
    const at = flatStripped.text.indexOf(flatNeedle);
    if (at !== -1) {
      const firstStripped = flatStripped.map[at];
      const lastStripped = flatStripped.map[at + flatNeedle.length - 1];
      const start = stripped.map[firstStripped];
      const end = stripped.map[lastStripped];
      if (start !== undefined && end !== undefined) {
        const snapped = snapToMarkup(
          source,
          { start: block.start + start, end: block.start + end + 1 },
          stripped.spans,
          block.start,
        );
        return { ...snapped, precision: 'stripped' };
      }
    }
  }

  // 3 — the block itself, trimmed of surrounding blank lines.
  const lead = slice.length - slice.trimStart().length;
  const trail = slice.length - slice.trimEnd().length;
  if (slice.trim().length === 0) return null;
  return { start: block.start + lead, end: block.end - trail, precision: 'block' };
}

/**
 * The inverse: the plain text the webview should search for inside a rendered
 * block in order to highlight an existing comment.
 *
 * The host knows source offsets, the webview knows the DOM; neither needs the
 * other's model if they exchange the visible text.
 */
export function renderedNeedle(source: string, range: { start: number; end: number }): string {
  const stripped = stripInline(source.slice(range.start, range.end));
  return flatten(stripped.text).text;
}
