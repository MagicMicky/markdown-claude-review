/** Schema version of the on-disk review file. Bump on breaking changes. */
export const REVIEW_FILE_VERSION = 1;

export type ThreadStatus =
  /** You commented; Claude has not responded yet. */
  | 'open'
  /** Claude replied or edited; waiting on you. */
  | 'answered'
  /** Closed. Kept in the file forever as history. */
  | 'resolved'
  /** The text this was attached to is gone. Kept, shown, never silently dropped. */
  | 'stale';

export type Author = 'user' | 'claude';

export interface Message {
  id: string;
  author: Author;
  /** Display name; for 'claude' this is just "Claude". */
  authorName: string;
  body: string;
  ts: string;
}

/**
 * A content-addressed pointer into the document, modelled on the W3C Web
 * Annotation TextQuoteSelector. Deliberately holds no line or offset numbers:
 * Claude rewrites the file out-of-band, so anything positional is a lie by the
 * time we read it back.
 */
export interface Anchor {
  /** The exact text that was selected when the comment was made. */
  quote: string;
  /** Up to ~48 chars immediately before the quote, for disambiguation. */
  prefix: string;
  /** Up to ~48 chars immediately after the quote. */
  suffix: string;
  /** Heading trail at the time of selection, e.g. ["3. Access Control", "3.2 Key Rotation"]. */
  headingPath: string[];
}

export interface Thread {
  id: string;
  anchor: Anchor;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  /**
   * Set when a fuzzy re-attach succeeded against changed prose. Tells the UI
   * (and Claude) that the quote below is the *original* wording, not current.
   */
  driftedAt?: string;
}

export interface ReviewFile {
  version: number;
  /** Workspace-relative path of the document these threads belong to. */
  document: string;
  threads: Thread[];
}

/** Result of resolving an Anchor against the current document text. */
export interface ResolvedAnchor {
  start: number;
  end: number;
  /** exact: character-identical. drifted: fuzzy-matched a changed paragraph. */
  kind: 'exact' | 'drifted';
  /** 0-1 similarity; 1 for exact matches. */
  score: number;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Short, sortable, human-typable id. */
export function makeId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${t}${r}`;
}
