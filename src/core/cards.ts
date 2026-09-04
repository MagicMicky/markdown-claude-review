/**
 * View-model for a comment bubble.
 *
 * Pure, and free of `node:*` as well as `vscode`: this module is bundled into
 * the webview, where neither exists. `src/core/store.ts` imports `node:fs`, so
 * re-exporting anything from there would break the webview at runtime; the
 * `platform: 'browser'` esbuild target turns that into a build error instead.
 */

import type { Author, ResolvedAnchor, Thread, ThreadStatus } from './types.js';

/** Quotes longer than this are clipped in the card; the full text stays on disk. */
export const QUOTE_CHARS = 140;

/** How well a thread's anchor currently matches the document. */
export type Attachment = 'exact' | 'drifted' | 'lost';

/** A resolved anchor, plus the text currently under it. */
export interface AnchorHit extends ResolvedAnchor {
  /** What the document says under the anchor now, when it differs from the quote. */
  currentText?: string;
}

export interface CardAnchorVM {
  /** Whitespace-collapsed and clipped. The *original* wording when drifted. */
  quote: string;
  /** Only when drifted: what the passage says now. */
  currentQuote?: string;
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
  status: ThreadStatus;
  anchor: CardAnchorVM;
  messages: CardMessageVM[];
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  /** The anchor is lost and the thread is still live, so the bubble offers to re-attach it. */
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
  thread: Thread,
  hit: AnchorHit | undefined,
  opts: { quoteChars?: number } = {},
): CardVM {
  const attachment: Attachment = !hit ? 'lost' : hit.kind;
  const { text } = truncateQuote(thread.anchor.quote, opts.quoteChars);
  const current =
    attachment === 'drifted' && hit?.currentText
      ? truncateQuote(hit.currentText, opts.quoteChars).text
      : undefined;

  return {
    id: thread.id,
    status: thread.status,
    anchor: { quote: text, currentQuote: current, attachment },
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
    // A resolved thread with no home is finished history, not a loose end.
    // Offering re-attach there would flip it back out of `resolved`, which is
    // a status change nobody asked for.
    canReattach: attachment === 'lost' && thread.status !== 'resolved',
    sortKey: hit ? hit.start : LOST_SORT_KEY,
  };
}

/** Cards for one document, in document order. */
export function buildCards(
  threads: readonly Thread[],
  hits: ReadonlyMap<string, AnchorHit>,
  opts: { quoteChars?: number } = {},
): CardVM[] {
  return threads
    .map((t) => buildCard(t, hits.get(t.id), opts))
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
