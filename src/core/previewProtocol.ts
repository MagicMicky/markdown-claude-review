/**
 * The preview ↔ extension message protocol.
 *
 * Types only, zero runtime, imported by both sides so the two cannot drift.
 *
 * The division of labour it encodes: **the host owns the source, the webview
 * owns the DOM.** The webview never sees a source offset and never parses
 * markdown; the host never touches the DOM. A selection crosses as plain text
 * plus a block index, and a highlight crosses back as plain text plus a block
 * index. Neither side needs the other's model.
 */

import type { CardVM } from './cards.js';
import type { ThreadStatus } from './types.js';

/**
 * Where a thread's highlight lives.
 *
 * Source offsets, not text to search for. The rendered HTML carries the source
 * offsets of every run of text, so the webview can find the passage exactly —
 * and across paragraphs, which a single block index could not express.
 */
export interface HighlightSpec {
  threadId: string;
  status: ThreadStatus;
  /** Absent when the anchor no longer resolves. */
  range?: { start: number; end: number };
}

export type HostMessage =
  /**
   * Full document re-render, carrying the generation of the block map it was
   * built from. Highlights are expressed in terms of that map, so a `threads`
   * message from an older generation must be discarded rather than painted
   * onto a DOM it does not describe.
   */
  | { type: 'document'; generation: number; html: string }
  /** Thread content changed. Cheap relative to a re-render. */
  | {
      type: 'threads';
      generation: number;
      author: string;
      cards: CardVM[];
      highlights: HighlightSpec[];
    }
  /** Which thread is active, and who decided. `origin` breaks the focus loop. */
  | { type: 'active'; threadId: string | null; origin: 'editor' | 'webview' | 'command' }
  /** Scroll the preview to a source line (editor → preview sync). */
  | { type: 'scrollTo'; line: number }
  /** The editor's cursor line, for the `markEditorSelection` marker. */
  | { type: 'editorSelection'; line: number | null }
  /** A composer was opened for a captured anchor. */
  | { type: 'compose'; draftId: string; range: { start: number; end: number }; quote: string }
  | { type: 'draftLost'; draftId: string; reason: string }
  | { type: 'ack'; opId: string; ok: true }
  | { type: 'ack'; opId: string; ok: false; message: string };

export type ViewMessage =
  | { type: 'ready'; knownDraftIds: string[] }
  /**
   * A selection the user wants to comment on, already in source offsets — the
   * DOM carries them, so nothing has to reconstruct which characters were
   * markup.
   */
  | { type: 'startCompose'; start: number; end: number }
  | { type: 'createThread'; opId: string; draftId: string; body: string }
  | { type: 'cancelDraft'; draftId: string }
  | { type: 'reply'; opId: string; threadId: string; body: string }
  | { type: 'resolve'; opId: string; threadId: string }
  | { type: 'reopen'; opId: string; threadId: string }
  | { type: 'delete'; opId: string; threadId: string }
  /** Focus a thread; the host moves the editor's cursor to match. */
  | { type: 'activate'; threadId: string | null }
  /** Preview → editor scroll sync. */
  | { type: 'revealLine'; line: number }
  /** Double-click in the preview jumps the editor to that line. */
  | { type: 'openAtLine'; line: number }
  | { type: 'openLink'; href: string }
  /** Point a thread that lost its place at a freshly selected passage. */
  | { type: 'reattach'; opId: string; threadId: string; start: number; end: number };
