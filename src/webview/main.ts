/**
 * The comment sidebar's webview.
 *
 * Bundled with `platform: 'browser'`, so importing anything that reaches
 * `node:*` is a build error rather than a blank panel at runtime.
 *
 * Two rules hold this together:
 *  - The host owns the data. This renders `state` plus a pending overlay; it
 *    never edits its own copy of a card.
 *  - Rendering reconciles rather than replaces, so a textarea you are typing in
 *    is never torn out from under you by an unrelated push.
 */

import { countCards, filterCards, type Scope } from '../core/sidebar.js';
import type { HostMessage, InlineMode, ViewMessage } from '../core/sidebarProtocol.js';
import type { ThreadStatus } from '../core/types.js';
import { render, type Draft, type RenderModel } from './render.js';

interface VsCodeApi {
  postMessage(message: ViewMessage): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

export interface PersistedState {
  scope: Scope;
  statuses: ThreadStatus[];
  query: string;
  /** Unsent text, keyed by thread id for replies and draft id for new comments. */
  drafts: Record<string, string>;
}

const vscode = acquireVsCodeApi();

const initial = (window as unknown as { __mdreviewInitialView?: Partial<PersistedState> })
  .__mdreviewInitialView;

const persisted: PersistedState = {
  scope: 'document',
  statuses: ['open', 'answered', 'stale'],
  query: '',
  drafts: {},
  ...initial,
  ...vscode.getState(),
};

/** Everything the host has told us, plus the local view state layered on top. */
const model: RenderModel = {
  cards: [],
  documents: [],
  activeDoc: null,
  activeId: null,
  author: 'You',
  inlineThreads: 'collapsed' as InlineMode,
  selection: null,
  scope: persisted.scope,
  statuses: persisted.statuses,
  query: persisted.query,
  drafts: persisted.drafts,
  draft: null,
  pending: {},
  errors: {},
  expanded: null,
  searchOpen: Boolean(persisted.query),
  counts: countCards([]),
  visible: [],
  rev: 0,
};

const root = document.getElementById('root')!;

let opSeq = 0;
const nextOpId = (): string => `op_${++opSeq}`;

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

let saveTimer: number | undefined;
function persist(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    vscode.setState({
      scope: model.scope,
      statuses: model.statuses,
      query: model.query,
      drafts: model.drafts,
    });
  }, 300);
}

function pushViewState(): void {
  vscode.postMessage({
    type: 'viewState',
    scope: model.scope,
    statuses: model.statuses,
    query: model.query,
  });
}

/* ------------------------------------------------------------------ *
 * Derivation and paint
 * ------------------------------------------------------------------ */

function recompute(): void {
  model.visible = filterCards(
    model.cards,
    { statuses: model.statuses, scope: model.scope, query: model.query },
    model.activeDoc,
  );
  model.counts = countCards(model.cards);
}

function paint(): void {
  recompute();
  render(root, model, actions, Date.now());
}

/* ------------------------------------------------------------------ *
 * Actions the rendered DOM calls back into
 * ------------------------------------------------------------------ */

export interface Actions {
  reveal(id: string): void;
  setActive(id: string | null): void;
  toggleExpanded(id: string): void;
  reply(id: string, body: string): void;
  resolve(id: string): void;
  reopen(id: string): void;
  remove(id: string): void;
  reattach(id: string): void;
  startCompose(): void;
  submitDraft(body: string): void;
  cancelDraft(): void;
  setScope(scope: Scope): void;
  toggleStatus(status: ThreadStatus): void;
  setQuery(query: string): void;
  toggleSearch(): void;
  clearFilters(): void;
  openDocument(doc: string): void;
  sendToClaude(): void;
  saveDraftText(key: string, text: string): void;
  dismissError(id: string): void;
}

