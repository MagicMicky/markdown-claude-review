import * as vscode from 'vscode';
import { buildAnchor } from '../core/anchor.js';
import { appendMessage, makeMessage, newThread, setStatus } from '../core/store.js';
import type { Thread, ThreadStatus } from '../core/types.js';
import type { DocState, Session } from './session.js';

const STATUS_LABEL: Record<ThreadStatus, string> = {
  open: 'Open · waiting on Claude',
  answered: 'Claude replied · waiting on you',
  resolved: 'Resolved',
  stale: 'Stale · original text is gone',
};

const commentedRange = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
  borderColor: new vscode.ThemeColor('editorInfo.foreground'),
  borderStyle: 'none none dotted none',
  borderWidth: '1px',
  overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
  overviewRulerLane: vscode.OverviewRulerLane.Right,
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

/** Bridges Session state onto VS Code's native comment threads. */
export class CommentUI implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  /** docRelPath -> threadId -> live VS Code thread. */
  private readonly views = new Map<string, Map<string, vscode.CommentThread>>();
  private readonly ids = new WeakMap<vscode.CommentThread, string>();
  private disposables: vscode.Disposable[] = [];
  private debounce?: NodeJS.Timeout;

  constructor(private readonly session: Session) {
    this.controller = vscode.comments.createCommentController('mdreview', 'Markdown Review');
    this.controller.options = {
      prompt: 'Comment on this passage…',
      placeHolder: 'What should change here?',
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        if (document.languageId !== 'markdown') return [];
        if (!this.session.docRelPath(document.uri)) return [];
        return [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)];
      },
    };
    this.disposables.push(this.controller);

    this.disposables.push(
      this.session.onDidChange((doc) => this.sync(doc)),
      vscode.workspace.onDidSaveTextDocument(async (d) => {
        const rel = this.session.docRelPath(d.uri);
        if (rel && d.languageId === 'markdown') await this.session.refresh(rel);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId !== 'markdown' || e.contentChanges.length === 0) return;
        const rel = this.session.docRelPath(e.document.uri);
        if (!rel || !this.session.get(rel)) return;
        // Keep ranges honest while typing, but do not persist status churn.
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          const state = this.session.get(rel);
          if (!state) return;
          this.session.reanchor(state, e.document.getText());
          this.sync(rel);
        }, 500);
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
    );
  }

  /* ---------------- rendering ---------------- */

  private uriFor(docRelPath: string): vscode.Uri {
    return vscode.Uri.joinPath(vscode.Uri.file(this.session.root), ...docRelPath.split('/'));
  }

  private rangeFor(state: DocState, thread: Thread, doc?: vscode.TextDocument): vscode.Range {
    const hit = state.resolved.get(thread.id);
    if (!hit || !doc) return new vscode.Range(0, 0, 0, 0);
    return new vscode.Range(doc.positionAt(hit.start), doc.positionAt(hit.end));
  }

  private toComments(thread: Thread): vscode.Comment[] {
    return thread.messages.map((m) => ({
      body: new vscode.MarkdownString(m.body),
      mode: vscode.CommentMode.Preview,
      author: {
        name: m.author === 'claude' ? 'Claude' : m.authorName,
        iconPath:
          m.author === 'claude'
            ? vscode.Uri.parse('https://www.anthropic.com/favicon.ico')
            : undefined,
      },
      timestamp: new Date(m.ts),
      contextValue: m.author,
    }));
  }

  /** Rebuild the VS Code threads for one document (or all of them). */
  sync(docRelPath?: string): void {
    if (docRelPath === undefined) {
      for (const d of this.session.all()) this.sync(d.docRelPath);
      return;
    }
    const state = this.session.get(docRelPath);
    const uri = this.uriFor(docRelPath);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    let views = this.views.get(docRelPath);
    if (!views) {
      views = new Map();
      this.views.set(docRelPath, views);
    }

    const live = new Set<string>();
    for (const t of state?.file.threads ?? []) {
      live.add(t.id);
      let view = views.get(t.id);
      if (!view) {
        view = this.controller.createCommentThread(uri, this.rangeFor(state!, t, doc), []);
        views.set(t.id, view);
        this.ids.set(view, t.id);
      } else {
        view.range = this.rangeFor(state!, t, doc);
      }
      view.comments = this.toComments(t);
      view.label = STATUS_LABEL[t.status];
      view.contextValue = t.status;
      view.canReply = t.status !== 'resolved';
      view.state =
        t.status === 'resolved'
          ? vscode.CommentThreadState.Resolved
          : vscode.CommentThreadState.Unresolved;
      view.collapsibleState =
        t.status === 'resolved'
          ? vscode.CommentThreadCollapsibleState.Collapsed
          : vscode.CommentThreadCollapsibleState.Expanded;
    }

    for (const [id, view] of views) {
      if (!live.has(id)) {
        view.dispose();
        views.delete(id);
      }
    }
    this.decorate();
  }

  private decorate(): void {
    const on = vscode.workspace.getConfiguration('mdreview').get('highlightCommentedRanges', true);
    for (const editor of vscode.window.visibleTextEditors) {
      const rel = this.session.docRelPath(editor.document.uri);
      const state = rel ? this.session.get(rel) : undefined;
      if (!on || !state) {
        editor.setDecorations(commentedRange, []);
        continue;
      }
      const ranges: vscode.DecorationOptions[] = [];
      for (const t of state.file.threads) {
        if (t.status === 'resolved') continue;
        const hit = state.resolved.get(t.id);
        if (!hit) continue;
        ranges.push({
          range: new vscode.Range(
            editor.document.positionAt(hit.start),
            editor.document.positionAt(hit.end),
          ),
          hoverMessage: new vscode.MarkdownString(
            `**${STATUS_LABEL[t.status]}** — ${t.messages.length} message(s)`,
          ),
        });
      }
      editor.setDecorations(commentedRange, ranges);
    }
  }

  /* ---------------- mutations ---------------- */

  threadIdOf(view: vscode.CommentThread): string | undefined {
    return this.ids.get(view);
  }

  /** Turn the empty thread VS Code opened at the gutter into a persisted one. */
  async create(reply: vscode.CommentReply): Promise<void> {
    const view = reply.thread;
    const body = reply.text.trim();
    if (!body) return;
    const doc = await vscode.workspace.openTextDocument(view.uri);
    const rel = this.session.docRelPath(view.uri);
    if (!rel) return;

    // range is undefined for a thread with no anchor yet; the gutter click line
    // is the sensible fallback, as is the whole line when nothing was selected.
    const active = vscode.window.activeTextEditor;
    let range = view.range ?? active?.selection ?? new vscode.Range(0, 0, 0, 0);
    if (range.isEmpty) range = doc.lineAt(range.start.line).range;
    const text = doc.getText();
    const anchor = buildAnchor(text, doc.offsetAt(range.start), doc.offsetAt(range.end));
    const thread = newThread(anchor, makeMessage('user', this.session.author, body));

    // Drop the ephemeral thread; sync() creates the managed one in its place.
    view.dispose();
    await this.session.update(rel, (state) => {
      state.file.threads.push(thread);
    });
  }

  async reply(reply: vscode.CommentReply, author: 'user' | 'claude' = 'user'): Promise<void> {
    const id = this.threadIdOf(reply.thread);
    const body = reply.text.trim();
    if (!id || !body) return;
    const found = this.session.findThread(id);
    if (!found) return;
    await this.session.update(found.state.docRelPath, () => {
      appendMessage(found.thread, makeMessage(author, this.session.author, body));
    });
  }

  async setStatus(id: string, status: ThreadStatus): Promise<void> {
    const found = this.session.findThread(id);
    if (!found) return;
    await this.session.update(found.state.docRelPath, () => setStatus(found.thread, status));
  }

  async remove(id: string): Promise<void> {
    const found = this.session.findThread(id);
    if (!found) return;
    await this.session.update(found.state.docRelPath, (state) => {
      state.file.threads = state.file.threads.filter((t) => t.id !== id);
    });
  }

  /** Point a stale thread at freshly selected text, keeping its whole history. */
  async reattach(id: string, editor: vscode.TextEditor): Promise<boolean> {
    const found = this.session.findThread(id);
    if (!found || editor.selection.isEmpty) return false;
    const doc = editor.document;
    const rel = this.session.docRelPath(doc.uri);
    if (!rel || rel !== found.state.docRelPath) return false;
    const text = doc.getText();
    const anchor = buildAnchor(
      text,
      doc.offsetAt(editor.selection.start),
      doc.offsetAt(editor.selection.end),
    );
    await this.session.update(rel, () => {
      found.thread.anchor = anchor;
      delete found.thread.driftedAt;
      found.thread.status =
        found.thread.messages[found.thread.messages.length - 1]?.author === 'claude'
          ? 'answered'
          : 'open';
    });
    return true;
  }

  async reveal(id: string): Promise<void> {
    const found = this.session.findThread(id);
    if (!found) return;
    const uri = this.uriFor(found.state.docRelPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const hit = found.state.resolved.get(id);
    if (hit) {
      const range = new vscode.Range(doc.positionAt(hit.start), doc.positionAt(hit.end));
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
    const view = this.views.get(found.state.docRelPath)?.get(id);
    if (view) view.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  dispose(): void {
    clearTimeout(this.debounce);
    for (const views of this.views.values()) for (const v of views.values()) v.dispose();
    commentedRange.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
