import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { buildAnchor } from '../core/anchor.js';
import { buildCards, truncateQuote, type AnchorHit, type CardVM } from '../core/cards.js';
import type { HighlightSpec, HostMessage, ViewMessage } from '../core/previewProtocol.js';
import { makeId, type Anchor } from '../core/types.js';
import type { ReviewActions } from './actions.js';
import { previewSettings, showResolvedInPreview } from './config.js';
import type { FocusTracker } from './focus.js';
import { render } from './markdown.js';
import type { Session } from './session.js';

const RENDER_DEBOUNCE_MS = 300;

interface PendingDraft {
  docRelPath: string;
  anchor: Anchor;
}

/**
 * One commenting preview, bound to one markdown document.
 *
 * A projection of `Session`, exactly like the inline comment threads: it holds
 * no authoritative state, it posts commands and re-renders when the event comes
 * back. That is what makes preview comments and editor comments the same
 * comments rather than two things kept in step by hand.
 */
export class Preview implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly drafts = new Map<string, PendingDraft>();
  /** Bumped per render; identifies which block map the webview is showing. */
  private generation = 0;
  private renderTimer?: NodeJS.Timeout;
  private suppressScrollUntil = 0;

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly session: Session,
    private readonly actions: ReviewActions,
    private readonly focus: FocusTracker,
    readonly docRelPath: string,
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: this.resourceRoots(),
    };
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage(
      (m: ViewMessage) => void this.dispatch(m),
      null,
      this.disposables,
    );

    this.disposables.push(
      session.onDidChange((doc) => {
        if (doc === undefined || doc === this.docRelPath) this.pushThreads();
      }),
      session.onDidReanchor((doc) => {
        if (doc === this.docRelPath) this.pushThreads();
      }),
      focus.onDidChangeActive((a) => {
        if (a.docRelPath === this.docRelPath || a.threadId === null) {
          this.post({ type: 'active', threadId: a.threadId, origin: a.origin });
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.session.docRelPath(e.document.uri) !== this.docRelPath) return;
        if (e.contentChanges.length === 0) return;
        clearTimeout(this.renderTimer);
        this.renderTimer = setTimeout(() => void this.pushDocument(), RENDER_DEBOUNCE_MS);
      }),
      // Selection drives only the "you are here" marker. Scrolling is driven by
      // the viewport below: using selection for both meant every cursor move
      // scrolled the preview, which is most of why it felt jumpy.
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (this.session.docRelPath(e.textEditor.document.uri) !== this.docRelPath) return;
        if (!previewSettings(e.textEditor.document.uri).markEditorSelection) return;
        this.post({ type: 'editorSelection', line: e.selections[0].active.line });
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        if (this.session.docRelPath(e.textEditor.document.uri) !== this.docRelPath) return;
        if (!previewSettings(e.textEditor.document.uri).scrollPreviewWithEditor) return;
        if (Date.now() < this.suppressScrollUntil) return;
        this.post({ type: 'scrollTo', line: e.visibleRanges[0]?.start.line ?? 0 });
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        // Which bubbles are listed, not how the document renders. Going through
        // pushDocument would bump the generation and repaint the prose, which
        // for a visibility toggle is a visible flicker and a discarded scroll.
        if (e.affectsConfiguration('mdreview.showResolvedInPreview')) {
          this.pushThreads();
        } else if (e.affectsConfiguration('markdown') || e.affectsConfiguration('mdreview')) {
          void this.pushDocument();
        }
      }),
    );
  }

  /* ---------------- resources ---------------- */

  private uri(): vscode.Uri {
    return vscode.Uri.joinPath(
      vscode.Uri.file(this.session.root),
      ...this.docRelPath.split('/'),
    );
  }

  /** Where VS Code's own preview keeps its stylesheets. */
  private builtInMedia(): vscode.Uri | undefined {
    const ext = vscode.extensions.getExtension('vscode.markdown-language-features');
    return ext ? vscode.Uri.joinPath(ext.extensionUri, 'media') : undefined;
  }

  private resourceRoots(): vscode.Uri[] {
    const roots = [
      vscode.Uri.joinPath(this.extensionUri, 'media'),
      vscode.Uri.joinPath(this.extensionUri, 'dist'),
      // So relative images in the document resolve.
      vscode.Uri.joinPath(this.uri(), '..'),
      vscode.Uri.file(this.session.root),
    ];
    const builtIn = this.builtInMedia();
    if (builtIn) roots.push(builtIn);
    return roots;
  }

  /* ---------------- projection ---------------- */

  private async sourceText(): Promise<string> {
    return (await this.session.documentText(this.docRelPath)) ?? '';
  }

  private hits(text: string): Map<string, AnchorHit> {
    const state = this.session.get(this.docRelPath);
    const out = new Map<string, AnchorHit>();
    if (!state) return out;
    for (const t of state.file.threads) {
      const hit = state.resolved.get(t.id);
      if (!hit) continue;
      out.set(t.id, { ...hit, currentText: text.slice(hit.start, hit.end) });
    }
    return out;
  }

  /**
   * Keep a webview-supplied range inside the document it claims to describe.
   * The offsets come from the DOM, which can be a render behind the source.
   */
  private clamp(text: string, r: { start: number; end: number }): { start: number; end: number } | null {
    const start = Math.max(0, Math.min(r.start, text.length));
    const end = Math.max(start, Math.min(r.end, text.length));
    return end > start ? { start, end } : null;
  }

  /* ---------------- pushes ---------------- */

  private post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  async pushDocument(): Promise<void> {
    const text = await this.sourceText();
    const settings = previewSettings(this.uri());
    const dir = vscode.Uri.joinPath(this.uri(), '..');
    const rendered = render(text, {
      settings,
      resolveImage: (src) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return src;
        return this.panel.webview
          .asWebviewUri(vscode.Uri.joinPath(dir, ...src.split('/')))
          .toString();
      },
    });
    this.post({ type: 'document', generation: ++this.generation, html: rendered.html });
    this.pushThreads();
  }

  pushThreads(): void {
    void this.sourceText().then((text) => {
      const state = this.session.get(this.docRelPath);
      const threads = state?.file.threads ?? [];
      const hits = this.hits(text);
      // Resolved threads are hidden here by default. The preview is the live
      // review surface; the closed history stays in the file and in the inline
      // thread. `showResolvedInPreview` lets them back in for a read-through —
      // one list feeds both the bubbles and the highlights, so the margin can
      // never disagree with what is tinted in the prose.
      const visible = showResolvedInPreview()
        ? threads
        : threads.filter((t) => t.status !== 'resolved');
      const cards: CardVM[] = buildCards(visible, hits);

      const highlights: HighlightSpec[] = [];
      for (const t of visible) {
        const hit = hits.get(t.id);
        highlights.push({
          threadId: t.id,
          status: t.status,
          range: hit ? { start: hit.start, end: hit.end } : undefined,
        });
      }

      this.post({
        type: 'threads',
        generation: this.generation,
        author: this.session.author,
        cards,
        highlights,
      });
    });
  }

  reveal(column?: vscode.ViewColumn): void {
    this.panel.reveal(column, true);
  }

  focusThread(threadId: string): void {
    this.post({ type: 'active', threadId, origin: 'command' });
  }

  /* ---------------- webview shell ---------------- */

  private html(): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const webview = this.panel.webview;
    const asset = (...p: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...p)).toString();

    // VS Code's own preview stylesheets, found at runtime so there is no build
    // hash to hardcode and nothing to drift. It is a built-in extension and
    // cannot be uninstalled; if it is somehow missing, preview.css alone still
    // renders readable prose.
    const builtIn = this.builtInMedia();
    const documentStyles = builtIn
      ? [
          webview.asWebviewUri(vscode.Uri.joinPath(builtIn, 'markdown.css')).toString(),
          webview.asWebviewUri(vscode.Uri.joinPath(builtIn, 'highlight.css')).toString(),
        ]
      : [];

    const settings = previewSettings(this.uri());
    const userStyles = settings.styles
      .map((s) => {
        try {
          return webview.asWebviewUri(vscode.Uri.parse(s, true)).toString();
        } catch {
          return undefined;
        }
      })
      .filter((s): s is string => Boolean(s));

    const rootStyle = [
      settings.fontFamily ? `--markdown-font-family: ${settings.fontFamily};` : '',
      Number.isFinite(settings.fontSize) ? `--markdown-font-size: ${settings.fontSize}px;` : '',
      Number.isFinite(settings.lineHeight) ? `--markdown-line-height: ${settings.lineHeight};` : '',
    ].join(' ');

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `media-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} https: data:`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    const links = [...documentStyles, ...userStyles]
      .map((href) => `<link rel="stylesheet" href="${href}">`)
      .join('\n');

    // markdown.css gates real behaviour on these, exactly as the built-in
    // preview does. Without `showEditorSelection` the marker that shows where
    // the editor's cursor is has no styling at all and silently never appears.
    const editorConfig = vscode.workspace.getConfiguration('editor', this.uri());
    const bodyClasses = [
      settings.markEditorSelection ? 'showEditorSelection' : '',
      editorConfig.get('scrollBeyondLastLine', true) ? 'scrollBeyondLastLine' : '',
      editorConfig.get<string>('wordWrap', 'off') !== 'off' ? 'wordWrap' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return `<!DOCTYPE html>
<html lang="en" style="${rootStyle}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${links}
<link rel="stylesheet" href="${asset('media', 'preview.css')}">
<title>${escapeHtml(this.docRelPath)}</title>
</head>
<body class="vscode-body ${bodyClasses}">
  <div id="doc" class="markdown-body" dir="auto"></div>
  <div id="margin" class="margin"></div>
  <button id="add" class="add-comment" hidden>Comment</button>
<script nonce="${nonce}" src="${asset('dist', 'preview.js')}"></script>
</body>
</html>`;
  }

  /* ---------------- inbound ---------------- */

  private ack(opId: string, ok: boolean, message = ''): void {
    this.post(ok ? { type: 'ack', opId, ok: true } : { type: 'ack', opId, ok: false, message });
  }

  /**
   * Every inbound message, with failures reported back.
   *
   * Without this, a rejected write (EACCES, ENOSPC, a failed rename) meant no
   * ack was ever sent, so the bubble's buttons stayed disabled for the life of
   * the panel and the reply the user had typed was already gone.
   */
  private async dispatch(m: ViewMessage): Promise<void> {
    try {
      await this.handle(m);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if ('opId' in m && typeof m.opId === 'string') this.ack(m.opId, false, message);
      vscode.window.showErrorMessage(`Markdown Review: ${message}`);
    }
  }

  private async handle(m: ViewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        await this.pushDocument();
        for (const id of m.knownDraftIds) {
          if (!this.drafts.has(id)) {
            this.post({
              type: 'draftLost',
              draftId: id,
              reason: 'The preview reloaded, so this draft lost the passage it pointed at.',
            });
          }
        }
        return;

      case 'startCompose': {
        const text = await this.sourceText();
        const range = this.clamp(text, m);
        if (!range) return;
        const anchor = buildAnchor(text, range.start, range.end);
        const draftId = makeId('d');
        this.drafts.set(draftId, { docRelPath: this.docRelPath, anchor });
        const { text: quote } = truncateQuote(anchor.quote);
        this.post({ type: 'compose', draftId, range, quote });
        return;
      }

      case 'createThread': {
        const draft = this.drafts.get(m.draftId);
        if (!draft || !m.body.trim()) {
          this.ack(m.opId, false, 'This draft lost the passage it pointed at.');
          return;
        }
        this.drafts.delete(m.draftId);
        await this.session.update(draft.docRelPath, (state) => {
          state.file.threads.push(
            newUserThread(draft.anchor, this.session.author, m.body.trim()),
          );
        });
        this.ack(m.opId, true);
        return;
      }

      case 'cancelDraft':
        this.drafts.delete(m.draftId);
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
        const text = await this.sourceText();
        const found = this.session.findThread(m.threadId);
        const range = this.clamp(text, m);
        if (!found || !range) {
          this.ack(m.opId, false, 'Could not tell which passage that was.');
          return;
        }
        await this.session.update(this.docRelPath, () => {
          found.thread.anchor = buildAnchor(text, range.start, range.end);
          delete found.thread.driftedAt;
          found.thread.status =
            found.thread.messages[found.thread.messages.length - 1]?.author === 'claude'
              ? 'answered'
              : 'open';
        });
        this.ack(m.opId, true);
        return;
      }

      case 'activate':
        this.focus.setActive(m.threadId, 'webview');
        return;

      case 'revealLine': {
        const settings = previewSettings(this.uri());
        if (!settings.scrollEditorWithPreview) return;
        const editor = vscode.window.visibleTextEditors.find(
          (e) => this.session.docRelPath(e.document.uri) === this.docRelPath,
        );
        if (!editor) return;
        // Stop the editor's own scroll event bouncing straight back at us.
        this.suppressScrollUntil = Date.now() + 200;
        // The webview interpolates within a block, so this is fractional and
        // can exceed the document; Position wants a real line.
        const doc = vscode.workspace.textDocuments.find(
          (d) => d.uri.fsPath === this.uri().fsPath,
        );
        const maxLine = Math.max(0, (doc?.lineCount ?? 1) - 1);
        const line = Math.min(maxLine, Math.max(0, Math.floor(m.line)));
        editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
        return;
      }

      case 'openAtLine': {
        // Revealing the editor changes its visible range, which would bounce a
        // scrollTo straight back at the preview.
        this.suppressScrollUntil = Date.now() + 400;
        const doc = await vscode.workspace.openTextDocument(this.uri());
        const editor = await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.One,
          preserveFocus: false,
        });
        const pos = new vscode.Position(
          Math.min(Math.max(0, Math.floor(m.line)), doc.lineCount - 1),
          0,
        );
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        return;
      }

      case 'openLink': {
        // Only real external schemes go to the OS. Everything else resolves
        // against the document and opens in the editor — which is both what the
        // built-in preview does and what stops a hostile document handing an
        // arbitrary URI to whatever has registered a handler for it.
        if (/^(https?|mailto):/i.test(m.href)) {
          await vscode.env.openExternal(vscode.Uri.parse(m.href));
          return;
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(m.href)) {
          vscode.window.showWarningMessage(`Refusing to open a "${m.href.split(':')[0]}:" link.`);
          return;
        }
        const [rel, fragment] = m.href.split('#');
        const target = rel
          ? vscode.Uri.joinPath(vscode.Uri.joinPath(this.uri(), '..'), ...rel.split('/'))
          : this.uri();
        if (!this.session.docRelPath(target)) {
          vscode.window.showWarningMessage('That link points outside the workspace.');
          return;
        }
        try {
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), {
            viewColumn: vscode.ViewColumn.One,
          });
        } catch {
          vscode.window.showWarningMessage(`Could not open ${rel || fragment}.`);
        }
        return;
      }

    }
  }

  dispose(): void {
    clearTimeout(this.renderTimer);
    this.disposables.forEach((d) => d.dispose());
  }
}

