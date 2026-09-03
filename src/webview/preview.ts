/**
 * The commenting preview's client.
 *
 * Bundled with `platform: 'browser'`. It owns the DOM and nothing else: it never
 * sees a source offset and never parses markdown. A selection leaves as plain
 * text plus a block index; a highlight arrives the same way. The host does the
 * mapping, because the host is what holds the source.
 *
 * On `innerHTML`: the rendered document is injected as HTML, because that is
 * what a preview is — the same trust model as VS Code's own, with a CSP whose
 * `script-src` is nonce-only so injected scripts cannot run. **Comment bodies
 * are different.** They are written by another process into a JSON file and go
 * through `textContent`, never `innerHTML`.
 */

import { relativeTime, type CardVM } from '../core/cards.js';
import type { HighlightSpec, HostMessage, ViewMessage } from '../core/previewProtocol.js';
import { rangeForSource, selectionRange } from './textrange.js';

interface VsCodeApi {
  postMessage(message: ViewMessage): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface PersistedState {
  /** Unsent text, keyed by thread id for replies and draft id for new comments. */
  drafts: Record<string, string>;
}

const vscode = acquireVsCodeApi();

const doc = document.getElementById('doc')!;
const margin = document.getElementById('margin')!;
const addButton = document.getElementById('add') as HTMLButtonElement;

const BUBBLE_GAP = 8;
const SELECTION_DEBOUNCE_MS = 120;
const SCROLL_THROTTLE_MS = 50;
/** After a programmatic scroll, ignore our own scroll events for this long. */
const ECHO_SUPPRESS_MS = 200;
/** Leave the page alone for this long after the reader last scrolled it. */
const USER_SCROLL_QUIET_MS = 400;

type Pending =
  | { kind: 'reply'; threadId: string; body: string }
  | { kind: 'status'; threadId: string }
  | { kind: 'create'; draftId: string };

interface Draft {
  draftId: string;
  range: { start: number; end: number };
  quote: string;
  lost?: string;
}

const stored = vscode.getState();
const state = {
  cards: [] as CardVM[],
  highlights: [] as HighlightSpec[],
  author: 'You',
  activeId: null as string | null,
  drafts: stored?.drafts ?? ({} as Record<string, string>),
  draft: null as Draft | null,
  pending: {} as Record<string, Pending>,
  errors: {} as Record<string, string>,
  /** threadId → live Range in the rendered document. */
  ranges: new Map<string, Range>(),
  /** Block-map generation of the DOM currently rendered. */
  generation: -1,
};

let opSeq = 0;
const nextOp = () => `op_${++opSeq}`;
const post = (m: ViewMessage) => vscode.postMessage(m);

let saveTimer: number | undefined;
function persist(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    vscode.setState({ drafts: state.drafts });
  }, 300);
}

/* ------------------------------------------------------------------ *
 * Highlights
 * ------------------------------------------------------------------ */

/**
 * TypeScript 5.6's DOM lib declares `HighlightRegistry` with only `forEach`,
 * although the spec (and Chromium) make it a `Map`. Augment rather than cast,
 * so the calls below stay type-checked.
 */
declare global {
  interface HighlightRegistry {
    set(name: string, highlight: Highlight): void;
    delete(name: string): boolean;
  }
}

const HIGHLIGHT_NAMES: Record<string, string> = {
  open: 'mdreview-open',
  answered: 'mdreview-answered',
  stale: 'mdreview-stale',
  resolved: 'mdreview-resolved',
  active: 'mdreview-active',
};

/** Feature-detect once; older hosts fall back to wrapping spans. */
const supportsHighlightApi =
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

function rebuildHighlights(): void {
  state.ranges.clear();
  for (const spec of state.highlights) {
    if (!spec.range) continue;
    const range = rangeForSource(doc, spec.range.start, spec.range.end);
    if (range) state.ranges.set(spec.threadId, range);
  }
  paintHighlights();
}

function paintHighlights(): void {
  if (!supportsHighlightApi) return paintHighlightsFallback();

  const buckets: Record<string, Range[]> = {
    open: [],
    answered: [],
    stale: [],
    resolved: [],
    active: [],
  };
  for (const spec of state.highlights) {
    const range = state.ranges.get(spec.threadId);
    if (!range) continue;
    if (spec.threadId === state.activeId) buckets.active.push(range);
    else buckets[spec.status]?.push(range);
  }
  for (const [key, ranges] of Object.entries(buckets)) {
    const name = HIGHLIGHT_NAMES[key];
    if (ranges.length) CSS.highlights.set(name, new Highlight(...ranges));
    else CSS.highlights.delete(name);
  }
}

