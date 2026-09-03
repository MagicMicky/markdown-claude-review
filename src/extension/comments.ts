import * as vscode from 'vscode';
import { statusLabel } from '../core/sidebar.js';
import type { Thread } from '../core/types.js';
import type { ReviewActions, InlineLayer } from './actions.js';
import type { DocState, Session } from './session.js';
import { inlineMode } from './config.js';

/**
 * The native in-editor comment threads.
 *
 * A pure projection of `Session`: it renders threads and adapts VS Code's reply
 * widget onto `ReviewActions`, but owns no state and no mutation logic of its
 * own. That separation is what lets `mdreview.inlineThreads: 'off'` dispose this
 * entire layer without taking any command with it.
 */
export class CommentUI implements vscode.Disposable, InlineLayer {
  private readonly controller: vscode.CommentController;
  /** docRelPath -> threadId -> live widget. */
  private readonly views = new Map<string, Map<string, vscode.CommentThread>>();
  private readonly ids = new WeakMap<vscode.CommentThread, string>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly session: Session,
    private readonly actions: ReviewActions,
  ) {
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
    this.disposables.push(
      this.controller,
      this.session.onDidChange((doc) => this.sync(doc)),
      // Positions moved; bodies did not. Move the widgets, do not rebuild them.
      this.session.onDidReanchor((doc) => this.reposition(doc)),
    );
  }

  /* ---------------- rendering ---------------- */

  private uriFor(docRelPath: string): vscode.Uri {
    return vscode.Uri.joinPath(vscode.Uri.file(this.session.root), ...docRelPath.split('/'));
  }

  private openDoc(docRelPath: string): vscode.TextDocument | undefined {
    const fsPath = this.uriFor(docRelPath).fsPath;
    return vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
  }

  private rangeFor(
    state: DocState,
    thread: Thread,
    doc: vscode.TextDocument | undefined,
  ): vscode.Range {
    const hit = state.resolved.get(thread.id);
    if (!hit || !doc) return new vscode.Range(0, 0, 0, 0);
    return new vscode.Range(doc.positionAt(hit.start), doc.positionAt(hit.end));
  }

  private toComments(thread: Thread): vscode.Comment[] {
    return thread.messages.map((m) => ({
      body: new vscode.MarkdownString(m.body),
      mode: vscode.CommentMode.Preview,
      author: { name: m.author === 'claude' ? 'Claude' : m.authorName },
      timestamp: new Date(m.ts),
      contextValue: m.author,
    }));
  }

  /** Update ranges only — cheap enough to run on every keystroke burst. */
  private reposition(docRelPath: string): void {
    const state = this.session.get(docRelPath);
    const views = this.views.get(docRelPath);
    if (!state || !views) return;
    const doc = this.openDoc(docRelPath);
    for (const t of state.file.threads) {
      const view = views.get(t.id);
      if (view) view.range = this.rangeFor(state, t, doc);
    }
  }

  sync(docRelPath?: string): void {
    if (docRelPath === undefined) {
      for (const d of this.session.all()) this.sync(d.docRelPath);
      return;
    }
    const state = this.session.get(docRelPath);
    const uri = this.uriFor(docRelPath);
    const doc = this.openDoc(docRelPath);
    let views = this.views.get(docRelPath);
    if (!views) {
      views = new Map();
      this.views.set(docRelPath, views);
    }

    const expandNew = inlineMode() === 'expanded';
    const live = new Set<string>();

    for (const t of state?.file.threads ?? []) {
      live.add(t.id);
      let view = views.get(t.id);
      if (!view) {
        view = this.controller.createCommentThread(uri, this.rangeFor(state!, t, doc), []);
        views.set(t.id, view);
        this.ids.set(view, t.id);
        // Set once, at creation. Reassigning this on every update would snap a
        // thread the user just expanded shut the next time anything changed —
        // which, with the collapsed default, is any keystroke.
        view.collapsibleState = expandNew
          ? vscode.CommentThreadCollapsibleState.Expanded
          : vscode.CommentThreadCollapsibleState.Collapsed;
      } else {
        view.range = this.rangeFor(state!, t, doc);
      }
      view.comments = this.toComments(t);
      view.label = statusLabel(t.status);
      view.contextValue = t.status;
      view.canReply = t.status !== 'resolved';
      view.state =
        t.status === 'resolved'
          ? vscode.CommentThreadState.Resolved
          : vscode.CommentThreadState.Unresolved;
    }

    for (const [id, view] of views) {
      if (!live.has(id)) {
        view.dispose();
        views.delete(id);
      }
    }
  }

  /* ---------------- adapting VS Code's widget onto ReviewActions ---------------- */

  threadIdOf(view: vscode.CommentThread): string | undefined {
    return this.ids.get(view);
  }

  /** The gutter `+`: VS Code hands us an ephemeral empty thread to adopt. */
  async create(reply: vscode.CommentReply): Promise<void> {
    const view = reply.thread;
    const body = reply.text.trim();
    if (!body) return;

    const doc = await vscode.workspace.openTextDocument(view.uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const range = view.range ?? editor.selection;
    editor.selection = new vscode.Selection(range.start, range.end);

    // Drop the ephemeral widget; sync() creates the managed one in its place.
    view.dispose();
    await this.actions.createFromSelection(editor, body);
  }

  async reply(reply: vscode.CommentReply): Promise<void> {
    const id = this.threadIdOf(reply.thread);
    if (id) await this.actions.reply(id, reply.text);
  }

  /** Open a thread in place — the one path allowed to change collapsible state. */
  expand(docRelPath: string, threadId: string): void {
    const view = this.views.get(docRelPath)?.get(threadId);
    if (view) view.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  dispose(): void {
    for (const views of this.views.values()) for (const v of views.values()) v.dispose();
    this.views.clear();
    this.disposables.forEach((d) => d.dispose());
  }
}
