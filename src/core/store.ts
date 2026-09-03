import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  REVIEW_FILE_VERSION,
  makeId,
  nowIso,
  type Anchor,
  type Author,
  type Message,
  type ReviewFile,
  type Thread,
  type ThreadStatus,
} from './types.js';

export const DEFAULT_REVIEW_DIR = '.review';

/** Mirror the document's path inside the review dir: docs/a.md -> .review/docs/a.md.review.json */
export function reviewPathFor(root: string, reviewDir: string, docRelPath: string): string {
  const rel = docRelPath.split(path.sep).join('/');
  return path.join(root, reviewDir, ...rel.split('/')) + '.review.json';
}

export function docRelPathFor(root: string, reviewDir: string, reviewFilePath: string): string {
  const rel = path.relative(path.join(root, reviewDir), reviewFilePath);
  return rel.replace(/\.review\.json$/, '').split(path.sep).join('/');
}

function emptyFile(docRelPath: string): ReviewFile {
  return { version: REVIEW_FILE_VERSION, document: docRelPath, threads: [] };
}

/**
 * The outcome of loading a review file.
 *
 * `missing` and `corrupt` must never be conflated. Treating an unreadable file
 * as empty means the next write erases every comment in it — the file is the
 * only copy of that history.
 */
export type ReviewLoad =
  | { kind: 'ok'; file: ReviewFile }
  | { kind: 'missing'; file: ReviewFile }
  | { kind: 'corrupt'; reason: string };

function isThread(t: unknown): t is Thread {
  if (typeof t !== 'object' || t === null) return false;
  const x = t as Record<string, unknown>;
  const anchor = x.anchor as Record<string, unknown> | undefined;
  return (
    typeof x.id === 'string' &&
    typeof x.status === 'string' &&
    Array.isArray(x.messages) &&
    typeof anchor === 'object' &&
    anchor !== null &&
    typeof anchor.quote === 'string' &&
    Array.isArray(anchor.headingPath)
  );
}

export async function loadReview(file: string, docRelPath: string): Promise<ReviewLoad> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'missing', file: emptyFile(docRelPath) };
    }
    return { kind: 'corrupt', reason: (e as Error).message };
  }
  if (raw.trim() === '') return { kind: 'missing', file: emptyFile(docRelPath) };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { kind: 'corrupt', reason: `not valid JSON (${(e as Error).message})` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'corrupt', reason: 'does not contain a JSON object' };
  }

  const obj = parsed as Partial<ReviewFile>;
  if (!Array.isArray(obj.threads)) return { kind: 'corrupt', reason: 'has no threads array' };

  // A structurally broken thread used to reach resolveAnchor and throw, which
  // killed activate() before a single command was registered.
  const bad = obj.threads.findIndex((t) => !isThread(t));
  if (bad !== -1) return { kind: 'corrupt', reason: `thread ${bad} is missing required fields` };

  return {
    kind: 'ok',
    file: { version: obj.version ?? REVIEW_FILE_VERSION, document: obj.document ?? docRelPath, threads: obj.threads },
  };
}

/**
 * Combine our in-memory threads with whatever is on disk now.
 *
 * Both this extension and the MCP server hold a whole review file and write it
 * back, from different processes. Without this, whoever writes second silently
 * reverts the other — a reply from Claude, or a resolve from the reviewer.
 *
 * `deleted` carries ids this side removed on purpose, so a thread the other
 * side still has does not come back from the dead.
 */
/**
 * Status is not last-writer-wins.
 *
 * Resolving is an explicit, terminal act; a reply that happens to carry a later
 * timestamp must not reopen a thread someone closed. Everything below that
 * follows from who spoke last, which is what `appendMessage` guarantees — so
 * the outcome does not depend on two clocks agreeing to the millisecond.
 */
function mergeStatus(a: Thread, b: Thread, newer: Thread, messages: Message[]): ThreadStatus {
  if (a.status === 'resolved' || b.status === 'resolved') return 'resolved';
  if (newer.status === 'stale') return 'stale';
  return messages[messages.length - 1]?.author === 'claude' ? 'answered' : 'open';
}

export function mergeReviewFiles(
  mine: ReviewFile,
  onDisk: ReviewFile,
  deleted: ReadonlySet<string> = new Set(),
): ReviewFile {
  const byId = new Map<string, Thread>();
  for (const t of onDisk.threads) if (!deleted.has(t.id)) byId.set(t.id, t);

  for (const ours of mine.threads) {
    const theirs = byId.get(ours.id);
    if (!theirs) {
      byId.set(ours.id, ours);
      continue;
    }
    // Messages only ever accumulate, so union them by id.
    const messages = new Map<string, Message>();
    for (const m of theirs.messages) messages.set(m.id, m);
    for (const m of ours.messages) messages.set(m.id, m);

    const merged = [...messages.values()].sort((a, b) => a.ts.localeCompare(b.ts));
    const newer = ours.updatedAt >= theirs.updatedAt ? ours : theirs;
    byId.set(ours.id, {
      ...newer,
      status: mergeStatus(ours, theirs, newer, merged),
      messages: merged,
    });
  }

  return {
    version: mine.version,
    document: mine.document,
    threads: [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}

/**
 * Write via temp file + rename. The extension watches this path, and Claude
 * writes it from another process; a torn read would drop comment history.
 */
export async function writeReview(file: string, data: ReviewFile): Promise<number> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, file);
  // The resulting mtime identifies this write, so a file watcher can tell our
  // own change from someone else's without guessing from a time window.
  return (await fsp.stat(file)).mtimeMs;
}

/** Every review file under the review dir, recursively. */
export async function listReviewFiles(root: string, reviewDir: string): Promise<string[]> {
  const base = path.join(root, reviewDir);
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.review.json')) out.push(p);
    }
  }
  await walk(base);
  return out.sort();
}

export function makeMessage(author: Author, authorName: string, body: string): Message {
  return { id: makeId('m'), author, authorName, body, ts: nowIso() };
}

export function newThread(anchor: Anchor, first: Message): Thread {
  const ts = nowIso();
  return {
    id: makeId('mr'),
    anchor,
    status: first.author === 'user' ? 'open' : 'answered',
    createdAt: ts,
    updatedAt: ts,
    messages: [first],
  };
}

export function appendMessage(thread: Thread, message: Message): Thread {
  thread.messages.push(message);
  thread.updatedAt = message.ts;
  if (thread.status !== 'resolved') {
    // A reply always flips the ball to the other side.
    thread.status = message.author === 'user' ? 'open' : 'answered';
  }
  return thread;
}

export function setStatus(thread: Thread, status: ThreadStatus): Thread {
  thread.status = status;
  thread.updatedAt = nowIso();
  return thread;
}

export function findThread(file: ReviewFile, id: string): Thread | undefined {
  return file.threads.find((t) => t.id === id);
}