/** Wrapping spans mutate the DOM, so this is only used where the API is absent. */
function paintHighlightsFallback(): void {
  for (const el of Array.from(doc.querySelectorAll('.mdreview-mark'))) {
    const parent = el.parentNode;
    if (!parent) continue;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    parent.normalize();
  }
  for (const spec of state.highlights) {
    const range = state.ranges.get(spec.threadId);
    if (!range) continue;
    const mark = document.createElement('span');
    mark.className = `mdreview-mark status-${spec.status}`;
    try {
      range.surroundContents(mark);
    } catch {
      /* the range crosses element boundaries; skip rather than mangle the DOM */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Bubbles
 * ------------------------------------------------------------------ */

/** Cards in the order their passages appear on screen. */
function visibleCards(): CardVM[] {
  return [...state.cards].sort((a, b) => anchorTop(a.id) - anchorTop(b.id));
}

function anchorTop(threadId: string): number {
  const range = state.ranges.get(threadId);
  if (!range) return Number.MAX_SAFE_INTEGER;
  const rect = range.getBoundingClientRect();
  if (rect.height === 0 && rect.width === 0) return Number.MAX_SAFE_INTEGER;
  return rect.top + window.scrollY;
}

let layoutQueued = false;
function scheduleLayout(): void {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => {
    layoutQueued = false;
    layoutBubbles();
  });
}

/**
 * Place each bubble at its passage, then push later ones down so they never
 * overlap. This is the whole reason the preview is our own webview rather than
 * VS Code's — here we can read `getBoundingClientRect()`.
 */
function layoutBubbles(): void {
  // Read phase — every measurement first, so the write phase below cannot
  // force a reflow between each bubble.
  const measured: Array<{ el: HTMLElement; desired: number; height: number }> = [];
  for (const card of visibleCards()) {
    const el = margin.querySelector<HTMLElement>(`[data-bubble="${cssEscape(card.id)}"]`);
    if (!el) continue;
    measured.push({ el, desired: anchorTop(card.id), height: el.offsetHeight });
  }

  const composer = margin.querySelector<HTMLElement>('[data-composer]');
  const composerTop = composer && state.draft ? draftAnchorTop() : null;

  // Write phase — place each bubble at its passage, pushing later ones down so
  // none overlap. This is why the preview is our own webview: here we can read
  // the geometry VS Code's editor never exposes.
  //
  // A bubble with no passage on screen goes after the last one that has one,
  // never at the top: `previousBottom` starts at -Infinity, so clamping it to
  // zero used to park unanchored bubbles at the head of the document.
  let previousBottom = -Infinity;
  let lastAnchored = 0;
  for (const { el, desired, height } of measured) {
    const anchored = desired !== Number.MAX_SAFE_INTEGER;
    const base = anchored ? desired : Math.max(lastAnchored, previousBottom);
    const top = Math.max(base, previousBottom + BUBBLE_GAP, 0);
    el.style.top = `${top}px`;
    previousBottom = top + height;
    if (anchored) lastAnchored = top + height;
  }
  if (composer && composerTop !== null) composer.style.top = `${Math.max(0, composerTop)}px`;
}

function draftAnchorTop(): number {
  const range = draftRange();
  return range ? range.getBoundingClientRect().top + window.scrollY : window.scrollY;
}

function draftRange(): Range | null {
  if (!state.draft) return null;
  return rangeForSource(doc, state.draft.range.start, state.draft.range.end);
}

/* ------------------------------------------------------------------ *
 * Rendering the margin
 * ------------------------------------------------------------------ */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}

function renderMargin(): void {
  // Never rebuild a bubble whose textarea has focus.
  const typing = document.activeElement;
  const typingBubble =
    typing instanceof HTMLTextAreaElement ? typing.closest<HTMLElement>('[data-bubble]') : null;

  const existing = new Map<string, HTMLElement>();
  for (const node of Array.from(margin.querySelectorAll<HTMLElement>('[data-bubble]'))) {
    if (node.dataset.bubble) existing.set(node.dataset.bubble, node);
  }

  const children: HTMLElement[] = [];
  if (state.draft) children.push(renderComposer(state.draft));

  const now = Date.now();
  for (const card of visibleCards()) {
    const previous = existing.get(card.id);
    if (previous && previous === typingBubble) {
      children.push(previous);
      continue;
    }
    const sig = signature(card);
    if (previous && previous.dataset.sig === sig) {
      children.push(previous);
      continue;
    }
    children.push(renderBubble(card, sig, now));
  }

  margin.replaceChildren(...children);
  // Synchronously, not on the next frame: anything that focuses a newly created
  // bubble must find it already at its passage. Focusing an element still
  // sitting at the top of the margin scrolls the page there.
  layoutBubbles();
}

function signature(card: CardVM): string {
  const pending = Object.values(state.pending).filter(
    (p) => 'threadId' in p && p.threadId === card.id,
  );
  return JSON.stringify([
    card.status,
    card.updatedAt,
    card.messageCount,
    card.anchor.attachment,
    card.anchor.currentQuote ?? null,
    state.activeId === card.id,
    state.drafts[card.id] ?? '',
    state.errors[card.id] ?? '',
    pending.map((p) => p.kind),
  ]);
}

function renderBubble(card: CardVM, sig: string, now: number): HTMLElement {
  const active = state.activeId === card.id;
  const pending = Object.values(state.pending).filter(
    (p) => 'threadId' in p && p.threadId === card.id,
  );
  const busy = pending.length > 0;
  const optimistic = pending.find((p): p is Extract<Pending, { kind: 'reply' }> => p.kind === 'reply');

  const node = el('div', `bubble status-${card.status} ${active ? 'active' : 'compact'}`);
  node.dataset.bubble = card.id;
  node.dataset.sig = sig;
  node.tabIndex = 0;
  if (busy) node.classList.add('busy');

  node.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button, textarea')) return;
    activate(card.id, true);
  });

  const head = el('div', 'bubble-head');
  head.append(
    el('span', 'who', card.messages[0]?.authorName ?? state.author),
    el('span', 'spacer'),
    el('span', 'muted', relativeTime(card.updatedAt, now)),
  );
  node.append(head);

  if (card.anchor.attachment === 'drifted') {
    node.append(el('div', 'note drift', 'Text edited since you commented'));
  }
  if (card.anchor.attachment === 'lost') {
    node.append(el('div', 'note lost', 'The text this pointed at is gone. Its history is kept.'));
    node.append(el('blockquote', 'quote', card.anchor.quote));
    const ready = Boolean(pendingSelection);
    const reattach = el('button', '', 'Re-attach to selection');
    reattach.disabled = busy || !ready;
    reattach.title = ready
      ? 'Point this comment at the text you have selected'
      : 'Select the passage this comment should point at first';
    reattach.addEventListener('click', () => reattachTo(card.id));
    const row = el('div', 'actions');
    row.append(reattach);
    node.append(row);
  }

  const messages = active ? card.messages : card.messages.slice(0, 1);
  for (const m of messages) {
    const msg = el('div', `msg ${m.author}`);
    if (m !== card.messages[0]) {
      const h = el('div', 'msg-head');
      h.append(
        el('span', 'who', m.author === 'claude' ? 'Claude' : m.authorName),
        el('span', 'muted', relativeTime(m.ts, now)),
      );
      msg.append(h);
    }
    msg.append(el('div', 'body', m.body));
    node.append(msg);
  }
  if (!active && card.messageCount > 1) {
    node.append(el('div', 'more', `${card.messageCount - 1} more`));
  }
  if (optimistic) {
    const msg = el('div', 'msg user pending');
    msg.append(el('div', 'body', optimistic.body));
    node.append(msg);
  }
  if (state.errors[card.id]) {
    node.append(el('div', 'note error', state.errors[card.id]));
  }

  if (active) {
    const actions = el('div', 'actions');
    {
      const box = el('textarea', 'reply');
      box.rows = 2;
      box.placeholder = 'Reply…';
      box.value = state.drafts[card.id] ?? '';
      box.addEventListener('input', () => {
        if (box.value) state.drafts[card.id] = box.value;
        else delete state.drafts[card.id];
        persist();
      });
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          reply(card.id, box.value);
        } else if (e.key === 'Escape') box.blur();
      });
      box.addEventListener('focus', () => {
        // Guard the same way: a reply box gaining focus must not move the page.
        lastUserScroll = Date.now();
      });
      node.append(box);

      const send = el('button', 'primary', 'Reply');
      send.disabled = busy;
      send.addEventListener('click', () => reply(card.id, box.value));
      actions.append(send);
    }
    const resolve = el('button', '', 'Resolve');
    resolve.disabled = busy;
    resolve.addEventListener('click', () => mutate('resolve', card.id));
    actions.append(resolve);
    actions.append(el('span', 'spacer'));
    const del = el('button', 'link danger', 'Delete');
    del.disabled = busy;
    del.addEventListener('click', () => mutate('delete', card.id));
    actions.append(del);
    node.append(actions);
  }

  return node;
}

