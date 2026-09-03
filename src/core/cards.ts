/**
 * View-model for the comment sidebar.
 *
 * Pure, and deliberately free of `node:*` as well as `vscode` — this module is
 * bundled into the webview, where neither exists. `src/core/store.ts` imports
 * `node:fs`, so re-exporting anything from there would fail at runtime rather
 * than at build time. The webview's esbuild target uses `platform: 'browser'`
 * so that mistake becomes a build error instead.
 */

import type { Author, ResolvedAnchor, Thread, ThreadStatus } from './types.js';

/** Quotes longer than this are clipped in the card; the full text stays on disk. */
export const QUOTE_CHARS = 140;

export type Scope = 'document' | 'workspace';

/** How well a thread's anchor currently matches the document. */
export type Attachment = 'exact' | 'drifted' | 'lost';

/**
 * A resolved anchor plus the line the extension computed for it.
 *
 * `line` is 1-based, and null when the document is not open — resolving it
 * would mean reading every closed file on every render.
 */
export interface AnchorHit extends ResolvedAnchor {
  line: number | null;
  /** What the document says under the anchor now, when it differs from the quote. */
  currentText?: string;
}

export interface CardAnchorVM {
  /** Whitespace-collapsed and clipped. The *original* wording when drifted. */
  quote: string;
  quoteTruncated: boolean;
  /** Only when drifted: what the passage says now. */
  currentQuote?: string;
  headingPath: string[];
  /** Deepest heading, or '(document root)'. */
  headingLabel: string;
  line: number | null;
  attachment: Attachment;
}

export interface CardMessageVM {
  id: string;
  author: Author;
  authorName: string;
  body: string;
  ts: string;
}

export interface CardVM {
  id: string;
  docRelPath: string;
  status: ThreadStatus;
  statusLabel: string;
  anchor: CardAnchorVM;
  messages: CardMessageVM[];
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  canReply: boolean;
  canResolve: boolean;
  canReopen: boolean;
  canReattach: boolean;
  /** Document order. Threads whose anchor is lost sort to the end. */
  sortKey: number;
}

export const LOST_SORT_KEY = Number.MAX_SAFE_INTEGER;

const STATUS_LABEL: Record<ThreadStatus, string> = {
  open: 'Waiting on Claude',
  answered: 'Claude replied',
  resolved: 'Resolved',
  stale: 'Lost its place',
};

export function statusLabel(status: ThreadStatus): string {
  return STATUS_LABEL[status];
}

/**
 * Collapse whitespace and clip to `max`, breaking on a word boundary when one
 * is reasonably close to the limit.
 */
export function truncateQuote(
  quote: string,
  max: number = QUOTE_CHARS,
): { text: string; truncated: boolean } {
  const flat = quote.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return { text: flat, truncated: false };

  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  // Only honour a word boundary in the last quarter, or a long unbroken token
  // would be clipped to almost nothing.
  const text = lastSpace > max * 0.75 ? cut.slice(0, lastSpace) : cut;
  return { text: text.trimEnd() + '…', truncated: true };
}

export function buildCard(
  docRelPath: string,
  thread: Thread,
  hit: AnchorHit | undefined,
  opts: { quoteChars?: number } = {},
): CardVM {
  const attachment: Attachment = !hit ? 'lost' : hit.kind;
  const { text, truncated } = truncateQuote(thread.anchor.quote, opts.quoteChars);
  const current =
    attachment === 'drifted' && hit?.currentText
      ? truncateQuote(hit.currentText, opts.quoteChars).text
      : undefined;

  return {
    id: thread.id,
    docRelPath,
    status: thread.status,
    statusLabel: STATUS_LABEL[thread.status],
    anchor: {
      quote: text,
      quoteTruncated: truncated,
      currentQuote: current,
      headingPath: thread.anchor.headingPath,
      headingLabel:
        thread.anchor.headingPath[thread.anchor.headingPath.length - 1] ?? '(document root)',
      line: hit?.line ?? null,
      attachment,
    },
    messages: thread.messages.map((m) => ({
      id: m.id,
      author: m.author,
      authorName: m.authorName,
      body: m.body,
      ts: m.ts,
    })),
    messageCount: thread.messages.length,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    canReply: thread.status !== 'resolved',
    canResolve: thread.status !== 'resolved',
    canReopen: thread.status === 'resolved',
    canReattach: attachment === 'lost',
    sortKey: hit ? hit.start : LOST_SORT_KEY,
  };
}

