/**
 * Merging our entry into a workspace's existing Claude Code config.
 *
 * Kept pure and free of vscode imports so it can be tested: this code edits
 * files the user did not create and may have hand-tuned, so "preserve
 * everything I do not own, and refuse rather than guess" is the whole contract.
 */

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