function renderComposer(draft: Draft): HTMLElement {
  const node = el('div', 'bubble composing active');
  node.dataset.bubble = `draft:${draft.draftId}`;
  node.dataset.composer = '';

  const head = el('div', 'bubble-head');
  head.append(el('span', 'who', state.author));
  node.append(head);
  node.append(el('blockquote', 'quote', draft.quote));
  if (draft.lost) node.append(el('div', 'note error', draft.lost));

  const box = el('textarea', 'reply');
  box.rows = 3;
  box.placeholder = 'What should change here?';
  box.value = state.drafts[draft.draftId] ?? '';
  box.addEventListener('input', () => {
    if (box.value) state.drafts[draft.draftId] = box.value;
    else delete state.drafts[draft.draftId];
    persist();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submitDraft(box.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelDraft();
    }
  });
  node.append(box);

  const actions = el('div', 'actions');
  const send = el('button', 'primary', 'Comment');
  send.disabled = Boolean(draft.lost);
  send.addEventListener('click', () => submitDraft(box.value));
  const cancel = el('button', '', 'Cancel');
  cancel.addEventListener('click', () => cancelDraft());
  actions.append(send, cancel);
  node.append(actions);

  // preventScroll because the passage was just selected, so it is already in
  // view — the caret does not need the browser to go looking for it.
  queueMicrotask(() => box.focus({ preventScroll: true }));
  return node;
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

function activate(threadId: string | null, tellHost: boolean): void {
  state.activeId = threadId;
  if (tellHost) post({ type: 'activate', threadId });
  paintHighlights();
  renderMargin();
  // Clicking a bubble should not move the page unless its passage is off
  // screen — the reader is already looking at where they clicked.
  if (threadId) scrollRangeIntoView(state.ranges.get(threadId));
}

/** Scroll only when the passage is actually out of view, and without animation. */
function scrollRangeIntoView(range: Range | undefined): void {
  if (!range) return;
  const rect = range.getBoundingClientRect();
  if (rect.height === 0 && rect.width === 0) return;
  const margin = 24;
  if (rect.top >= margin && rect.bottom <= window.innerHeight - margin) return;
  suppressScrollUntil = Date.now() + ECHO_SUPPRESS_MS;
  window.scrollTo({ top: rect.top + window.scrollY - window.innerHeight / 3 });
}

function reply(threadId: string, body: string): void {
  const trimmed = body.trim();
  if (!trimmed) return;
  const opId = nextOp();
  state.pending[opId] = { kind: 'reply', threadId, body: trimmed };
  delete state.drafts[threadId];
  delete state.errors[threadId];
  post({ type: 'reply', opId, threadId, body: trimmed });
  persist();
  renderMargin();
}

function reattachTo(threadId: string): void {
  if (!pendingSelection) return;
  const opId = nextOp();
  state.pending[opId] = { kind: 'status', threadId };
  post({ type: 'reattach', opId, threadId, ...pendingSelection });
  addButton.hidden = true;
  pendingSelection = null;
  renderMargin();
}

function mutate(kind: 'resolve' | 'delete', threadId: string): void {
  const opId = nextOp();
  state.pending[opId] = { kind: 'status', threadId };
  post({ type: kind, opId, threadId } as ViewMessage);
  renderMargin();
}

function submitDraft(body: string): void {
  const draft = state.draft;
  if (!draft || !body.trim()) return;
  const opId = nextOp();
  state.pending[opId] = { kind: 'create', draftId: draft.draftId };
  delete state.drafts[draft.draftId];
  post({ type: 'createThread', opId, draftId: draft.draftId, body: body.trim() });
  state.draft = null;
  persist();
  renderMargin();
}

function cancelDraft(): void {
  if (!state.draft) return;
  post({ type: 'cancelDraft', draftId: state.draft.draftId });
  delete state.drafts[state.draft.draftId];
  state.draft = null;
  persist();
  renderMargin();
}

/* ------------------------------------------------------------------ *
 * Selection → comment
 * ------------------------------------------------------------------ */

let selectionTimer: number | undefined;
let pendingSelection: { start: number; end: number } | null = null;

// Hide eagerly when the selection collapses, but only *show* once the gesture
// has finished — chasing the pointer through a drag is what made selecting feel
// unsteady.
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) {
    addButton.hidden = true;
    pendingSelection = null;
  }
});