function newUserThread(anchor: Anchor, authorName: string, body: string) {
  const ts = new Date().toISOString();
  return {
    id: makeId('mr'),
    anchor,
    status: 'open' as const,
    createdAt: ts,
    updatedAt: ts,
    messages: [{ id: makeId('m'), author: 'user' as const, authorName, body, ts }],
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** One preview per document, revealed rather than duplicated. */
export class PreviewManager implements vscode.Disposable {
  static readonly viewType = 'mdreview.preview';
  private readonly open = new Map<string, Preview>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly session: Session,
    private readonly actions: ReviewActions,
    private readonly focus: FocusTracker,
  ) {}

  async show(document: vscode.TextDocument, column: vscode.ViewColumn): Promise<void> {
    const docRelPath = this.session.docRelPath(document.uri);
    if (!docRelPath) {
      vscode.window.showWarningMessage('Open a markdown file inside the workspace to preview it.');
      return;
    }

    const existing = this.open.get(docRelPath);
    if (existing) {
      existing.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      PreviewManager.viewType,
      `Review: ${docRelPath.split('/').pop()}`,
      { viewColumn: column, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'activity-icon.svg');

    const preview = new Preview(
      panel,
      this.extensionUri,
      this.session,
      this.actions,
      this.focus,
      docRelPath,
    );
    this.open.set(docRelPath, preview);
    panel.onDidDispose(() => {
      this.open.delete(docRelPath);
      preview.dispose();
    });
  }

  /** The preview for a document, if one is open. */
  get(docRelPath: string): Preview | undefined {
    return this.open.get(docRelPath);
  }

  dispose(): void {
    for (const p of this.open.values()) p.dispose();
    this.open.clear();
  }
}
