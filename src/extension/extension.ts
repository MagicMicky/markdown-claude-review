import * as vscode from 'vscode';
import * as path from 'node:path';
import { EDITING_CONTRACT } from '../core/guidance.js';
import { COMMAND_MARKER, isOurCommand, mergeMcpConfig } from '../core/setup.js';
import { CommentUI } from './comments.js';
import { Session } from './session.js';
import { ThreadTree } from './tree.js';

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
  const ui = new CommentUI(session);
  const tree = new ThreadTree(session);
  context.subscriptions.push(session, ui);
  context.subscriptions.push(
    vscode.window.createTreeView('mdreview.threads', {
      treeDataProvider: tree,
      showCollapseAll: true,
    }),
  );

  await session.init();
  ui.sync();

  const idFrom = (arg: unknown): string | undefined => {
    if (typeof arg === 'string') return arg;
    if (arg && typeof arg === 'object') {
      if ('thread' in arg && (arg as { thread?: unknown }).thread) {
        const t = (arg as { thread: { id?: string } }).thread;
        if (typeof t.id === 'string') return t.id;
      }
      // A vscode.CommentThread passed from the thread title bar.
      const asThread = arg as vscode.CommentThread;
      if (asThread.uri && asThread.range) return ui.threadIdOf(asThread);
    }
    return undefined;
  };

  const register = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('mdreview.createThread', (reply: vscode.CommentReply) => ui.create(reply));
  register('mdreview.replyThread', (reply: vscode.CommentReply) => ui.reply(reply));
  register('mdreview.refresh', async () => {
    await session.refreshAll();
    ui.sync();
    tree.refresh();
  });
  register('mdreview.revealThread', (arg: unknown) => {
    const id = idFrom(arg);
    if (id) return ui.reveal(id);
  });
  register('mdreview.resolveThread', (arg: unknown) => {
    const id = idFrom(arg);
    if (id) return ui.setStatus(id, 'resolved');
  });
  register('mdreview.unresolveThread', (arg: unknown) => {
    const id = idFrom(arg);
    if (id) return ui.setStatus(id, 'open');
  });

  register('mdreview.deleteThread', async (arg: unknown) => {
    const id = idFrom(arg);
    if (!id) return;
    const choice = await vscode.window.showWarningMessage(
      'Delete this thread and its history? Resolving keeps it instead.',
      { modal: true },
      'Delete',
    );
    if (choice === 'Delete') await ui.remove(id);
  });

  register('mdreview.reattachThread', async (arg: unknown) => {
    const id = idFrom(arg);
    const editor = vscode.window.activeTextEditor;
    if (!id || !editor) return;
    if (editor.selection.isEmpty) {
      vscode.window.showWarningMessage(
        'Select the text this comment should now point at, then run Re-attach again.',
      );
      return;
    }
    const ok = await ui.reattach(id, editor);
    if (!ok) {
      vscode.window.showWarningMessage(
        'Could not re-attach — make sure the selection is in the document the comment belongs to.',
      );
    }
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
    const terminal = vscode.window.terminals.find((t) => t.name.toLowerCase().includes(needle));
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
