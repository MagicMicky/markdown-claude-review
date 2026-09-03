import * as fs from 'node:fs';
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

export function readReviewSync(file: string, docRelPath: string): ReviewFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ReviewFile;
    if (!parsed || !Array.isArray(parsed.threads)) return emptyFile(docRelPath);
    parsed.document ??= docRelPath;
    return parsed;
  } catch {
    return emptyFile(docRelPath);
  }
}

export async function readReview(file: string, docRelPath: string): Promise<ReviewFile> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as ReviewFile;
    if (!parsed || !Array.isArray(parsed.threads)) return emptyFile(docRelPath);
    parsed.document ??= docRelPath;
    return parsed;
  } catch {
    return emptyFile(docRelPath);
  }
}

/**
 * Write via temp file + rename. The extension watches this path, and Claude
 * writes it from another process; a torn read would drop comment history.
 */
export async function writeReview(file: string, data: ReviewFile): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, file);
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