const actions: Actions = {
  reveal(id) {
    model.activeId = id;
    model.expanded = id;
    vscode.postMessage({ type: 'reveal', threadId: id });
    paint();
  },
  setActive(id) {
    model.activeId = id;
    vscode.postMessage({ type: 'setActive', threadId: id });
    paint();
  },
  toggleExpanded(id) {
    model.expanded = model.expanded === id ? null : id;
    paint();
  },
  reply(id, body) {
    const trimmed = body.trim();
    if (!trimmed) return;
    const opId = nextOpId();
    // Optimistic: show it immediately, dimmed, and let the ack settle it.
    model.pending[opId] = { kind: 'reply', threadId: id, body: trimmed };
    delete model.drafts[id];
    delete model.errors[id];
    vscode.postMessage({ type: 'reply', opId, threadId: id, body: trimmed });
    persist();
    paint();
  },
  resolve(id) {
    const opId = nextOpId();
    model.pending[opId] = { kind: 'status', threadId: id, status: 'resolved' };
    vscode.postMessage({ type: 'resolve', opId, threadId: id });
    paint();
  },
  reopen(id) {
    const opId = nextOpId();
    model.pending[opId] = { kind: 'status', threadId: id, status: 'open' };
    vscode.postMessage({ type: 'reopen', opId, threadId: id });
    paint();
  },
  remove(id) {
    // Deliberately not optimistic: the confirmation modal lives on the host,
    // and removing the card before the answer comes back would be a lie.
    const opId = nextOpId();
    model.pending[opId] = { kind: 'busy', threadId: id };
    vscode.postMessage({ type: 'delete', opId, threadId: id });
    paint();
  },
  reattach(id) {
    const opId = nextOpId();
    model.pending[opId] = { kind: 'busy', threadId: id };
    vscode.postMessage({ type: 'reattach', opId, threadId: id });
    paint();
  },
  startCompose() {
    vscode.postMessage({ type: 'startCompose' });
  },
  submitDraft(body) {
    const draft = model.draft;
    const trimmed = body.trim();
    if (!draft || !trimmed) return;
    const opId = nextOpId();
    model.pending[opId] = { kind: 'create', threadId: draft.draftId, body: trimmed };
    delete model.drafts[draft.draftId];
    vscode.postMessage({ type: 'createThread', opId, draftId: draft.draftId, body: trimmed });
    model.draft = null;
    persist();
    paint();
  },
  cancelDraft() {
    if (!model.draft) return;
    vscode.postMessage({ type: 'cancelDraft', draftId: model.draft.draftId });
    delete model.drafts[model.draft.draftId];
    model.draft = null;
    persist();
    paint();
  },
  setScope(scope) {
    model.scope = scope;
    persist();
    pushViewState();
    paint();
  },
  toggleStatus(status) {
    model.statuses = model.statuses.includes(status)
      ? model.statuses.filter((s) => s !== status)
      : [...model.statuses, status];
    persist();
    pushViewState();
    paint();
  },
  setQuery(query) {
    model.query = query;
    persist();
    pushViewState();
    paint();
  },
  toggleSearch() {
    model.searchOpen = !model.searchOpen;
    if (!model.searchOpen && model.query) actions.setQuery('');
    else paint();
  },
  clearFilters() {
    model.statuses = ['open', 'answered', 'resolved', 'stale'];
    model.query = '';
    model.searchOpen = false;
    persist();
    pushViewState();
    paint();
  },
  openDocument(doc) {
    vscode.postMessage({ type: 'openDocument', docRelPath: doc });
  },
  sendToClaude() {
    vscode.postMessage({ type: 'sendToClaude' });
  },
  saveDraftText(key, text) {
    if (text) model.drafts[key] = text;
    else delete model.drafts[key];
    persist();
  },
  dismissError(id) {
    delete model.errors[id];
    paint();
  },
};

