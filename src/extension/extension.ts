import * as vscode from 'vscode';
import { matchesStatus } from '../core/scope.js';
import {
  COMMAND_NAME,
  LEGACY_COMMAND_NAME,
  REVIEW_COMMAND,
  isOurCommand,
  mergeMcpConfig,
  readMcpEntry,
  stalePath,
  type McpServerEntry,
} from '../core/setup.js';
import { ReviewActions } from './actions.js';
import { CommentUI } from './comments.js';
import { inlineMode, showResolvedInPreview } from './config.js';
import { Decorations } from './decorations.js';
import { FocusTracker } from './focus.js';
import { PreviewManager } from './preview.js';
import { Session } from './session.js';

/** Pause between typing the prompt and pressing Enter, so the TUI settles the paste. */
const SUBMIT_DELAY_MS = 80;

/**
 * Where the MCP server is launched from, which is deliberately not where it is
 * installed.
 *
 * An extension's install directory is named after its version, so every update
 * moves `dist/mcp.js` and invalidates any config pointing at it. `globalStorageUri`
 * is keyed on the extension id alone and survives updates, so a registration
 * written against this path stays correct for the life of the install.
 */
function stableServerPath(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, 'mcp.js');
}

/**
 * Keep the launchable copy in step with the installed one.
 *
 * Compared by size and mtime rather than by extension version: a development
 * build rewrites `dist/mcp.js` without the version changing, and a stamp would
 * leave the F5 host running whatever was there first.
 */
async function syncStableServer(context: vscode.ExtensionContext): Promise<vscode.Uri> {
  const src = vscode.Uri.joinPath(context.extensionUri, 'dist', 'mcp.js');
  const dest = stableServerPath(context);
  const srcStat = await vscode.workspace.fs.stat(src);
  try {
    const destStat = await vscode.workspace.fs.stat(dest);
    if (destStat.size === srcStat.size && destStat.mtime >= srcStat.mtime) return dest;
  } catch {
    /* not copied yet */
  }
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  await vscode.workspace.fs.copy(src, dest, { overwrite: true });
  return dest;
}

/** The trigger phrase. The scope — a document path, or "all documents" — is appended. */
function sendPrompt(): string {
  return vscode.workspace.getConfiguration('mdreview').get('sendPrompt', `/${COMMAND_NAME}`);
}

/**
 * Type the hand-off into the Claude Code terminal, or fall back to the clipboard.
 *
 * `what` is only for the confirmation toast, and it names the scope: the count
 * on its own used to be the workspace total, which said nothing true about what
 * had just been sent.
 */
