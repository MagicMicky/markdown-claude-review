import * as vscode from 'vscode';
import { buildAnchor } from '../core/anchor.js';
import { appendMessage, makeMessage, newThread, setStatus } from '../core/store.js';
import { makeId, type Anchor, type Author, type ThreadStatus } from '../core/types.js';
import type { Session } from './session.js';

/**
 * The inline comment layer, when there is one. A lazy getter rather than a
 * constructor dependency: with `mdreview.inlineThreads` set to `off` the
 * CommentController is never created, and nothing here may assume otherwise.
 */
export interface InlineLayer {
  expand(docRelPath: string, threadId: string): void;
}

interface PendingDraft {
  docRelPath: string;
  anchor: Anchor;
}

/**
 * Every mutation to a review, in one place.
 *
 * Commands, the inline threads and the preview all call these, so no surface
 * depends on another. Previously this logic lived inside `CommentUI`, which
 * meant turning the inline layer off would have taken Delete Thread with it.
 */
export class ReviewActions {
  /**
   * Anchors captured when a comment was started, keyed by draft id.
   *
   * The anchor is built at the moment the command ran, not when the body is
   * submitted, so moving the selection while typing cannot silently re-point
   * the comment. Held in memory only: a window reload loses these, which the
   * sidebar reports rather than guessing.
   */
  private readonly drafts = new Map<string, PendingDraft>();

  constructor(
    private readonly session: Session,
    private readonly inline: () => InlineLayer | undefined = () => undefined,
  ) {}

  /* ---------------- creating ---------------- */

  /**
   * Capture the anchor for a new comment on the editor's selection. An empty
   * selection takes the whole line, which is what commenting from the gutter
   * means.
   */
  beginCompose(
    editor: vscode.TextEditor,
  ): { draftId: string; docRelPath: string; anchor: Anchor; line: number } | undefined {
    const docRelPath = this.session.docRelPath(editor.document.uri);
    if (!docRelPath) return undefined;

    let range: vscode.Range = editor.selection;
    if (range.isEmpty) range = editor.document.lineAt(range.start.line).range;

    const text = editor.document.getText();
    const anchor = buildAnchor(
      text,
      editor.document.offsetAt(range.start),
      editor.document.offsetAt(range.end),
    );
    const draftId = makeId('d');
    this.drafts.set(draftId, { docRelPath, anchor });
    return { draftId, docRelPath, anchor, line: range.start.line + 1 };
  }

  hasDraft(draftId: string): boolean {
    return this.drafts.has(draftId);
  }

  cancelDraft(draftId: string): void {
    this.drafts.delete(draftId);
  }

  /** Turn a captured draft into a real thread. Returns the new thread's id. */
  async commitDraft(draftId: string, body: string): Promise<string | undefined> {
    const draft = this.drafts.get(draftId);
    const trimmed = body.trim();
    if (!draft || !trimmed) return undefined;
    this.drafts.delete(draftId);

    const thread = newThread(draft.anchor, makeMessage('user', this.session.author, trimmed));
    await this.session.update(draft.docRelPath, (state) => {
      state.file.threads.push(thread);
    });
    return thread.id;
  }

  /** One-shot create from an editor selection, for the inline gutter widget. */
  async createFromSelection(editor: vscode.TextEditor, body: string): Promise<string | undefined> {
    const draft = this.beginCompose(editor);
    if (!draft) return undefined;
    return this.commitDraft(draft.draftId, body);
  }

  /* ---------------- mutating ---------------- */

  async reply(threadId: string, body: string, author: Author = 'user'): Promise<void> {
    const trimmed = body.trim();
    const found = this.session.findThread(threadId);
    if (!found || !trimmed) return;
    await this.session.update(found.state.docRelPath, () => {
      appendMessage(found.thread, makeMessage(author, this.session.author, trimmed));
    });
  }

  async setStatus(threadId: string, status: ThreadStatus): Promise<void> {
    const found = this.session.findThread(threadId);
    if (!found) return;
    await this.session.update(found.state.docRelPath, () => setStatus(found.thread, status));
  }

  /** Returns false when the user backs out of the confirmation. */
  async remove(threadId: string): Promise<boolean> {
    const found = this.session.findThread(threadId);
    if (!found) return false;
    const choice = await vscode.window.showWarningMessage(
      'Delete this thread and its history? Resolving keeps it instead.',
      { modal: true },
      'Delete',
    );
    if (choice !== 'Delete') return false;
    await this.session.update(found.state.docRelPath, (state) => {
      state.file.threads = state.file.threads.filter((t) => t.id !== threadId);
    });
    return true;
  }

  /**
   * Point a thread that lost its place at freshly selected text, keeping its
   * whole history. The selection must be in the document the thread belongs to.
   */
  async reattach(threadId: string, editor: vscode.TextEditor): Promise<boolean> {
    const found = this.session.findThread(threadId);
    if (!found || editor.selection.isEmpty) return false;
    const rel = this.session.docRelPath(editor.document.uri);
    if (!rel || rel !== found.state.docRelPath) return false;

    const text = editor.document.getText();
    const anchor = buildAnchor(
      text,
      editor.document.offsetAt(editor.selection.start),
      editor.document.offsetAt(editor.selection.end),
    );
    await this.session.update(rel, () => {
      found.thread.anchor = anchor;
      delete found.thread.driftedAt;
      // Whose turn it is follows from who spoke last.
      found.thread.status =
        found.thread.messages[found.thread.messages.length - 1]?.author === 'claude'
          ? 'answered'
          : 'open';
    });
    return true;
  }

  /* ---------------- navigating ---------------- */

  /** Open the thread's document, select its passage, and expand it inline. */
  async reveal(threadId: string): Promise<void> {
    const found = this.session.findThread(threadId);
    if (!found) return;
    const rel = found.state.docRelPath;
    const uri = vscode.Uri.joinPath(vscode.Uri.file(this.session.root), ...rel.split('/'));
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });

    const hit = found.state.resolved.get(threadId);
    if (hit) {
      const range = new vscode.Range(doc.positionAt(hit.start), doc.positionAt(hit.end));
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
    this.inline()?.expand(rel, threadId);
  }
}