/** Cards for one document, in document order. */
export function buildCards(
  docRelPath: string,
  threads: readonly Thread[],
  hits: ReadonlyMap<string, AnchorHit>,
  opts: { quoteChars?: number } = {},
): CardVM[] {
  return threads
    .map((t) => buildCard(docRelPath, t, hits.get(t.id), opts))
    .sort((a, b) => a.sortKey - b.sortKey || a.createdAt.localeCompare(b.createdAt));
}

/* ------------------------------------------------------------------ *
 * Active thread
 * ------------------------------------------------------------------ */

export interface Span {
  id: string;
  start: number;
  end: number;
}

/**
 * The thread whose span contains `offset`, treating spans as half-open
 * [start, end).
 *
 * Ties break to the shortest span, then the earliest start, so a comment on a
 * phrase wins over one on the paragraph containing it. Returns null outside
 * every span — no nearest-match fallback, for the same reason `resolveAnchor`
 * has none: a confidently wrong highlight is worse than no highlight.
 */
export function activeThreadAt(offset: number, spans: readonly Span[]): string | null {
  let best: Span | null = null;
  for (const s of spans) {
    if (offset < s.start || offset >= s.end) continue;
    if (
      !best ||
      s.end - s.start < best.end - best.start ||
      (s.end - s.start === best.end - best.start && s.start < best.start)
    ) {
      best = s;
    }
  }
  return best?.id ?? null;
}

/* ------------------------------------------------------------------ *
 * Filtering and counts
 * ------------------------------------------------------------------ */

export interface CardFilter {
  statuses: readonly ThreadStatus[];
  scope: Scope;
  /** Case-insensitive substring over message bodies and the quote. */
  query?: string;
}

export function filterCards(
  cards: readonly CardVM[],
  filter: CardFilter,
  activeDoc: string | null,
): CardVM[] {
  const needle = filter.query?.trim().toLowerCase();
  return cards.filter((c) => {
    if (filter.scope === 'document' && c.docRelPath !== activeDoc) return false;
    if (!filter.statuses.includes(c.status)) return false;
    if (!needle) return true;
    return (
      c.anchor.quote.toLowerCase().includes(needle) ||
      c.messages.some((m) => m.body.toLowerCase().includes(needle))
    );
  });
}

export interface Counts {
  total: number;
  open: number;
  answered: number;
  resolved: number;
  stale: number;
  /** open + stale: what the badge shows, and what a hand-off to Claude covers. */
  needsAttention: number;
}

export function countCards(cards: readonly CardVM[]): Counts {
  const counts: Counts = {
    total: cards.length,
    open: 0,
    answered: 0,
    resolved: 0,
    stale: 0,
    needsAttention: 0,
  };
  for (const c of cards) counts[c.status]++;
  counts.needsAttention = counts.open + counts.stale;
  return counts;
}

/* ------------------------------------------------------------------ *
 * Time
 * ------------------------------------------------------------------ */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Compact age label. Takes `nowMs` rather than calling `Date.now()` so it can
 * be tested at boundaries.
 */
export function relativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const delta = nowMs - then;

  if (delta < MINUTE) return 'now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < 2 * DAY) return 'yesterday';

  const d = new Date(then);
  const label = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date(nowMs).getFullYear() ? label : `${label} ${d.getFullYear()}`;
}