for (const event of ['mouseup', 'keyup', 'touchend'] as const) {
  document.addEventListener(event, () => {
    window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(evaluateSelection, SELECTION_DEBOUNCE_MS);
  });
}

/** The thread whose highlighted passage covers a viewport point, if any. */
function threadAtPoint(x: number, y: number): string | null {
  let best: { id: string; area: number } | null = null;
  for (const [id, range] of state.ranges) {
    for (const rect of Array.from(range.getClientRects())) {
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      const area = rect.width * rect.height;
      // Innermost wins, matching how the editor picks between nested comments.
      if (!best || area < best.area) best = { id, area };
    }
  }
  return best?.id ?? null;
}

function evaluateSelection(): void {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    addButton.hidden = true;
    pendingSelection = null;
    return;
  }
  // Source offsets come from the runs the selection touches, so a selection
  // crossing paragraphs, table cells or inline markup needs no special case.
  const range = selectionRange(sel);
  if (!range || !doc.contains(sel.getRangeAt(0).commonAncestorContainer)) {
    addButton.hidden = true;
    pendingSelection = null;
    return;
  }

  pendingSelection = range;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  addButton.hidden = false;
  addButton.style.top = `${rect.bottom + window.scrollY + 6}px`;
  addButton.style.left = `${Math.max(8, rect.left + window.scrollX)}px`;
}

