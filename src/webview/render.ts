/**
 * DOM for the comment sidebar.
 *
 * Two constraints shape everything here:
 *
 *  - **No `innerHTML`, ever.** Comment bodies are written by another process
 *    into a JSON file on disk; this is the boundary where that text meets a
 *    DOM. Everything goes through `textContent`, and markdown is deliberately
 *    not rendered — shipping a parser for a two-line comment would buy a real
 *    XSS surface for very little.
 *
 *  - **Reconcile, never replace.** Cards are keyed by thread id and patched in
 *    place, and a card whose textarea has focus is left alone entirely. An
 *    unrelated push must not tear out the reply you are mid-way through typing.
 */

import { relativeTime, statusLabel, type CardVM, type Counts, type Scope } from '../core/sidebar.js';
import type { DocumentSummary, InlineMode, SelectionInfo } from '../core/sidebarProtocol.js';
import type { ThreadStatus } from '../core/types.js';
import type { Actions } from './main.js';

export interface Draft {
  draftId: string;
  docRelPath: string;
  quote: string;
  quoteTruncated: boolean;
  headingPath: string[];
  line: number | null;
  lost: boolean;
  lostReason?: string;
}

export type Pending =
  | { kind: 'reply'; threadId: string; body: string }
  | { kind: 'status'; threadId: string; status: ThreadStatus }
  | { kind: 'create'; threadId: string; body: string }
  | { kind: 'busy'; threadId: string };

export interface RenderModel {
  cards: CardVM[];
  documents: DocumentSummary[];
  activeDoc: string | null;
  activeId: string | null;
  author: string;
  inlineThreads: InlineMode;
  selection: SelectionInfo | null;
  scope: Scope;
  statuses: ThreadStatus[];
  query: string;
  drafts: Record<string, string>;
  draft: Draft | null;
  pending: Record<string, Pending>;
  errors: Record<string, string>;
  expanded: string | null;
  searchOpen: boolean;
  counts: Counts;
  visible: CardVM[];
  rev: number;
}

const STATUS_ORDER: ThreadStatus[] = ['open', 'answered', 'stale', 'resolved'];
const STATUS_CHIP: Record<ThreadStatus, string> = {
  open: 'Open',
  answered: 'Answered',
  stale: 'Stale',
  resolved: 'Resolved',
};

/* ------------------------------------------------------------------ *
 * Tiny DOM helpers
 * ------------------------------------------------------------------ */

type Props = {
  class?: string;
  text?: string;
  title?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  tabIndex?: number;
  role?: string;
  ariaPressed?: string;
  ariaLabel?: string;
  dataset?: Record<string, string>;
  onClick?: (e: MouseEvent) => void;
  onInput?: (e: Event) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  onFocus?: () => void;
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: (Node | string | null | false)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  if (props.role) node.setAttribute('role', props.role);
  if (props.ariaPressed) node.setAttribute('aria-pressed', props.ariaPressed);
  if (props.ariaLabel) node.setAttribute('aria-label', props.ariaLabel);
  if (props.tabIndex !== undefined) node.tabIndex = props.tabIndex;
  if (props.dataset) for (const [k, v] of Object.entries(props.dataset)) node.dataset[k] = v;

  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
    if (props.type && node instanceof HTMLInputElement) node.type = props.type;
    if (props.value !== undefined) node.value = props.value;
    if (props.placeholder) node.placeholder = props.placeholder;
    if (props.rows && node instanceof HTMLTextAreaElement) node.rows = props.rows;
  }
  if (node instanceof HTMLButtonElement && props.disabled) node.disabled = true;

  if (props.onClick) node.addEventListener('click', props.onClick as EventListener);
  if (props.onInput) node.addEventListener('input', props.onInput);
  if (props.onKeyDown) node.addEventListener('keydown', props.onKeyDown as EventListener);
  if (props.onFocus) node.addEventListener('focus', props.onFocus);

  for (const c of children) {
    if (c === null || c === false) continue;
    node.append(c);
  }
  return node;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export function render(root: HTMLElement, model: RenderModel, actions: Actions, now: number): void {
  let shell = root.querySelector<HTMLDivElement>('.shell');
  if (!shell) {
    shell = el('div', { class: 'shell' }, [
      el('div', { class: 'header', dataset: { header: '' } }),
      el('div', { class: 'list', dataset: { list: '' } }),
    ]);
    root.append(shell);
  }

  renderHeader(shell.querySelector('[data-header]')!, model, actions);
  renderList(shell.querySelector('[data-list]')!, model, actions, now);
}

