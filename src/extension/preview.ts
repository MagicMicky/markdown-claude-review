import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { buildAnchor } from '../core/anchor.js';
import { buildCards, countCards, truncateQuote, type AnchorHit, type CardVM } from '../core/cards.js';
import type { HighlightSpec, HostMessage, ViewMessage } from '../core/previewProtocol.js';
import { locateInSource, renderedNeedle } from '../core/rendermap.js';
import { makeId, type Anchor, type ThreadStatus } from '../core/types.js';
import type { ReviewActions } from './actions.js';
import { previewSettings } from './config.js';
import type { FocusTracker } from './focus.js';
import { render, type RenderedBlock } from './markdown.js';
import type { Session } from './session.js';

const STATUS_KEY = 'mdreview.preview.statuses';
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
  private blocks: RenderedBlock[] = [];
  private rev = 0;
  private renderTimer?: NodeJS.Timeout;
  private suppressScrollUntil = 0;

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly session: Session,
    private readonly actions: ReviewActions,
    private readonly focus: FocusTracker,
    private readonly memento: vscode.Memento,
    readonly docRelPath: string,
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: this.resourceRoots(),
    };
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage((m: ViewMessage) => void this.handle(m), null, this.disposables);

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
        if (e.affectsConfiguration('markdown') || e.affectsConfiguration('mdreview')) {
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

  /**
   * The built-in preview's own stylesheets, found at runtime so there is no
   * hardcoded VS Code build hash and no copy to drift. Falls back to our
   * vendored pair if the extension is somehow absent.
   */
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
    let line = 1;
    const lineAt = (offset: number) => {
      line = 1;
      for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
      return line;
    };
    for (const t of state.file.threads) {
      const hit = state.resolved.get(t.id);
      if (!hit) continue;
      out.set(t.id, {
        ...hit,
        line: lineAt(hit.start),
        currentText: text.slice(hit.start, hit.end),
      });
    }
    return out;
  }

  /** The block a source offset falls in — how a thread finds its highlight. */
  private blockAt(offset: number): RenderedBlock | undefined {
    let best: RenderedBlock | undefined;
    for (const b of this.blocks) {
      if (offset < b.start || offset >= b.end) continue;
      // Innermost wins: a list item beats the list containing it.
      if (!best || b.end - b.start < best.end - best.start) best = b;
    }
    return best;
  }

  private statuses(): ThreadStatus[] {
    return this.memento.get<ThreadStatus[]>(STATUS_KEY) ?? ['open', 'answered', 'stale'];
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
    this.blocks = rendered.blocks;
    this.post({
      type: 'document',
      rev: ++this.rev,
      html: rendered.html,
      lineCount: text.split('\n').length,
      title: this.docRelPath,
    });
    this.pushThreads();
  }

  pushThreads(): void {
    void this.sourceText().then((text) => {
      const state = this.session.get(this.docRelPath);
      const threads = state?.file.threads ?? [];
      const hits = this.hits(text);
      const cards: CardVM[] = buildCards(this.docRelPath, threads, hits);

      const highlights: HighlightSpec[] = [];
      for (const t of threads) {
        const hit = hits.get(t.id);
        if (!hit) {
          highlights.push({ threadId: t.id, status: t.status, block: -1, needle: '' });
          continue;
        }
        const block = this.blockAt(hit.start);
        highlights.push({
          threadId: t.id,
          status: t.status,
          block: block?.index ?? -1,
          needle: renderedNeedle(text, { start: hit.start, end: hit.end }),
        });
      }

      this.post({
        type: 'threads',
        rev: ++this.rev,
        author: this.session.author,
        cards,
        highlights,
        counts: countCards(cards),
        statuses: this.statuses(),
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

    const builtIn = this.builtInMedia();
    const documentStyles = builtIn
      ? [
          webview.asWebviewUri(vscode.Uri.joinPath(builtIn, 'markdown.css')).toString(),
          webview.asWebviewUri(vscode.Uri.joinPath(builtIn, 'highlight.css')).toString(),
        ]
      : [asset('media', 'markdown-fallback.css')];

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
<body class="vscode-body">
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
        const first = this.blocks[m.blockStart];
        const last = this.blocks[m.blockEnd] ?? first;
        if (!first) {
          vscode.window.showWarningMessage('Could not tell which part of the document that was.');
          return;
        }
        // One search window covering every block the selection touched, so a
        // sentence spanning two paragraphs still resolves.
        const block = {
          startLine: first.startLine,
          endLine: last.endLine,
          start: first.start,
          end: Math.max(first.end, last.end),
        };
        const range = locateInSource(text, block, m.text);
        if (!range) return;
        const anchor = buildAnchor(text, range.start, range.end);
        const draftId = makeId('d');
        this.drafts.set(draftId, { docRelPath: this.docRelPath, anchor });
        const { text: quote } = truncateQuote(anchor.quote);
        this.post({
          type: 'compose',
          draftId,
          block: m.blockStart,
          needle: renderedNeedle(text, range),
          quote,
          headingPath: anchor.headingPath,
        });
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
        editor.revealRange(
          new vscode.Range(m.line, 0, m.line, 0),
          vscode.TextEditorRevealType.AtTop,
        );
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
        const pos = new vscode.Position(Math.min(m.line, doc.lineCount - 1), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        return;
      }

      case 'openLink':
        await vscode.env.openExternal(vscode.Uri.parse(m.href));
        return;

      case 'setStatuses':
        await this.memento.update(STATUS_KEY, m.statuses);
        return;

      case 'sendToClaude':
        await vscode.commands.executeCommand('mdreview.sendToClaude');
        return;
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
    private readonly memento: vscode.Memento,
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
      this.memento,
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