addButton.addEventListener('mousedown', (e) => e.preventDefault());

addButton.addEventListener('click', () => {
  if (!pendingSelection) return;
  post({ type: 'startCompose', ...pendingSelection });
  addButton.hidden = true;
  pendingSelection = null;
  window.getSelection()?.removeAllRanges();
});

/* ------------------------------------------------------------------ *
 * Scroll sync and document interaction
 * ------------------------------------------------------------------ */

let suppressScrollUntil = 0;
let scrollTimer: number | undefined;
let lastUserScroll = 0;

window.addEventListener(
  'scroll',
  () => {
    lastUserScroll = Date.now();
    // No re-layout here. Bubble tops are document coordinates, so scrolling
    // does not change them; measuring rects mid-scroll only produced jitter.
    if (Date.now() < suppressScrollUntil) return;
    window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => {
      post({ type: 'revealLine', line: topVisibleLine() });
      persist();
    }, SCROLL_THROTTLE_MS);
  },
  { passive: true },
);

// Layout depends on the document's geometry, so re-run it when that changes —
// not when the viewport merely moves over it.
window.addEventListener('resize', scheduleLayout);
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => scheduleLayout()).observe(doc);
}
if (document.fonts?.ready) void document.fonts.ready.then(() => scheduleLayout());

/** Nearest source line at the top of the viewport, interpolating within a block. */
function topVisibleLine(): number {
  const blocks = Array.from(doc.querySelectorAll<HTMLElement>('[data-line]'));
  let best = 0;
  for (const b of blocks) {
    const rect = b.getBoundingClientRect();
    if (rect.height === 0) continue;
    const start = Number(b.getAttribute('data-line'));
    const end = Number(b.getAttribute('data-line-end') ?? start + 1);
    if (rect.bottom < 0) {
      best = end;
      continue;
    }
    if (rect.top > 0) break;
    const progress = Math.min(1, Math.max(0, -rect.top / Math.max(1, rect.height)));
    return start + (end - start) * progress;
  }
  return best;
}

