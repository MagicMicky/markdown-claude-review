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

/** Where a thread's highlight lives, in terms the webview can act on. */
export interface HighlightSpec {
  threadId: string;
  status: ThreadStatus;
  /** Block to search in — matches `data-block` in the rendered HTML. */
  block: number;
  /** Visible text to find inside that block. Empty when the anchor is lost. */
  needle: string;
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
  | { type: 'compose'; draftId: string; block: number; needle: string; quote: string }
  | { type: 'draftLost'; draftId: string; reason: string }
  | { type: 'ack'; opId: string; ok: true }
  | { type: 'ack'; opId: string; ok: false; message: string };

export type ViewMessage =
  | { type: 'ready'; knownDraftIds: string[] }
  /**
   * A selection the user wants to comment on. `blockStart`/`blockEnd` bracket
   * the rendered blocks it covers — a triple-click or a drag across paragraphs
   * spans more than one — and `text` is what they selected. The host maps it to
   * source offsets; the webview has no idea where that is in the file.
   */
  | { type: 'startCompose'; blockStart: number; blockEnd: number; text: string }
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
  | { type: 'reattach'; opId: string; threadId: string; blockStart: number; blockEnd: number; text: string };