/* ------------------------------------------------------------------ *
 * Header
 * ------------------------------------------------------------------ */

function renderHeader(host: HTMLElement, model: RenderModel, actions: Actions): void {
  const rows: (Node | null)[] = [
    el('div', { class: 'row' }, [
      el('div', { class: 'segmented', role: 'group', ariaLabel: 'Scope' }, [
        segButton('This document', model.scope === 'document', () => actions.setScope('document')),
        segButton('All', model.scope === 'workspace', () => actions.setScope('workspace')),
      ]),
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'icon',
        text: '⌕',
        title: 'Search comments (/)',
        ariaPressed: String(model.searchOpen),
        onClick: () => actions.toggleSearch(),
      }),
      el('button', {
        class: 'icon',
        text: '+',
        title: 'Comment on the selection (Ctrl+Alt+M)',
        onClick: () => actions.startCompose(),
      }),
    ]),

    el(
      'div',
      { class: 'row chips' },
      STATUS_ORDER.map((s) =>
        el('button', {
          class: `chip chip-${s}`,
          text: STATUS_CHIP[s],
          ariaPressed: String(model.statuses.includes(s)),
          onClick: () => actions.toggleStatus(s),
        }),
      ),
    ),

    model.searchOpen
      ? el('div', { class: 'row' }, [
          el('input', {
            class: 'search',
            type: 'text',
            value: model.query,
            placeholder: 'Filter comments…',
            dataset: { search: '' },
            onInput: (e) => actions.setQuery((e.target as HTMLInputElement).value),
            onKeyDown: (e) => {
              if (e.key === 'Escape') actions.toggleSearch();
            },
          }),
        ])
      : null,

    model.counts.needsAttention > 0
      ? el('div', { class: 'row' }, [
          el('button', {
            class: 'primary wide',
            text: `Send ${model.counts.needsAttention} to Claude`,
            onClick: () => actions.sendToClaude(),
          }),
        ])
      : null,
  ];
  host.replaceChildren(...rows.filter((r): r is Node => r !== null));
}

function segButton(label: string, on: boolean, onClick: () => void): HTMLElement {
  return el('button', { class: 'seg', text: label, ariaPressed: String(on), onClick });
}

/* ------------------------------------------------------------------ *
 * List
 * ------------------------------------------------------------------ */

function renderList(host: HTMLElement, model: RenderModel, actions: Actions, now: number): void {
  const composer = model.draft ? renderComposer(model, actions) : null;

  if (model.visible.length === 0) {
    const children: Node[] = composer ? [composer] : [];
    children.push(emptyState(model, actions));
    host.replaceChildren(...children);
    return;
  }

  // Never rebuild the card the user is typing in.
  const typing = document.activeElement;
  const typingCard =
    typing instanceof HTMLTextAreaElement ? typing.closest<HTMLElement>('[data-card]') : null;

  const existing = new Map<string, HTMLElement>();
  for (const node of Array.from(host.querySelectorAll<HTMLElement>('[data-card]'))) {
    if (node.dataset.card) existing.set(node.dataset.card, node);
  }

  const children: Node[] = [];
  if (composer) children.push(composer);

  for (const card of model.visible) {
    const previous = existing.get(card.id);
    if (previous && previous === typingCard) {
      children.push(previous);
      continue;
    }
    const signature = cardSignature(card, model);
    if (previous && previous.dataset.sig === signature) {
      children.push(previous);
      continue;
    }
    children.push(renderCard(card, model, actions, now, signature));
  }

  host.replaceChildren(...children);
}

/**
 * Everything that affects a card's rendering. Cards whose signature is unchanged
 * are reused untouched, which is what keeps a `positions` push at typing speed
 * from rebuilding the whole list.
 */
function cardSignature(card: CardVM, model: RenderModel): string {
  const pending = Object.values(model.pending).filter((p) => p.threadId === card.id);
  return JSON.stringify([
    card.status,
    card.updatedAt,
    card.messageCount,
    card.anchor.line,
    card.anchor.attachment,
    card.anchor.currentQuote ?? null,
    model.activeId === card.id,
    model.expanded === card.id,
    model.drafts[card.id] ?? '',
    model.errors[card.id] ?? '',
    model.selection?.docRelPath === card.docRelPath && model.selection?.empty === false,
    pending.map((p) => p.kind),
    model.scope,
  ]);
}

/* ------------------------------------------------------------------ *
 * Card
 * ------------------------------------------------------------------ */

