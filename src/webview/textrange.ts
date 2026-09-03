/**
 * Finding a piece of visible text inside a rendered block.
 *
 * The host says "highlight this text in block 7"; it does not know how that
 * text got split across `<em>`, `<code>` and text nodes. This walks the block's
 * text nodes as one flattened string — whitespace collapsed, so a source line
 * wrap does not stop a match — and turns a hit back into a DOM `Range`.
 */

interface FlatText {
  text: string;
  /** For each character in `text`, the node and offset it came from. */
  nodes: Text[];
  offsets: number[];
}

function flatten(container: Element): FlatText {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const chars: string[] = [];
  const nodes: Text[] = [];
  const offsets: number[] = [];
  let pendingSpace = false;

  let node = walker.nextNode() as Text | null;
  while (node) {
    const value = node.data;
    for (let i = 0; i < value.length; i++) {
      const ch = value[i];
      if (/\s/.test(ch)) {
        pendingSpace = chars.length > 0;
        continue;
      }
      if (pendingSpace) {
        chars.push(' ');
        nodes.push(node);
        offsets.push(i);
        pendingSpace = false;
      }
      chars.push(ch);
      nodes.push(node);
      offsets.push(i);
    }
    node = walker.nextNode() as Text | null;
  }

  return { text: chars.join(''), nodes, offsets };
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * A `Range` covering `needle` within `container`, or null when it is not there.
 *
 * Returns null rather than approximating: a highlight over the wrong words is
 * worse than none, and the bubble still renders with its quote either way.
 */
export function findTextRange(container: Element, needle: string): Range | null {
  const target = normalize(needle);
  if (!target) return null;

  const flat = flatten(container);
  const at = flat.text.indexOf(target);
  if (at === -1) return null;

  const startNode = flat.nodes[at];
  const startOffset = flat.offsets[at];
  const lastIndex = at + target.length - 1;
  const endNode = flat.nodes[lastIndex];
  const endOffset = flat.offsets[lastIndex];
  if (!startNode || !endNode) return null;

  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset + 1);
  return range;
}
