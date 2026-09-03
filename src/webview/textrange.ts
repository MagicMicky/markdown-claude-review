/**
 * Turning source offsets into a DOM Range.
 *
 * The rendered document carries the source offsets of every run of text, so a
 * passage can be located exactly rather than by searching for text the host
 * guessed the page would show. That guess was wrong for tables, code, entities,
 * raw HTML and `snake_case` identifiers, and wrong meant no highlight at all.
 *
 * Because runs are just elements in document order, a range spanning several
 * paragraphs is no harder than one inside a sentence.
 */

interface Run {
  el: Element;
  start: number;
  end: number;
  /**
   * The source spelling is a different length from the rendered text — an
   * entity, an escape. Offsets inside cannot be interpolated, so the run is
   * treated as one unit rather than landing on the wrong characters.
   */
  approx: boolean;
}

function runsIn(root: ParentNode): Run[] {
  const out: Run[] = [];
  for (const el of Array.from(root.querySelectorAll('[data-o]'))) {
    const start = Number(el.getAttribute('data-o'));
    const end = Number(el.getAttribute('data-e'));
    if (Number.isFinite(start) && Number.isFinite(end)) {
      out.push({ el, start, end, approx: el.hasAttribute('data-approx') });
    }
  }
  return out;
}

/** First text node inside an element, and the total text length. */
function textNodes(el: Element): Text[] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let n = walker.nextNode() as Text | null;
  while (n) {
    nodes.push(n);
    n = walker.nextNode() as Text | null;
  }
  return nodes;
}

/**
 * Position inside a run, `chars` characters in.
 *
 * A run's rendered text and its source slice are the same length in the normal
 * case; entities and escapes make the source longer, so the offset is clamped
 * rather than trusted blindly.
 */
function pointInRun(run: Run, chars: number): { node: Node; offset: number } {
  const nodes = textNodes(run.el);
  if (nodes.length === 0) return { node: run.el, offset: 0 };
  const total = nodes.reduce((n, t) => n + t.data.length, 0);
  // An approximate run snaps to whichever edge is nearer: better to cover a
  // little more than to be silently off by the width of an entity.
  let remaining = run.approx ? (chars <= 0 ? 0 : total) : Math.max(0, chars);
  for (const node of nodes) {
    if (remaining <= node.data.length) return { node, offset: remaining };
    remaining -= node.data.length;
  }
  const last = nodes[nodes.length - 1];
  return { node: last, offset: last.data.length };
}

/**
 * A Range covering source `[start, end)`, or null when no rendered text falls
 * in it — a comment on a passage that is currently only markup, for instance.
 */
export function rangeForSource(root: ParentNode, start: number, end: number): Range | null {
  const overlapping = runsIn(root).filter((r) => r.start < end && r.end > start);
  if (overlapping.length === 0) return null;

  const first = overlapping[0];
  const last = overlapping[overlapping.length - 1];
  const from = pointInRun(first, start - first.start);
  const to = pointInRun(last, end - last.start);

  const range = document.createRange();
  range.setStart(from.node, from.offset);
  try {
    range.setEnd(to.node, to.offset);
  } catch {
    return null;
  }
  return range.collapsed ? null : range;
}

/**
 * Source offsets for a DOM position, by reading the run that contains it.
 *
 * `null` when the position is not inside rendered text — between blocks, or in
 * markup the renderer could not attribute to a source span.
 */
export function sourceOffsetAt(node: Node, offset: number): number | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const run = el?.closest('[data-o]');
  if (!run) return null;
  const start = Number(run.getAttribute('data-o'));
  const end = Number(run.getAttribute('data-e'));
  if (!Number.isFinite(start)) return null;

  if (run.hasAttribute('data-approx')) {
    // Same reasoning as pointInRun: report an edge, never a position inside.
    const nodes = textNodes(run);
    const total = nodes.reduce((n, t) => n + t.data.length, 0);
    let seen = 0;
    for (const text of nodes) {
      if (text === node) {
        seen += offset;
        break;
      }
      seen += text.data.length;
    }
    return seen * 2 >= total ? end : start;
  }

  let before = 0;
  for (const text of textNodes(run)) {
    if (text === node) {
      before += offset;
      return Math.min(end, start + before);
    }
    before += text.data.length;
  }
  return start;
}

/**
 * Source range for the current selection, or null if it covers no rendered text.
 *
 * Derived from the runs the selection *intersects*, not from its endpoints.
 * Requiring both endpoints to sit inside a labelled run is wrong: selecting to
 * the end of a paragraph, or triple-clicking one, leaves the end point on the
 * paragraph element itself, which carries no label — so the whole selection
 * looked like it covered nothing. The endpoints are still used, but only to
 * narrow the first and last run when they happen to resolve.
 */
export function selectionRange(
  root: ParentNode,
  sel: Selection,
): { start: number; end: number } | null {
  if (sel.rangeCount === 0 || sel.isCollapsed) return null;
  const domRange = sel.getRangeAt(0);

  const touched = runsIn(root).filter((r) => {
    try {
      return domRange.intersectsNode(r.el);
    } catch {
      return false;
    }
  });
  if (touched.length === 0) return null;

  const first = touched[0];
  const last = touched[touched.length - 1];
  const a = sourceOffsetAt(domRange.startContainer, domRange.startOffset);
  const b = sourceOffsetAt(domRange.endContainer, domRange.endOffset);

  const lo = a !== null && b !== null ? Math.min(a, b) : (a ?? b ?? first.start);
  const hi = a !== null && b !== null ? Math.max(a, b) : (b ?? a ?? last.end);
  const start = Math.max(first.start, Math.min(lo, last.end));
  const end = Math.min(last.end, Math.max(hi, first.start));

  if (end > start) return { start, end };
  // The endpoints told us nothing useful; take everything they touched.
  return last.end > first.start ? { start: first.start, end: last.end } : null;
}