/* ------------------------------------------------------------------ *
 * Host messages
 * ------------------------------------------------------------------ */

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const m = event.data;
  switch (m.type) {
    case 'state': {
      model.rev = m.rev;
      model.cards = m.cards;
      model.documents = m.documents;
      model.activeDoc = m.activeDoc;
      model.author = m.author;
      model.inlineThreads = m.config.inlineThreads;
      // Any pending op whose thread is now in the authoritative state has
      // landed; drop the overlay rather than trying to match on bodies.
      for (const [opId, p] of Object.entries(model.pending)) {
        if (p.kind === 'create') continue;
        const card = m.cards.find((c) => c.id === p.threadId);
        if (!card) delete model.pending[opId];
        else if (p.kind === 'reply' && card.messages.some((x) => x.body === p.body)) {
          delete model.pending[opId];
        } else if (p.kind === 'status' && card.status === p.status) {
          delete model.pending[opId];
        }
      }
      paint();
      return;
    }

    case 'positions': {
      // Stale push: a full state has already superseded it.
      if (m.rev < model.rev) return;
      model.rev = m.rev;
      model.activeDoc = m.activeDoc;
      model.selection = m.selection;
      for (const card of model.cards) {
        const a = m.anchors[card.id];
        if (!a) continue;
        card.anchor.line = a.line;
        card.anchor.attachment = a.attachment;
        card.canReattach = a.attachment === 'lost';
      }
      paint();
      return;
    }

    case 'active': {
      model.activeId = m.threadId;
      // Only follow the editor. Scrolling on our own click would yank the card
      // out from under the pointer.
      if (m.origin !== 'webview' && m.threadId) model.expanded = m.threadId;
      paint();
      if (m.origin !== 'webview' && m.threadId) scrollCardIntoView(m.threadId);
      return;
    }

    case 'compose': {
      const draft: Draft = {
        draftId: m.draftId,
        docRelPath: m.docRelPath,
        quote: m.quote,
        quoteTruncated: m.quoteTruncated,
        headingPath: m.headingPath,
        line: m.line,
        lost: false,
      };
      model.draft = draft;
      paint();
      focusComposer();
      return;
    }

    case 'draftLost': {
      if (model.draft?.draftId === m.draftId) {
        model.draft = { ...model.draft, lost: true, lostReason: m.reason };
      }
      paint();
      return;
    }

    case 'focusCard': {
      model.activeId = m.threadId;
      model.expanded = m.threadId;
      paint();
      scrollCardIntoView(m.threadId);
      if (m.mode === 'reply') focusReply(m.threadId);
      return;
    }

    case 'ack': {
      const pendingOp = model.pending[m.opId];
      delete model.pending[m.opId];
      if (!m.ok && pendingOp) {
        // 'cancelled' is the user dismissing the delete modal, not a failure.
        if (m.message && m.message !== 'cancelled') {
          model.errors[pendingOp.threadId] = m.message;
        }
        // Give a rejected reply its text back rather than losing what was typed.
        if (pendingOp.kind === 'reply') model.drafts[pendingOp.threadId] = pendingOp.body;
        persist();
      }
      paint();
      return;
    }
  }
});

function scrollCardIntoView(id: string): void {
  root.querySelector(`[data-card="${CSS.escape(id)}"]`)?.scrollIntoView({
    block: 'nearest',
    behavior: 'smooth',
  });
}

function focusComposer(): void {
  const el = root.querySelector<HTMLTextAreaElement>('[data-composer] textarea');
  el?.focus();
}

function focusReply(id: string): void {
  root
    .querySelector<HTMLTextAreaElement>(`[data-card="${CSS.escape(id)}"] textarea`)
    ?.focus();
}

/* ------------------------------------------------------------------ *
 * Keyboard
 * ------------------------------------------------------------------ */

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return el?.tagName === 'TEXTAREA' || el?.tagName === 'INPUT';
}

function move(delta: number): void {
  if (model.visible.length === 0) return;
  const i = model.visible.findIndex((c) => c.id === model.activeId);
  const next = model.visible[Math.max(0, Math.min(model.visible.length - 1, i + delta))];
  if (next) {
    actions.setActive(next.id);
    scrollCardIntoView(next.id);
  }
}

document.addEventListener('keydown', (e) => {
  if (isTyping(e.target)) return;
  const active = model.activeId;
  switch (e.key) {
    case 'ArrowDown':
    case 'j':
      e.preventDefault();
      move(1);
      return;
    case 'ArrowUp':
    case 'k':
      e.preventDefault();
      move(-1);
      return;
    case 'Enter':
      if (active) {
        e.preventDefault();
        actions.reveal(active);
      }
      return;
    case 'r':
      if (active) {
        e.preventDefault();
        model.expanded = active;
        paint();
        focusReply(active);
      }
      return;
    case '/':
      e.preventDefault();
      model.searchOpen = true;
      paint();
      root.querySelector<HTMLInputElement>('[data-search]')?.focus();
      return;
  }
});

vscode.postMessage({ type: 'ready', knownDraftIds: Object.keys(model.drafts) });
paint();
