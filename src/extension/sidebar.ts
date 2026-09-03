import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import {
  buildCards,
  countCards,
  truncateQuote,
  type AnchorHit,
  type CardVM,
  type Scope,
} from '../core/sidebar.js';
import type {
  DocumentSummary,
  HostMessage,
  SelectionInfo,
  ViewMessage,
} from '../core/sidebarProtocol.js';
import type { ThreadStatus } from '../core/types.js';
import type { ReviewActions } from './actions.js';
import type { FocusTracker } from './focus.js';
import type { Session } from './session.js';
import { defaultScope, inlineMode, showResolvedByDefault } from './config.js';

const VIEW_STATE_KEY = 'mdreview.sidebar.viewState';

interface PersistedViewState {
  scope: Scope;
  statuses: ThreadStatus[];
  query: string;
}

/**
 * The comment sidebar.
 *
 * Docs-style bubbles, and the primary surface for reading and replying. It
 * holds no authoritative state: it renders what `Session` publishes and posts
 * commands back, which is what makes it impossible for it to drift out of sync
 * with the inline threads.
 */
export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'mdreview.comments';

  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private rev = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly session: Session,
    private readonly actions: ReviewActions,
    private readonly focus: FocusTracker,
    private readonly memento: vscode.Memento,
  ) {
    this.disposables.push(
      session.onDidChange(() => this.pushState()),
      session.onDidReanchor(() => this.pushPositions()),
      focus.onDidChangeActive((a) =>
        this.post({ type: 'active', threadId: a.threadId, origin: a.origin }),
      ),
      vscode.window.onDidChangeActiveTextEditor(() => this.pushState()),
      // Drives whether the Re-attach button is enabled, so it cannot be a
      // coin flip the way the old warning-toast-after-the-fact path was.
      vscode.window.onDidChangeTextEditorSelection(() => this.pushPositions()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('mdreview')) this.pushState();
      }),
    );
  }

  /* ---------------- view state ---------------- */

  private viewState(): PersistedViewState {
    const stored = this.memento.get<PersistedViewState>(VIEW_STATE_KEY);
    if (stored) return stored;
    const statuses: ThreadStatus[] = ['open', 'answered', 'stale'];
    if (showResolvedByDefault()) statuses.push('resolved');
    return { scope: defaultScope(), statuses, query: '' };
  }

  /* ---------------- projection ---------------- */

  private activeDoc(): string | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'markdown') return null;
    return this.session.docRelPath(editor.document.uri) ?? null;
  }

  private openDoc(docRelPath: string): vscode.TextDocument | undefined {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(this.session.root), ...docRelPath.split('/'));
    return vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  }

  /**
   * Resolved anchors for one document, with a line number when the document is
   * open. Closed documents get `line: null` rather than a filesystem read per
   * thread per render.
   */
  private hitsFor(docRelPath: string): Map<string, AnchorHit> {
    const state = this.session.get(docRelPath);
    const out = new Map<string, AnchorHit>();
    if (!state) return out;
    const doc = this.openDoc(docRelPath);
    for (const t of state.file.threads) {
      const hit = state.resolved.get(t.id);
      if (!hit) continue;
      out.set(t.id, {
        ...hit,
        line: doc ? doc.positionAt(hit.start).line + 1 : null,
        currentText: doc ? doc.getText().slice(hit.start, hit.end) : undefined,
      });
    }
    return out;
  }

  private allCards(): { cards: CardVM[]; documents: DocumentSummary[] } {
    const cards: CardVM[] = [];
    const documents: DocumentSummary[] = [];
    for (const d of this.session.all()) {
      if (d.file.threads.length === 0) continue;
      const forDoc = buildCards(d.docRelPath, d.file.threads, this.hitsFor(d.docRelPath));
      cards.push(...forDoc);
      documents.push({ docRelPath: d.docRelPath, counts: countCards(forDoc) });
    }
    return { cards, documents };
  }

  private selectionInfo(): SelectionInfo | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'markdown') return null;
    const rel = this.session.docRelPath(editor.document.uri);
    if (!rel) return null;
    return { docRelPath: rel, empty: editor.selection.isEmpty };
  }

  /* ---------------- pushes ---------------- */

  private post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  pushState(): void {
    if (!this.view) return;
    const { cards, documents } = this.allCards();
    const counts = countCards(cards);

    this.post({
      type: 'state',
      rev: ++this.rev,
      author: this.session.author,
      activeDoc: this.activeDoc(),
      documents,
      cards,
      counts,
      config: { inlineThreads: inlineMode() },
    });

    this.view.badge =
      counts.needsAttention > 0
        ? {
            value: counts.needsAttention,
            tooltip: `${counts.needsAttention} comment${counts.needsAttention === 1 ? '' : 's'} need you`,
          }
        : undefined;
    this.view.description = counts.total === 0 ? undefined : `${counts.needsAttention} open`;
  }

  /** Positions only. Runs at typing speed, so it must stay cheap. */
  pushPositions(): void {
    if (!this.view) return;
    const anchors: Record<string, { line: number | null; attachment: 'exact' | 'drifted' | 'lost' }> =
      {};
    for (const d of this.session.all()) {
      const hits = this.hitsFor(d.docRelPath);
      for (const t of d.file.threads) {
        const hit = hits.get(t.id);
        anchors[t.id] = hit
          ? { line: hit.line, attachment: hit.kind }
          : { line: null, attachment: 'lost' };
      }
    }
    this.post({
      type: 'positions',
      rev: ++this.rev,
      activeDoc: this.activeDoc(),
      anchors,
      selection: this.selectionInfo(),
    });
  }

  /** Open the composer for the editor's current selection. */
  async compose(editor: vscode.TextEditor): Promise<void> {
    const draft = this.actions.beginCompose(editor);
    if (!draft) {
      vscode.window.showWarningMessage('Open a markdown file in this workspace to comment on it.');
      return;
    }
    await vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`);
    const { text, truncated } = truncateQuote(draft.anchor.quote);
    this.post({
      type: 'compose',
      draftId: draft.draftId,
      docRelPath: draft.docRelPath,
      quote: text,
      quoteTruncated: truncated,
      headingPath: draft.anchor.headingPath,
      line: draft.line,
    });
  }

  focusCard(threadId: string, mode: 'view' | 'reply' = 'view'): void {
    this.post({ type: 'focusCard', threadId, mode });
  }

  /* ---------------- webview lifecycle ---------------- */

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'media'),
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
      ],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: ViewMessage) => this.handle(m));
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'),
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'sidebar.css'),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    const initial = JSON.stringify(this.viewState());

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Comments</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">window.__mdreviewInitialView = ${initial};</script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  /* ---------------- inbound ---------------- */

  private ack(opId: string, ok: boolean, message = ''): void {
    this.post(ok ? { type: 'ack', opId, ok: true } : { type: 'ack', opId, ok: false, message });
  }

  private markdownEditor(): vscode.TextEditor | undefined {
    const editor = vscode.window.activeTextEditor;
    return editor?.document.languageId === 'markdown' ? editor : undefined;
  }

  private async handle(m: ViewMessage): Promise<void> {
    switch (m.type) {
      case 'ready': {
        this.pushState();
        this.pushPositions();
        // Drafts live in memory, so a reloaded host no longer holds them. Say
        // so rather than letting the webview submit into a void.
        for (const id of m.knownDraftIds) {
          if (!this.actions.hasDraft(id)) {
            this.post({
              type: 'draftLost',
              draftId: id,
              reason: 'The editor restarted, so this draft lost the passage it pointed at.',
            });
          }
        }
        return;
      }

      case 'reveal':
        this.focus.setActive(m.threadId, 'webview');
        await this.actions.reveal(m.threadId);
        return;

      case 'setActive':
        this.focus.setActive(m.threadId, 'webview');
        return;

      case 'reply':
        await this.actions.reply(m.threadId, m.body);
        this.ack(m.opId, true);
        return;

      case 'resolve':
        await this.actions.setStatus(m.threadId, 'resolved');
        this.ack(m.opId, true);
        return;

      case 'reopen':
        await this.actions.setStatus(m.threadId, 'open');
        this.ack(m.opId, true);
        return;

      case 'delete': {
        const removed = await this.actions.remove(m.threadId);
        this.ack(m.opId, removed, removed ? '' : 'cancelled');
        return;
      }

      case 'reattach': {
        const editor = this.markdownEditor();
        if (!editor || editor.selection.isEmpty) {
          this.ack(m.opId, false, 'Select the text this comment should point at first.');
          return;
        }
        const ok = await this.actions.reattach(m.threadId, editor);
        this.ack(
          m.opId,
          ok,
          ok ? '' : 'That selection is in a different document from the comment.',
        );
        return;
      }

      case 'startCompose': {
        const editor = this.markdownEditor();
        if (!editor) {
          vscode.window.showWarningMessage('Open a markdown file to add a comment.');
          return;
        }
        await this.compose(editor);
        return;
      }

      case 'createThread': {
        const id = await this.actions.commitDraft(m.draftId, m.body);
        this.ack(m.opId, Boolean(id), id ? '' : 'This draft lost the passage it pointed at.');
        return;
      }

      case 'cancelDraft':
        this.actions.cancelDraft(m.draftId);
        return;

      case 'openDocument': {
        const uri = vscode.Uri.joinPath(
          vscode.Uri.file(this.session.root),
          ...m.docRelPath.split('/'),
        );
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
          preview: false,
        });
        return;
      }

      case 'sendToClaude':
        await vscode.commands.executeCommand('mdreview.sendToClaude');
        return;

      case 'refresh':
        await vscode.commands.executeCommand('mdreview.refresh');
        return;

      case 'viewState':
        await this.memento.update(VIEW_STATE_KEY, {
          scope: m.scope,
          statuses: m.statuses,
          query: m.query,
        } satisfies PersistedViewState);
        return;
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