function renderCard(
  card: CardVM,
  model: RenderModel,
  actions: Actions,
  now: number,
  signature: string,
): HTMLElement {
  const isActive = model.activeId === card.id;
  const isOpen = model.expanded === card.id || isActive;
  const pending = Object.values(model.pending).filter((p) => p.threadId === card.id);
  const busy = pending.length > 0;
  const optimistic = pending.find((p) => p.kind === 'reply');

  const node = el('div', {
    class: [
      'card',
      `status-${card.status}`,
      isActive ? 'active' : '',
      isOpen ? 'open' : 'compact',
      busy ? 'busy' : '',
    ]
      .filter(Boolean)
      .join(' '),
    tabIndex: 0,
    dataset: { card: card.id, sig: signature },
    onClick: (e) => {
      if ((e.target as HTMLElement).closest('button, textarea, input')) return;
      actions.reveal(card.id);
    },
    onFocus: () => {
      if (model.activeId !== card.id) actions.setActive(card.id);
    },
  });

  /* header line */
  node.append(
    el('div', { class: 'card-head' }, [
      el('span', { class: 'dot' }),
      el('span', { class: 'status', text: card.statusLabel }),
      el('span', { class: 'spacer' }),
      card.anchor.line !== null
        ? el('span', { class: 'muted', text: `L${card.anchor.line}` })
        : null,
      el('span', { class: 'muted', text: relativeTime(card.updatedAt, now) }),
    ]),
  );

  /* breadcrumb — the document only matters when several are in view */
  const trail =
    model.scope === 'workspace'
      ? `${card.docRelPath} › ${card.anchor.headingLabel}`
      : card.anchor.headingLabel;
  node.append(el('div', { class: 'trail', text: trail, title: card.anchor.headingPath.join(' › ') }));

  /* the passage */
  node.append(el('blockquote', { class: 'quote', text: card.anchor.quote }));

  if (card.anchor.attachment === 'drifted') {
    node.append(
      el('div', { class: 'note drift' }, [
        el('span', { text: 'Text edited since you commented' }),
        card.anchor.currentQuote
          ? el('blockquote', { class: 'quote current', text: card.anchor.currentQuote })
          : null,
      ]),
    );
  }

  if (card.anchor.attachment === 'lost') {
    node.append(renderLost(card, model, actions));
  }

  /* messages */
  const messages = isOpen ? card.messages : card.messages.slice(0, 1);
  for (const m of messages) {
    node.append(
      el('div', { class: `msg ${m.author}` }, [
        el('div', { class: 'msg-head' }, [
          el('span', { class: 'who', text: m.author === 'claude' ? 'Claude' : m.authorName }),
          el('span', { class: 'muted', text: relativeTime(m.ts, now) }),
        ]),
        el('div', { class: 'body', text: m.body }),
      ]),
    );
  }
  if (!isOpen && card.messageCount > 1) {
    node.append(el('div', { class: 'more', text: `${card.messageCount - 1} more` }));
  }
  if (optimistic && optimistic.kind === 'reply') {
    node.append(
      el('div', { class: 'msg user pending' }, [
        el('div', { class: 'msg-head' }, [
          el('span', { class: 'who', text: model.author }),
          el('span', { class: 'muted', text: 'sending…' }),
        ]),
        el('div', { class: 'body', text: optimistic.body }),
      ]),
    );
  }

  if (model.errors[card.id]) {
    node.append(
      el('div', { class: 'note error' }, [
        el('span', { text: model.errors[card.id] }),
        el('button', {
          class: 'link',
          text: 'Dismiss',
          onClick: () => actions.dismissError(card.id),
        }),
      ]),
    );
  }

  /* reply + actions, on the open card only */
  if (isOpen) {
    if (card.canReply) {
      const box = el('textarea', {
        class: 'reply',
        rows: 2,
        value: model.drafts[card.id] ?? '',
        placeholder: 'Reply…',
        onInput: (e) => actions.saveDraftText(card.id, (e.target as HTMLTextAreaElement).value),
        onKeyDown: (e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            actions.reply(card.id, (e.target as HTMLTextAreaElement).value);
          } else if (e.key === 'Escape') {
            (e.target as HTMLTextAreaElement).blur();
          }
        },
      });
      node.append(box);
      node.append(
        el('div', { class: 'actions' }, [
          el('button', {
            class: 'primary',
            text: 'Reply',
            disabled: busy,
            onClick: () => actions.reply(card.id, box.value),
          }),
          card.canResolve
            ? el('button', {
                text: 'Resolve',
                disabled: busy,
                onClick: () => actions.resolve(card.id),
              })
            : null,
          el('span', { class: 'spacer' }),
          el('button', {
            class: 'link danger',
            text: 'Delete',
            disabled: busy,
            onClick: () => actions.remove(card.id),
          }),
        ]),
      );
    } else {
      node.append(
        el('div', { class: 'actions' }, [
          card.canReopen
            ? el('button', {
                text: 'Reopen',
                disabled: busy,
                onClick: () => actions.reopen(card.id),
              })
            : null,
          el('span', { class: 'spacer' }),
          el('button', {
            class: 'link danger',
            text: 'Delete',
            disabled: busy,
            onClick: () => actions.remove(card.id),
          }),
        ]),
      );
    }
  }

  return node;
}