doc.addEventListener('click', (e) => {
  // A highlight drawn with the CSS Custom Highlight API is not an element, so
  // hit-test the live ranges rather than looking for something under the mouse.
  if (!(e.target as HTMLElement).closest('a')) {
    const hit = threadAtPoint(e.clientX, e.clientY);
    // Clicking plain prose clears the active thread. Without this the
    // highlight from the last comment stays lit while you read elsewhere.
    if (hit !== state.activeId) activate(hit, true);
  }

  const link = (e.target as HTMLElement).closest('a');
  if (!link) return;
  const href = link.getAttribute('href');
  if (!href) return;
  e.preventDefault();
  if (href.startsWith('#')) {
    document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  post({ type: 'openLink', href });
});

// Deliberately NOT double-click. VS Code's built-in preview jumps to the source
// on double-click, which it can afford because you do not select text there. In
// a commenting preview, double-click is how you pick a word — binding a jump to
// it fights the one gesture that matters. Alt+click does the jump instead.
doc.addEventListener('click', (e) => {
  if (!e.altKey) return;
  const block = (e.target as HTMLElement).closest('[data-line]');
  if (!block) return;
  e.preventDefault();
  post({ type: 'openAtLine', line: Number(block.getAttribute('data-line')) });
});

/* ------------------------------------------------------------------ *
 * Host messages
 * ------------------------------------------------------------------ */

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const m = event.data;
  switch (m.type) {
    case 'document': {
      state.generation = m.generation;
      // The rendered document. This is the one place HTML is injected, and it
      // is inherent to being a preview — VS Code's own does the same with the
      // same `html: true` markdown-it option, so that documents embedding HTML
      // render at all.
      //
      // What keeps it safe is the CSP in preview.ts: `script-src` is
      // nonce-only, so neither a `<script>` tag nor an inline `onerror=`
      // handler in the document can execute, and `default-src 'none'` blocks
      // frames and outbound requests. Comment bodies never come through here —
      // they are set with textContent.
      doc.innerHTML = m.html;
      rebuildHighlights();
      renderMargin();
      return;
    }

    case 'threads': {
      // Highlights are expressed against a block map. If the document has been
      // re-rendered since this was built, painting it would put highlights on
      // the wrong paragraphs — drop it and wait for the matching push.
      if (m.generation !== state.generation) return;
      state.cards = m.cards;
      state.highlights = m.highlights;
      state.author = m.author;
      for (const [opId, p] of Object.entries(state.pending)) {
        if (p.kind === 'create') continue;
        const card = m.cards.find((c) => c.id === p.threadId);
        if (!card) delete state.pending[opId];
        else if (p.kind === 'reply' && card.messages.some((x) => x.body === p.body)) {
          delete state.pending[opId];
        }
      }
      rebuildHighlights();
      renderMargin();
      return;
    }

    case 'active': {
      state.activeId = m.threadId;
      paintHighlights();
      renderMargin();
      // Only follow the editor, never our own click, and never while the
      // reader is actively scrolling — a smooth scroll on top of a manual one
      // is exactly the fight that felt jumpy.
      if (m.origin !== 'webview' && m.threadId && Date.now() - lastUserScroll > USER_SCROLL_QUIET_MS) {
        scrollRangeIntoView(state.ranges.get(m.threadId));
      }
      return;
    }

    case 'scrollTo': {
      const target = elementForLine(m.line);
      if (!target) return;
      suppressScrollUntil = Date.now() + ECHO_SUPPRESS_MS;
      window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY });
      scheduleLayout();
      return;
    }

    case 'editorSelection': {
      for (const el of Array.from(doc.querySelectorAll('.code-active-line'))) {
        el.classList.remove('code-active-line');
      }
      if (m.line !== null) elementForLine(m.line)?.classList.add('code-active-line');
      return;
    }

    case 'compose':
      state.draft = { draftId: m.draftId, range: m.range, quote: m.quote };
      renderMargin();
      return;

    case 'draftLost':
      if (state.draft?.draftId === m.draftId) state.draft.lost = m.reason;
      renderMargin();
      return;

    case 'ack': {
      const op = state.pending[m.opId];
      delete state.pending[m.opId];
      if (!m.ok && op && m.message && m.message !== 'cancelled') {
        if (op.kind === 'create') {
          // Give the draft back rather than losing what was typed.
          state.drafts[op.draftId] = state.drafts[op.draftId] ?? '';
          if (state.draft?.draftId === op.draftId) state.draft.lost = m.message;
          else window.alert(m.message);
        } else {
          state.errors[op.threadId] = m.message;
          if (op.kind === 'reply') state.drafts[op.threadId] = op.body;
        }
        persist();
      }
      renderMargin();
      return;
    }
  }
});

function elementForLine(line: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  for (const b of Array.from(doc.querySelectorAll<HTMLElement>('[data-line]'))) {
    if (Number(b.getAttribute('data-line')) <= line) best = b;
    else break;
  }
  return best;
}

post({ type: 'ready', knownDraftIds: Object.keys(state.drafts) });
