import * as vscode from 'vscode';
import { activeThreadAt } from '../core/sidebar.js';
import type { Session } from './session.js';

export type FocusOrigin = 'editor' | 'webview' | 'command';

export interface ActiveThread {
  threadId: string | null;
  docRelPath: string | null;
  origin: FocusOrigin;
}

/** Cursor moves fire in bursts; one recompute per burst is plenty. */
const SELECTION_DEBOUNCE_MS = 60;

/**
 * How long after a programmatic reveal to ignore selection events.
 *
 * Clicking a card moves the editor selection, which fires
 * `onDidChangeTextEditorSelection`, which would recompute and re-emit — and the
 * sidebar would scroll itself under the click. `TextEditorSelectionChangeKind`
 * is not a reliable discriminator for programmatic assignment, so this is a
 * time window instead.
 */
const ECHO_SUPPRESS_MS = 250;

/**
 * Which comment thread the cursor is inside.
 *
 * Shared by the decorations and the sidebar so the two highlights always agree.
 * That coordinated pair — a highlighted passage and an expanded card — is what
 * stands in for the pixel alignment VS Code cannot give us.
 */
export class FocusTracker implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ActiveThread>();
  private disposables: vscode.Disposable[] = [];
  private debounce?: NodeJS.Timeout;
  private suppressUntil = 0;
  private current: ActiveThread = { threadId: null, docRelPath: null, origin: 'editor' };

  readonly onDidChangeActive = this.emitter.event;

  constructor(private readonly session: Session) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      vscode.window.onDidChangeTextEditorSelection(() => this.schedule()),
      // Offsets moved under a stationary cursor, so the answer may have changed.
      session.onDidReanchor(() => this.schedule()),
      session.onDidChange(() => this.schedule()),
    );
  }

  get active(): ActiveThread {
    return this.current;
  }

  /** Set from the sidebar or a command, suppressing the selection echo it causes. */
  setActive(threadId: string | null, origin: 'webview' | 'command'): void {
    this.suppressUntil = Date.now() + ECHO_SUPPRESS_MS;
    const docRelPath = threadId
      ? (this.session.findThread(threadId)?.state.docRelPath ?? null)
      : this.current.docRelPath;
    this.emit({ threadId, docRelPath, origin });
  }

  private schedule(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.recompute(), SELECTION_DEBOUNCE_MS);
  }

  private recompute(): void {
    if (Date.now() < this.suppressUntil) return;

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'markdown') {
      this.emit({ threadId: null, docRelPath: null, origin: 'editor' });
      return;
    }
    const docRelPath = this.session.docRelPath(editor.document.uri);
    if (!docRelPath) {
      this.emit({ threadId: null, docRelPath: null, origin: 'editor' });
      return;
    }
    const offset = editor.document.offsetAt(editor.selection.active);
    const threadId = activeThreadAt(offset, this.session.spans(docRelPath));
    this.emit({ threadId, docRelPath, origin: 'editor' });
  }

  private emit(next: ActiveThread): void {
    if (next.threadId === this.current.threadId && next.docRelPath === this.current.docRelPath) {
      return;
    }
    this.current = next;
    this.emitter.fire(next);
  }

  dispose(): void {
    clearTimeout(this.debounce);
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }
}
