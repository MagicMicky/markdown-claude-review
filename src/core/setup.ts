/**
 * Merging our entry into a workspace's existing Claude Code config.
 *
 * Kept pure and free of vscode imports so it can be tested: this code edits
 * files the user did not create and may have hand-tuned, so "preserve
 * everything I do not own, and refuse rather than guess" is the whole contract.
 */

import { EDITING_CONTRACT, SCOPE_CONTRACT } from './guidance.js';

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export type MergeResult =
  | { ok: true; json: string; replacedExisting: boolean; siblings: string[] }
  | { ok: false; reason: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Add `name` to an existing `.mcp.json`, leaving every other server and every
 * unrelated top-level key untouched.
 *
 * `existingText` must be undefined only when the file genuinely does not exist.
 * A file that exists but cannot be parsed returns `ok: false` — overwriting it
 * would silently delete the user's other MCP servers.
 */
export function mergeMcpConfig(
  existingText: string | undefined,
  name: string,
  entry: McpServerEntry,
): MergeResult {
  let root: Record<string, unknown>;

  if (existingText === undefined || existingText.trim() === '') {
    root = {};
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingText);
    } catch (e) {
      return {
        ok: false,
        reason: `.mcp.json is not valid JSON (${(e as Error).message}). Fix or remove it first — overwriting it would drop your other MCP servers.`,
      };
    }
    if (!isPlainObject(parsed)) {
      return { ok: false, reason: '.mcp.json does not contain a JSON object.' };
    }
    root = parsed;
  }

  if (root.mcpServers !== undefined && !isPlainObject(root.mcpServers)) {
    return { ok: false, reason: '.mcp.json has an "mcpServers" key that is not an object.' };
  }

  const servers = isPlainObject(root.mcpServers) ? { ...root.mcpServers } : {};
  const replacedExisting = Object.prototype.hasOwnProperty.call(servers, name);
  const siblings = Object.keys(servers).filter((k) => k !== name);
  servers[name] = entry;

  return {
    ok: true,
    json: JSON.stringify({ ...root, mcpServers: servers }, null, 2) + '\n',
    replacedExisting,
    siblings,
  };
}

/** The entry we wrote for `name`, or undefined when there is none to read. */
export function readMcpEntry(
  existingText: string | undefined,
  name: string,
): McpServerEntry | undefined {
  if (existingText === undefined || existingText.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(existingText);
  } catch {
    // Unreadable is not the same as absent, but neither is it something to
    // repair: mergeMcpConfig refuses to write over a file it cannot parse, and
    // reporting "no entry" keeps the repair path from trying.
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  const servers = parsed.mcpServers;
  if (!isPlainObject(servers)) return undefined;
  const entry = servers[name];
  if (!isPlainObject(entry)) return undefined;
  if (typeof entry.command !== 'string' || !Array.isArray(entry.args)) return undefined;
  return {
    command: entry.command,
    args: entry.args.filter((a): a is string => typeof a === 'string'),
    ...(isPlainObject(entry.env) ? { env: entry.env as Record<string, string> } : {}),
  };
}

/** Which of a stored entry's absolute paths has stopped existing. */
export type StalePath = 'interpreter' | 'server' | null;

/**
 * Whether a registration we wrote earlier still points at anything.
 *
 * Both paths in it rot by design. VS Code's bundled node lives under a
 * directory named after the build that shipped it, and an extension's install
 * directory is named after its version — so a VS Code update breaks the first
 * and an extension update breaks the second, silently, in a file nobody looks
 * at. The entry is therefore re-checked every activation rather than trusted
 * once at setup.
 *
 * Only a path that is genuinely gone counts. Someone who repointed the entry at
 * their own interpreter keeps it for as long as it works, which a "rewrite
 * whenever it differs from what we would write today" check would not allow.
 */
export function stalePath(
  entry: McpServerEntry | undefined,
  exists: (p: string) => boolean,
): StalePath {
  if (!entry) return null;
  if (!exists(entry.command)) return 'interpreter';
  const server = entry.args[0];
  if (server === undefined || !exists(server)) return 'server';
  return null;
}

/**
 * Basename of the generated slash command, so `/markdown-review` invokes it.
 *
 * Deliberately not `review`. Claude Code ships a built-in `/review`, and a
 * workspace that never ran setup — or lost the generated file — does not get an
 * unknown-command error from `/review`; it silently gets a code review instead.
 * That is plausible enough to look like the hand-off worked, which is the worst
 * shape a failure can take. A longer name that cannot collide is worth it.
 */
export const COMMAND_NAME = 'markdown-review';

/** What versions before the rename wrote. Removed on setup, if it is still ours. */
export const LEGACY_COMMAND_NAME = 'review';

/**
 * Stamped into the generated slash command so re-running setup can tell its own
 * output from a command the user wrote themselves.
 */
export const COMMAND_MARKER = '<!-- generated by markdown-claude-review -->';

export function isOurCommand(text: string): boolean {
  return text.includes(COMMAND_MARKER);
}

/**
 * Written to .claude/commands/markdown-review.md so `/markdown-review` works in
 * Claude Code. Plain English also works — the MCP server ships the same guidance
 * as its connect-time instructions — but a slash command makes it one keystroke.
 */
export const REVIEW_COMMAND = `---
description: Address the review comments left on markdown documents in this workspace
argument-hint: [document to review — a path, a description, or nothing]
---
${COMMAND_MARKER}

I have left comment threads on markdown documents in this workspace. Address them now.

Scope, if given: $ARGUMENTS

## Process

1. Work out what you are reviewing before you call anything. The scope above is free
   text — a path, a description of a document, "all of them", or empty. If it names a
   path, or if this session has already been working on one document, that is your
   scope. If it describes a document without naming one, you still need its path, and
   the unscoped call in step 2 is how you get it.
2. Call \`list_threads\` from the \`markdown-review\` MCP server. Pass \`document\` when
   you have a path, \`all_documents: true\` when I asked for the whole workspace, and
   neither when nothing has settled it — that returns the documents with comments, to
   match against or to ask me about. The comments are not written in the markdown
   itself; the tool is the only source.
3. The result includes, per document, its \`outline\`, its size, and the
   \`section_context\` around each commented passage. Read a whole document only when
   its \`size_hint\` says it is short, when your change touches something stated
   elsewhere in it, or when it is not already in your context — once per document,
   before you edit it, not once per thread.
4. Work through the threads one at a time. For each, either edit the document and
   \`resolve_thread\`, or \`reply_thread\` and leave it open. Never resolve a thread you
   did not actually address.
5. Never edit files under \`.review/\` by hand. Use the tools.
6. Finish by summarising what you changed, and what you left open and why.

## Which document

${SCOPE_CONTRACT}

## How to edit

${EDITING_CONTRACT}
`;