/**
 * The stale affordance. Re-attach is enabled only when the editor genuinely has
 * a selection in this card's document — which is why `positions` reports the
 * selection at all. The alternative is a button that looks live and answers
 * with a warning toast after the fact.
 */
function renderLost(card: CardVM, model: RenderModel, actions: Actions): HTMLElement {
  const ready =
    model.selection?.docRelPath === card.docRelPath && model.selection?.empty === false;
  return el('div', { class: 'note lost' }, [
    el('span', { text: 'The text this pointed at is gone. Its history is kept.' }),
    el('div', { class: 'actions' }, [
      el('button', {
        text: 'Re-attach to selection',
        disabled: !ready,
        title: ready
          ? 'Point this comment at the selected text'
          : 'Select the text this comment should point at first',
        onClick: () => actions.reattach(card.id),
      }),
    ]),
  ]);
}

/* ------------------------------------------------------------------ *
 * Composer
 * ------------------------------------------------------------------ */

function renderComposer(model: RenderModel, actions: Actions): HTMLElement {
  const draft = model.draft!;
  const box = el('textarea', {
    class: 'reply',
    rows: 3,
    value: model.drafts[draft.draftId] ?? '',
    placeholder: 'What should change here?',
    onInput: (e) => actions.saveDraftText(draft.draftId, (e.target as HTMLTextAreaElement).value),
    onKeyDown: (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        actions.submitDraft((e.target as HTMLTextAreaElement).value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        actions.cancelDraft();
      }
    },
  });

  return el('div', { class: 'card composing', dataset: { composer: '' } }, [
    el('div', { class: 'card-head' }, [
      el('span', { class: 'status', text: 'New comment' }),
      el('span', { class: 'spacer' }),
      draft.line !== null ? el('span', { class: 'muted', text: `L${draft.line}` }) : null,
    ]),
    el('div', {
      class: 'trail',
      text:
        draft.headingPath[draft.headingPath.length - 1] ??
        (draft.docRelPath || '(document root)'),
    }),
    el('blockquote', { class: 'quote', text: draft.quote }),
    draft.lost
      ? el('div', {
          class: 'note error',
          text: draft.lostReason ?? 'This draft lost the passage it pointed at.',
        })
      : null,
    box,
    el('div', { class: 'actions' }, [
      el('button', {
        class: 'primary',
        text: 'Comment',
        disabled: draft.lost,
        onClick: () => actions.submitDraft(box.value),
      }),
      el('button', { text: 'Cancel', onClick: () => actions.cancelDraft() }),
    ]),
  ]);
}

/* ------------------------------------------------------------------ *
 * Empty states
 * ------------------------------------------------------------------ */

function emptyState(model: RenderModel, actions: Actions): HTMLElement {
  const total = model.counts.total;
  const hiddenByFilter = total > 0;

  if (total === 0) {
    return el('div', { class: 'empty' }, [
      el('p', { text: 'No comments yet.' }),
      el('p', {
        class: 'muted',
        text: 'Select a passage in a markdown file and press Ctrl+Alt+M.',
      }),
    ]);
  }

  if (model.scope === 'document' && model.activeDoc === null) {
    return el('div', { class: 'empty' }, [
      el('p', { text: 'No markdown file is open.' }),
      el('button', {
        class: 'link',
        text: `Show all ${total} comments`,
        onClick: () => actions.setScope('workspace'),
      }),
    ]);
  }

  if (model.scope === 'document') {
    return el('div', { class: 'empty' }, [
      el('p', { text: `No comments on ${model.activeDoc}.` }),
      el('button', {
        class: 'link',
        text: `Show all ${total} comments`,
        onClick: () => actions.setScope('workspace'),
      }),
    ]);
  }

  return el('div', { class: 'empty' }, [
    el('p', { text: hiddenByFilter ? `${total} comments hidden by filters.` : 'Nothing to show.' }),
    el('button', { class: 'link', text: 'Clear filters', onClick: () => actions.clearFilters() }),
  ]);
}

export { statusLabel };
