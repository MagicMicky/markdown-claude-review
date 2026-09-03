import * as vscode from 'vscode';
import { statusLabel } from '../core/cards.js';
import type { FocusTracker } from './focus.js';
import type { Session } from './session.js';
import { inlineMode } from './config.js';

/**
 * The in-editor marks: an underline under every commented passage, a stronger
 * highlight on the one the cursor is in, and — only when the inline thread
 * layer is off — a gutter icon.
 *
 * These are owned by an instance rather than created at module scope. The
 * previous arrangement built the decoration type at import time and disposed it
 * from `CommentUI.dispose()`, so a second `CommentUI` would have torn down a
 * live decoration type.
 */
export class Decorations implements vscode.Disposable {
  private readonly commented: vscode.TextEditorDecorationType;
  private readonly active: vscode.TextEditorDecorationType;
  private readonly gutter: vscode.TextEditorDecorationType;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly session: Session,
    private readonly focus: FocusTracker,
    extensionUri: vscode.Uri,
  ) {
    this.commented = vscode.window.createTextEditorDecorationType({
      borderColor: new vscode.ThemeColor('editorInfo.foreground'),
      borderStyle: 'none none dotted none',
      borderWidth: '1px',
      overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

    this.active = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
      borderColor: new vscode.ThemeColor('editorInfo.foreground'),
      borderStyle: 'none none solid none',
      borderWidth: '2px',
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

    // Only used in 'off' mode. A collapsed native thread already draws VS Code's
    // own comment glyph in the gutter; painting ours on top gives two icons in
    // one lane. The SVG cannot use theme variables, hence one neutral accent —
    // status colour is carried by the underline and the sidebar card.
    this.gutter = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'gutter-comment.svg'),
      gutterIconSize: 'contain',
    });

    this.disposables.push(
      this.session.onDidChange(() => this.paint()),
      this.session.onDidReanchor(() => this.paint()),
      this.focus.onDidChangeActive(() => this.paint()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.paint()),
    );
  }

  paint(): void {
    const cfg = vscode.workspace.getConfiguration('mdreview');
    const underline = cfg.get('highlightCommentedRanges', true);
    const showGutter = inlineMode() === 'off';
    const activeId = this.focus.active.threadId;

    for (const editor of vscode.window.visibleTextEditors) {
      const rel = this.session.docRelPath(editor.document.uri);
      const state = rel ? this.session.get(rel) : undefined;
      if (!state || editor.document.languageId !== 'markdown') {
        this.clear(editor);
        continue;
      }

      const commented: vscode.DecorationOptions[] = [];
      const active: vscode.DecorationOptions[] = [];
      const gutter: vscode.Range[] = [];

      for (const t of state.file.threads) {
        if (t.status === 'resolved') continue;
        const hit = state.resolved.get(t.id);
        if (!hit) continue;
        const range = new vscode.Range(
          editor.document.positionAt(hit.start),
          editor.document.positionAt(hit.end),
        );
        const hover = new vscode.MarkdownString(
          `**${statusLabel(t.status)}** — ${t.messages.length} message${t.messages.length === 1 ? '' : 's'}`,
        );
        (t.id === activeId ? active : commented).push({ range, hoverMessage: hover });
        gutter.push(new vscode.Range(range.start, range.start));
      }

      editor.setDecorations(this.commented, underline ? commented : []);
      editor.setDecorations(this.active, underline ? active : []);
      editor.setDecorations(this.gutter, showGutter ? gutter : []);
    }
  }

  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.commented, []);
    editor.setDecorations(this.active, []);
    editor.setDecorations(this.gutter, []);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.commented.dispose();
    this.active.dispose();
    this.gutter.dispose();
  }
}