async function handOff(line: string, what: string): Promise<void> {
  const needle = vscode.workspace
    .getConfiguration('mdreview')
    .get('terminalName', 'claude')
    .toLowerCase();
  // `includes('')` is true for every terminal, so an empty setting would type
  // the prompt into whichever shell happened to be first.
  const terminal = needle
    ? vscode.window.terminals.find((t) => t.name.toLowerCase().includes(needle))
    : undefined;

  if (!terminal) {
    await vscode.env.clipboard.writeText(line);
    vscode.window.showWarningMessage(
      `No terminal matching "${needle}" found. Copied "${line}" to your clipboard — or just ask Claude to address your review comments.`,
    );
    return;
  }

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
  vscode.window.showInformationMessage(`Sent ${what} to ${terminal.name}.`);
}

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
  const previews = new PreviewManager(context.extensionUri, session, actions, focus);

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

  /**
   * VS Code's own preview buttons hide themselves when `hasCustomMarkdownPreview`
   * is set — an escape hatch for extensions that provide their own preview.
   * Without it ours sits beside theirs looking like a duplicate, and worse, the
   * buttons and the keybindings would open different previews.
   *
   * `mdreview.replacesPreview` gates our own title-bar button and keybindings on
   * the same setting, so turning it off genuinely hands the built-in preview back
   * rather than leaving a half-replaced state.
   */
  const applyPreviewOwnership = () => {
    const owns = vscode.workspace
      .getConfiguration('mdreview')
      .get('replaceBuiltInPreview', true);
    void vscode.commands.executeCommand('setContext', 'hasCustomMarkdownPreview', owns);
    void vscode.commands.executeCommand('setContext', 'mdreview.replacesPreview', owns);
  };

  /**
   * The title-bar toggle is two commands sharing a slot, so the button shows the
   * action rather than the state. `mdreview.resolvedVisible` mirrors the setting
   * into a context key because a `when` clause cannot read configuration.
   */
  const applyResolvedVisibility = () => {
    void vscode.commands.executeCommand(
      'setContext',
      'mdreview.resolvedVisible',
      showResolvedInPreview(),
    );
  };

  /** The registration setup writes, and the one a repair restores it to. */
  const mcpEntry = (server: vscode.Uri): McpServerEntry => ({
    command: process.execPath,
    args: [server.fsPath],
    env: {
      MDREVIEW_ROOT: folder.uri.fsPath,
      MDREVIEW_DIR: session.reviewDir,
    },
  });

  const pathExists = async (p: string): Promise<boolean> => {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(p));
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Put back a registration that has stopped pointing at anything.
   *
   * Runs on activation, which is every window and every session, because that is
   * when the paths it checks have had a chance to move underneath it — a VS Code
   * update renames the directory holding its bundled node, and an extension
   * update renames the one holding the server.
   *
   * Repairs, never registers: a workspace with no `.mcp.json`, or one where our
   * entry was removed, is a workspace nobody enabled, and enabling one stays a
   * deliberate act. An unparseable file is left alone by `mergeMcpConfig` for the
   * same reason setup leaves it alone — it may hold other servers.
   */
  const healMcpConfig = async (): Promise<void> => {
    const mcpPath = vscode.Uri.joinPath(folder.uri, '.mcp.json');
    let text: string;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(mcpPath)).toString('utf8');
    } catch {
      return;
    }

    const entry = readMcpEntry(text, 'markdown-review');
    if (!entry) return;

    const alive = new Set<string>();
    for (const p of [entry.command, ...entry.args]) {
      if (await pathExists(p)) alive.add(p);
    }
    const stale = stalePath(entry, (p) => alive.has(p));
    if (!stale) return;

    const merged = mergeMcpConfig(text, 'markdown-review', mcpEntry(await syncStableServer(context)));
    if (!merged.ok) return;
    await vscode.workspace.fs.writeFile(mcpPath, Buffer.from(merged.json, 'utf8'));

    // Not silent, because the repair alone changes nothing: Claude Code reads
    // .mcp.json when it starts, so a session that is already running keeps the
    // dead path until it is restarted.
    const what =
      stale === 'interpreter'
        ? "VS Code's bundled Node moved, which happens on a VS Code update"
        : 'the extension moved, which happens on an extension update';
    void vscode.window.showInformationMessage(
      `Repaired the markdown-review entry in .mcp.json — ${what}. Restart Claude Code in this workspace to reconnect.`,
    );
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mdreview.replaceBuiltInPreview')) applyPreviewOwnership();
      if (e.affectsConfiguration('mdreview.showResolvedInPreview')) applyResolvedVisibility();
    }),
    // Leave VS Code's preview alone once we are gone.
    { dispose: () => void vscode.commands.executeCommand('setContext', 'hasCustomMarkdownPreview', false) },
  );

  await session.init();
  applyInlineMode();
  applyPreviewOwnership();
  applyResolvedVisibility();
  // Best-effort: a repair that cannot run leaves the workspace exactly as it was,
  // and the setup command is still there to do it deliberately. Failing loudly on
  // activation would put an error in front of someone who did nothing.
  void healMcpConfig().catch(() => undefined);

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

  // Global, not Workspace: this is a per-person view preference, and this repo —
  // like many — tracks .vscode/, so writing it there would put a toggle of the
  // reading pane into everyone's `git status`. A workspace value set by hand is
  // still honoured; only the button's own writes are kept out of the tree.
  const setResolvedVisible = async (visible: boolean) => {
    await vscode.workspace
      .getConfiguration('mdreview')
      .update('showResolvedInPreview', visible, vscode.ConfigurationTarget.Global);
  };

  register('mdreview.showResolved', () => setResolvedVisible(true));
  register('mdreview.hideResolved', () => setResolvedVisible(false));

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
    const needsAttention = (docRelPath: string) =>
      session.get(docRelPath)?.file.threads.filter((t) => matchesStatus(t, 'needs_attention'))
        .length ?? 0;

    // Which document the hand-off is about, decided here rather than left to
    // Claude: the editor knows, and a prompt that names the document costs one
    // round trip less than one that makes Claude ask which. Nothing is inferred
    // from the review files themselves — if focus does not say, the user does.
    const active = previews.active()?.docRelPath;
    const editor = vscode.window.activeTextEditor;
    const fromEditor =
      editor?.document.languageId === 'markdown'
        ? session.docRelPath(editor.document.uri)
        : undefined;

    let scope = active ?? fromEditor;
    if (scope === undefined) {
      const withComments = session.all().filter((d) => needsAttention(d.docRelPath) > 0);
      if (withComments.length === 0) {
        vscode.window.showInformationMessage('No open comments to send.');
        return;
      }
      const ALL = 'All documents in the workspace';
      const picked = await vscode.window.showQuickPick(
        [
          ...withComments.map((d) => ({
            label: d.docRelPath,
            description: `${needsAttention(d.docRelPath)} open`,
          })),
          { label: ALL, description: `${withComments.length} documents` },
        ],
        { title: 'Send which review to Claude Code?', placeHolder: 'Pick a document' },
      );
      if (!picked) return;
      scope = picked.label === ALL ? undefined : picked.label;
      if (scope === undefined) {
        await handOff(`${sendPrompt()} all documents in the workspace`, 'every document');
        return;
      }
    }

    const openCount = needsAttention(scope);
    if (openCount === 0) {
      vscode.window.showInformationMessage(`No open comments on ${scope} to send.`);
      return;
    }
    await handOff(`${sendPrompt()} ${scope}`, `${openCount} comment(s) on ${scope}`);
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

    const merged = mergeMcpConfig(
      existingText,
      'markdown-review',
      mcpEntry(await syncStableServer(context)),
    );
    if (!merged.ok) {
      const open = await vscode.window.showErrorMessage(merged.reason, 'Open .mcp.json');
      if (open) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mcpPath));
      return;
    }
    await vscode.workspace.fs.writeFile(mcpPath, Buffer.from(merged.json, 'utf8'));

    const cmdDir = vscode.Uri.joinPath(folder.uri, '.claude', 'commands');
    const readCommand = async (uri: vscode.Uri): Promise<string | undefined> => {
      try {
        return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      } catch {
        return undefined;
      }
    };

    // Never clobber a command the user wrote themselves.
    const cmdPath = vscode.Uri.joinPath(cmdDir, `${COMMAND_NAME}.md`);
    const existingCommand = await readCommand(cmdPath);
    let wroteCommand = false;
    if (existingCommand === undefined || isOurCommand(existingCommand)) {
      await vscode.workspace.fs.createDirectory(cmdDir);
      await vscode.workspace.fs.writeFile(cmdPath, Buffer.from(REVIEW_COMMAND, 'utf8'));
      wroteCommand = true;
    } else {
      const choice = await vscode.window.showWarningMessage(
        `This workspace already has its own /${COMMAND_NAME} command. Overwrite it?`,
        { modal: true },
        'Overwrite',
        'Keep mine',
      );
      if (choice === 'Overwrite') {
        await vscode.workspace.fs.writeFile(cmdPath, Buffer.from(REVIEW_COMMAND, 'utf8'));
        wroteCommand = true;
      }
    }

    // Earlier versions wrote review.md, which shadows Claude Code's own /review.
    // Leaving it behind would keep that override alive for a workspace that has
    // done nothing wrong except upgrade. Only ever remove our own: the marker is
    // the whole reason it is stamped into the file.
    let removedLegacy = false;
    const legacyPath = vscode.Uri.joinPath(cmdDir, `${LEGACY_COMMAND_NAME}.md`);
    const legacy = await readCommand(legacyPath);
    if (legacy !== undefined && isOurCommand(legacy)) {
      await vscode.workspace.fs.delete(legacyPath);
      removedLegacy = true;
    }

    const kept = merged.siblings.length
      ? ` Kept your other MCP server${merged.siblings.length === 1 ? '' : 's'} (${merged.siblings.join(', ')}).`
      : '';
    const cmd = wroteCommand
      ? ` Type /${COMMAND_NAME} in Claude Code when you want it to read your comments.`
      : ` Left your /${COMMAND_NAME} command alone — just ask Claude to address your review comments instead.`;
    const swept = removedLegacy
      ? ` Removed the /${LEGACY_COMMAND_NAME} command an earlier version left behind, which was shadowing Claude Code's own.`
      : '';
    const choice = await vscode.window.showInformationMessage(
      `Registered the markdown-review MCP server.${kept}${cmd}${swept} Restart Claude Code in this workspace to pick it up.`,
      'Open .mcp.json',
    );
    if (choice) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mcpPath));
  });
}

export function deactivate(): void {
  /* subscriptions handle teardown */
}
