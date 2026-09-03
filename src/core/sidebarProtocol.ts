/**
 * The webview ↔ extension message protocol.
 *
 * Types only, zero runtime, imported by both sides so the two cannot drift.
 *
 * Two rules the shapes below encode:
 *
 *  - The host is the only writer. The webview never mutates its own copy of the
 *    cards; it renders `state` plus a pending overlay keyed by `opId`, and every
 *    mutation is acknowledged so a failed one can be unwound precisely rather
 *    than by matching on message bodies.
 *
 *  - Content and position travel separately. `state` carries thread bodies and
 *    is pushed when something actually changed; `positions` carries offsets and
 *    line numbers and is pushed on every keystroke burst. Sending the former at
 *    typing speed would re-serialise every thread in the workspace.
 */

import type { Attachment, CardVM, Counts, Scope } from './sidebar.js';
import type { ThreadStatus } from './types.js';

export type InlineMode = 'collapsed' | 'expanded' | 'off';

export interface DocumentSummary {
  docRelPath: string;
  counts: Counts;
}

export interface SelectionInfo {
  docRelPath: string;
  empty: boolean;
}

export type HostMessage =
  /** Full content push. Cheap to render, expensive to build; sent on real changes. */
  | {
      type: 'state';
      rev: number;
      /** Display name for optimistic replies rendered before the host answers. */
      author: string;
      activeDoc: string | null;
      documents: DocumentSummary[];
      cards: CardVM[];
      counts: Counts;
      config: { inlineThreads: InlineMode };
    }
  /** Position-only push: anchors moved, no thread content changed. */
  | {
      type: 'positions';
      rev: number;
      activeDoc: string | null;
      anchors: Record<string, { line: number | null; attachment: Attachment }>;
      /** Drives whether Re-attach is enabled. */
      selection: SelectionInfo | null;
    }
  /** Which card the cursor is in. `origin` stops the click → select → scroll loop. */
  | { type: 'active'; threadId: string | null; origin: 'editor' | 'webview' | 'command' }
  /** An editor selection wants a new comment. */
  | {
      type: 'compose';
      draftId: string;
      docRelPath: string;
      quote: string;
      quoteTruncated: boolean;
      headingPath: string[];
      line: number | null;
    }
  /** The host restarted and no longer holds this draft's anchor. */
  | { type: 'draftLost'; draftId: string; reason: string }
  | { type: 'focusCard'; threadId: string; mode: 'view' | 'reply' }
  | { type: 'ack'; opId: string; ok: true }
  | { type: 'ack'; opId: string; ok: false; message: string };

export type ViewMessage =
  /** Sent once the script is live; `knownDraftIds` lets the host disown stale drafts. */
  | { type: 'ready'; knownDraftIds: string[] }
  /** Select the prose in the editor and expand the inline thread. */
  | { type: 'reveal'; threadId: string }
  /** Keyboard focus moved within the list; does not scroll the editor. */
  | { type: 'setActive'; threadId: string | null }
  | { type: 'reply'; opId: string; threadId: string; body: string }
  | { type: 'resolve'; opId: string; threadId: string }
  | { type: 'reopen'; opId: string; threadId: string }
  /** The host owns the confirmation modal, so this can be acked with `ok: false`. */
  | { type: 'delete'; opId: string; threadId: string }
  /** Uses the editor's live selection, which is why `positions` reports it. */
  | { type: 'reattach'; opId: string; threadId: string }
  | { type: 'startCompose' }
  | { type: 'createThread'; opId: string; draftId: string; body: string }
  | { type: 'cancelDraft'; draftId: string }
  | { type: 'openDocument'; docRelPath: string }
  | { type: 'sendToClaude' }
  | { type: 'refresh' }
  /** Persisted so the view reopens the way it was left. */
  | { type: 'viewState'; scope: Scope; statuses: ThreadStatus[]; query: string };
