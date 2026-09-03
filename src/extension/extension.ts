import * as vscode from 'vscode';
import * as path from 'node:path';
import { EDITING_CONTRACT } from '../core/guidance.js';
import { COMMAND_MARKER, isOurCommand, mergeMcpConfig } from '../core/setup.js';
import { ReviewActions } from './actions.js';
import { CommentUI } from './comments.js';
import { inlineMode } from './config.js';
import { Decorations } from './decorations.js';
import { FocusTracker } from './focus.js';
import { PreviewManager } from './preview.js';
import { Session } from './session.js';

/** Pause between typing the prompt and pressing Enter, so the TUI settles the paste. */
const SUBMIT_DELAY_MS = 80;

/**
 * Written to .claude/commands/review.md so `/review` works in Claude Code.
 * Plain English also works — the MCP server ships the same guidance as its
 * connect-time instructions — but a slash command makes it one keystroke.
 */
const REVIEW_COMMAND = `---
description: Address the review comments left on markdown documents in this workspace
argument-hint: [optional path to one document]
---
${COMMAND_MARKER}

I have left comment threads on markdown documents in this workspace. Address them now.

Scope, if given: $ARGUMENTS

## Process

1. Call \`list_threads\` from the \`markdown-review\` MCP server to fetch the comments
   waiting on you. If a document path is given above, pass it as \`document\`. The
   comments are not written in the markdown itself — the tool is the only source.
2. The result groups threads by document and includes, per document, its \`outline\`,
   its size, and the \`section_context\` around each commented passage. Read a whole
   document only when its \`size_hint\` says it is short, when your change touches
   something stated elsewhere in it, or when it is not already in your context —
   once per document, before you edit it, not once per thread.
3. Work through the threads one at a time. For each, either edit the document and
   \`resolve_thread\`, or \`reply_thread\` and leave it open. Never resolve a thread you
   did not actually address.
4. Never edit files under \`.review/\` by hand. Use the tools.
5. Finish by summarising what you changed, and what you left open and why.

## How to edit

${EDITING_CONTRACT}
`;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;

  const session = new Session(folder.uri.fsPath);
  const focus = new FocusTracker(session);

  // The inline layer is optional, so nothing may depend on it existing.
  // `actions` reaches it through a getter, and every command goes through
  // `actions` rather than through the comment UI.
  let ui: CommentUI | undefined;
  const actions = new ReviewActions(session, () => ui);
  const decorations = new Decorations(session, focus, context.extensionUri);
  const previews = new PreviewManager(
    context.extensionUri,
    session,
    actions,
    focus,
    context.workspaceState,
  );

  const applyInlineMode = () => {
    const wanted = inlineMode() !== 'off';
    if (wanted && !ui) {
      ui = new CommentUI(session, actions);
      ui.sync();
    } else if (!wanted && ui) {
      ui.dispose();
      ui = undefined;
    }
    decorations.paint();
  };

  context.subscriptions.push(
    session,
    focus,
    decorations,
    previews,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mdreview.inlineThreads')) applyInlineMode();
      else if (e.affectsConfiguration('mdreview')) decorations.paint();
    }),
    { dispose: () => ui?.dispose() },
  );

  await session.init();
  applyInlineMode();

  /** Thread id from a webview/tree string, or from an inline thread's title bar. */
  const idFrom = (arg: unknown): string | undefined => {
    if (typeof arg === 'string') return arg;
    if (arg && typeof arg === 'object') {
      const asThread = arg as vscode.CommentThread;
      if (asThread.uri && asThread.range) return ui?.threadIdOf(asThread);
    }
    return undefined;
  };

  const markdownEditor = (): vscode.TextEditor | undefined => {
    const editor = vscode.window.activeTextEditor;
    return editor?.document.languageId === 'markdown' ? editor : undefined;
  };

  const register = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('mdreview.createThread', (reply: vscode.CommentReply) => ui?.create(reply));
  register('mdreview.replyThread', (reply: vscode.CommentReply) => ui?.reply(reply));

  register('mdreview.refresh', async () => {
    // refreshAll fires the emitter per document, so every surface follows.
    await session.refreshAll();
  });

  register('mdreview.openPreviewToSide', async () => {
    const editor = markdownEditor();
    if (!editor) {
      vscode.window.showWarningMessage('Open a markdown file to preview it.');
      return;
    }
    await previews.show(editor.document, vscode.ViewColumn.Beside);
  });

  register('mdreview.openPreview', async () => {
    const editor = markdownEditor();
    if (!editor) {
      vscode.window.showWarningMessage('Open a markdown file to preview it.');
      return;
    }
    await previews.show(editor.document, editor.viewColumn ?? vscode.ViewColumn.One);
  });

  register('mdreview.commentOnSelection', async () => {
    const editor = markdownEditor();
    if (!editor) {
      vscode.window.showWarningMessage('Open a markdown file to add a comment.');
      return;
    }
    if (editor.selection.isEmpty) {
      vscode.window.showWarningMessage('Select the passage you want to comment on.');
      return;
    }
    const draft = actions.beginCompose(editor);
    if (!draft) return;
    const body = await vscode.window.showInputBox({
      prompt: 'Comment on the selected passage',
      placeHolder: 'What should change here?',
    });
    if (body?.trim()) await actions.commitDraft(draft.draftId, body);
    else actions.cancelDraft(draft.draftId);
  });

  register('mdreview.revealThread', async (arg: unknown) => {
    const id = idFrom(arg);
    if (!id) return;
    focus.setActive(id, 'command');
    await actions.reveal(id);
    const found = session.findThread(id);
    if (found) previews.get(found.state.docRelPath)?.focusThread(id);
  });

  register('mdreview.resolveThread', (arg: unknown) => {
    const id = idFrom(arg);
    if (id) return actions.setStatus(id, 'resolved');
  });

  register('mdreview.unresolveThread', (arg: unknown) => {
    const id = idFrom(arg);
    if (id) return actions.setStatus(id, 'open');
  });

  register('mdreview.deleteThread', async (arg: unknown) => {
    const id = idFrom(arg);
    if (id) await actions.remove(id);
  });

  register('mdreview.reattachThread', async (arg: unknown) => {
    const id = idFrom(arg);
    const editor = markdownEditor();
    if (!id || !editor) return;
    if (editor.selection.isEmpty) {
      vscode.window.showWarningMessage(
        'Select the text this comment should now point at, then run Re-attach again.',
      );
      return;
    }
    const ok = await actions.reattach(id, editor);
    if (!ok) {
      vscode.window.showWarningMessage(
        'Could not re-attach — make sure the selection is in the document the comment belongs to.',
      );
    }
  });

  const step = async (delta: number) => {
    const editor = markdownEditor();
    if (!editor) return;
    const rel = session.docRelPath(editor.document.uri);
    if (!rel) return;
    const spans = session.spans(rel).filter((s) => s.status !== 'resolved');
    if (spans.length === 0) {
      vscode.window.showInformationMessage('No open comments in this document.');
      return;
    }
    const offset = editor.document.offsetAt(editor.selection.active);
    const next =
      delta > 0
        ? (spans.find((s) => s.start > offset) ?? spans[0])
        : ([...spans].reverse().find((s) => s.start < offset) ?? spans[spans.length - 1]);
    await vscode.commands.executeCommand('mdreview.revealThread', next.id);
  };

  register('mdreview.nextThread', () => step(1));
  register('mdreview.previousThread', () => step(-1));

  register('mdreview.toggleInlineThreads', async () => {
    const order = ['collapsed', 'expanded', 'off'] as const;
    const next = order[(order.indexOf(inlineMode()) + 1) % order.length];
    await vscode.workspace
      .getConfiguration('mdreview')
      .update('inlineThreads', next, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage(`Inline comment threads: ${next}.`);
  });

  register('mdreview.sendToClaude', async () => {
    await session.refreshAll();
    const openCount = session
      .all()
      .reduce(
        (n, d) => n + d.file.threads.filter((t) => t.status === 'open' || t.status === 'stale').length,
        0,
      );
    if (openCount === 0) {
      vscode.window.showInformationMessage('No open comments to send.');
      return;
    }

    const needle = vscode.workspace
      .getConfiguration('mdreview')
      .get('terminalName', 'claude')
      .toLowerCase();
    // `includes('')` is true for every terminal, so an empty setting would type
    // the prompt into whichever shell happened to be first.
    const terminal = needle
      ? vscode.window.terminals.find((t) => t.name.toLowerCase().includes(needle))
      : undefined;
    // Nothing more than what you would type yourself. Claude reads the comments
    // through the MCP server, so there is no digest to hand over.
    const line = vscode.workspace.getConfiguration('mdreview').get('sendPrompt', '/review');

    if (terminal) {
      terminal.show(true);
      // One line, not the whole digest: pasting multi-line text into a TUI is fragile.
      //
      // sendText(_, true) appends \n, which Claude Code's input treats as
      // "insert a newline" (shift+enter) rather than submit. The Enter key
      // actually sends a carriage return, so send the text and the CR
      // separately, with a beat in between for the TUI to settle the paste.
      terminal.sendText(line, false);
      await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS));
      terminal.sendText('\r', false);
      vscode.window.showInformationMessage(`Sent ${openCount} comment(s) to ${terminal.name}.`);
    } else {
      await vscode.env.clipboard.writeText(line);
      vscode.window.showWarningMessage(
        `No terminal matching "${needle}" found. Copied "${line}" to your clipboard — or just ask Claude to address your review comments.`,
      );
    }
  });

  register('mdreview.setupClaude', async () => {
    const mcpPath = vscode.Uri.joinPath(folder.uri, '.mcp.json');

    // Distinguish "no file yet" from "file exists but is broken". Only the
    // former is safe to write over: overwriting an unparseable .mcp.json would
    // silently delete whatever other servers the workspace had configured.
    let existingText: string | undefined;
    try {
      existingText = Buffer.from(await vscode.workspace.fs.readFile(mcpPath)).toString('utf8');
    } catch (e) {
      if ((e as vscode.FileSystemError)?.code !== 'FileNotFound') {
        vscode.window.showErrorMessage(`Could not read .mcp.json: ${(e as Error).message}`);
        return;
      }
    }

    const merged = mergeMcpConfig(existingText, 'markdown-review', {
      command: process.execPath,
      args: [path.join(context.extensionPath, 'dist', 'mcp.js')],
      env: {
        MDREVIEW_ROOT: folder.uri.fsPath,
        MDREVIEW_DIR: session.reviewDir,
      },
    });
    if (!merged.ok) {
      const open = await vscode.window.showErrorMessage(merged.reason, 'Open .mcp.json');
      if (open) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mcpPath));
      return;
    }
    await vscode.workspace.fs.writeFile(mcpPath, Buffer.from(merged.json, 'utf8'));

    // Never clobber a /review command the user wrote themselves.
    const cmdDir = vscode.Uri.joinPath(folder.uri, '.claude', 'commands');
    const cmdPath = vscode.Uri.joinPath(cmdDir, 'review.md');
    let wroteCommand = false;
    let existingCommand: string | undefined;
    try {
      existingCommand = Buffer.from(await vscode.workspace.fs.readFile(cmdPath)).toString('utf8');
    } catch {
      /* no /review command yet */
    }
    if (existingCommand === undefined || isOurCommand(existingCommand)) {
      await vscode.workspace.fs.createDirectory(cmdDir);
      await vscode.workspace.fs.writeFile(cmdPath, Buffer.from(REVIEW_COMMAND, 'utf8'));
      wroteCommand = true;
    } else {
      const choice = await vscode.window.showWarningMessage(
        'This workspace already has its own /review command. Overwrite it?',
        { modal: true },
        'Overwrite',
        'Keep mine',
      );
      if (choice === 'Overwrite') {
        await vscode.workspace.fs.writeFile(cmdPath, Buffer.from(REVIEW_COMMAND, 'utf8'));
        wroteCommand = true;
      }
    }

    const kept = merged.siblings.length
      ? ` Kept your other MCP server${merged.siblings.length === 1 ? '' : 's'} (${merged.siblings.join(', ')}).`
      : '';
    const cmd = wroteCommand
      ? ' Type /review in Claude Code when you want it to read your comments.'
      : ' Left your /review command alone — just ask Claude to address your review comments instead.';
    const choice = await vscode.window.showInformationMessage(
      `Registered the markdown-review MCP server.${kept}${cmd} Restart Claude Code in this workspace to pick it up.`,
      'Open .mcp.json',
    );
    if (choice) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mcpPath));
  });
}

export function deactivate(): void {
  /* subscriptions handle teardown */
}
