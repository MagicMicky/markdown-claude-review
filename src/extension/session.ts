import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveAnchor } from '../core/anchor.js';
import {
  DEFAULT_REVIEW_DIR,
  docRelPathFor,
  listReviewFiles,
  loadReview,
  mergeReviewFiles,
  reviewPathFor,
  writeReview,
} from '../core/store.js';
import { nowIso, type ReviewFile, type ResolvedAnchor, type Thread, type ThreadStatus } from '../core/types.js';

const execFileAsync = promisify(execFile);

/** Long enough that a burst of typing re-anchors once, short enough to feel live. */
const REANCHOR_DEBOUNCE_MS = 500;

export interface DocState {
  /** Workspace-relative, forward-slashed. */
  docRelPath: string;
  file: ReviewFile;
  /** Live positions, keyed by thread id. Absent means the anchor did not resolve. */
  resolved: Map<string, ResolvedAnchor>;
  /**
   * Set when the file on disk could not be parsed. Writing is then refused:
   * the sidecar is the only copy of that comment history, and overwriting it
   * with an empty file would destroy it silently.
   */
  corrupt?: string;
  /** Threads deleted here, so a merge does not resurrect them from disk. */
  deleted: Set<string>;
}

/** A thread's live position in the document, for callers that only need geometry. */
export interface ThreadSpan {
  id: string;
  start: number;
  end: number;
  status: ThreadStatus;
}

/**
 * Owns every review file in the workspace: reads, writes, and keeps anchors
 * resolved against current document text. Every surface — the inline comment
 * threads, the decorations, the preview — is a projection of this, and every
 * mutation goes through `update()` so all of them observe the same events.
 */
export class Session implements vscode.Disposable {
  private readonly docs = new Map<string, DocState>();
  private readonly emitter = new vscode.EventEmitter<string | undefined>();
  private readonly reanchorEmitter = new vscode.EventEmitter<string>();
  /** One timer per document: a shared one let an edit in B cancel A's re-anchor. */
  private readonly reanchorTimers = new Map<string, NodeJS.Timeout>();
  /** Paths we just wrote, so the file watcher does not echo our own changes back. */
  /**
   * Modification time of our own last write per file. Compared against the
   * watcher event's mtime, which is exact — the previous three-second window
   * discarded genuine external writes whenever VS Code coalesced them with
   * ours, losing whatever Claude had just written.
   */
  private readonly selfWrites = new Map<string, number>();
  private authorName = 'You';
  private disposables: vscode.Disposable[] = [];

  /** Thread content changed: added, replied, status, deleted, or an external write. */
  readonly onDidChange = this.emitter.event;

  /**
   * Anchor offsets moved but no thread content did — the typing path.
   *
   * Separate from `onDidChange` so surfaces can update line numbers at typing
   * speed without re-rendering every thread body, and so no projection has to
   * update itself behind the others' backs.
   */
  readonly onDidReanchor = this.reanchorEmitter.event;

  constructor(readonly root: string) {}

  get reviewDir(): string {
    return vscode.workspace.getConfiguration('mdreview').get('reviewDir', DEFAULT_REVIEW_DIR);
  }

  get threshold(): number {
    return vscode.workspace.getConfiguration('mdreview').get('fuzzyThreshold', 0.62);
  }

  get author(): string {
    return this.authorName;
  }

  async init(): Promise<void> {
    this.authorName = await this.resolveAuthorName();

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.root, `${this.reviewDir}/**/*.review.json`),
    );
    const onExternal = async (uri: vscode.Uri) => {
      if (await this.wasSelfWrite(uri.fsPath)) return;
      const rel = docRelPathFor(this.root, this.reviewDir, uri.fsPath);
      await this.load(rel);
      this.emitter.fire(rel);
    };
    watcher.onDidChange(onExternal);
    watcher.onDidCreate(onExternal);
    watcher.onDidDelete(async (uri) => {
      const rel = docRelPathFor(this.root, this.reviewDir, uri.fsPath);
      this.docs.delete(rel);
      this.emitter.fire(rel);
    });
    this.disposables.push(watcher);

    // These live here, not in a projection. When CommentUI owned them it
    // re-anchored and re-rendered itself directly without firing anything, so
    // any other surface held stale offsets from the first keystroke until the
    // next save.
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(async (d) => {
        const rel = this.docRelPath(d.uri);
        if (rel && d.languageId === 'markdown') await this.refresh(rel);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId !== 'markdown' || e.contentChanges.length === 0) return;
        const rel = this.docRelPath(e.document.uri);
        if (!rel || !this.docs.has(rel)) return;
        clearTimeout(this.reanchorTimers.get(rel));
        this.reanchorTimers.set(rel, setTimeout(() => {
          this.reanchorTimers.delete(rel);
          const state = this.docs.get(rel);
          if (!state) return;
          // Positions only. Statuses are not persisted mid-edit: a quote can be
          // transiently unmatchable halfway through a keystroke, and writing
          // 'stale' for that would outlive the edit.
          this.reanchor(state, e.document.getText());
          this.reanchorEmitter.fire(rel);
        }, REANCHOR_DEBOUNCE_MS));
      }),
    );

    for (const f of await listReviewFiles(this.root, this.reviewDir)) {
      await this.load(docRelPathFor(this.root, this.reviewDir, f));
    }
    this.emitter.fire(undefined);
  }

  /**
   * Live positions of a document's threads, sorted by start offset. Threads
   * whose anchor did not resolve are omitted — they have no geometry.
   */
  spans(docRelPath: string): ThreadSpan[] {
    const state = this.docs.get(docRelPath);
    if (!state) return [];
    const out: ThreadSpan[] = [];
    for (const t of state.file.threads) {
      const hit = state.resolved.get(t.id);
      if (hit) out.push({ id: t.id, start: hit.start, end: hit.end, status: t.status });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  private async resolveAuthorName(): Promise<string> {
    const configured = vscode.workspace.getConfiguration('mdreview').get('author', '');
    if (configured) return configured;
    try {
      const { stdout } = await execFileAsync('git', ['config', 'user.name'], { cwd: this.root });
      const name = stdout.trim();
      if (name) return name;
    } catch {
      /* not a git repo, or git absent */
    }
    return 'You';
  }

  /* ---------------- paths ---------------- */

  docRelPath(uri: vscode.Uri): string | undefined {
    const rel = path.relative(this.root, uri.fsPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return rel.split(path.sep).join('/');
  }

  reviewFilePath(docRelPath: string): string {
    return reviewPathFor(this.root, this.reviewDir, docRelPath);
  }

  /* ---------------- state ---------------- */

  get(docRelPath: string): DocState | undefined {
    return this.docs.get(docRelPath);
  }

  all(): DocState[] {
    return [...this.docs.values()].sort((a, b) => a.docRelPath.localeCompare(b.docRelPath));
  }

  private async load(docRelPath: string): Promise<DocState> {
    const previous = this.docs.get(docRelPath);
    const loaded = await loadReview(this.reviewFilePath(docRelPath), docRelPath);

    if (loaded.kind === 'corrupt') {
      // Keep whatever we already had, refuse to write, and say so once.
      const state: DocState = previous ?? {
        docRelPath,
        file: { version: 1, document: docRelPath, threads: [] },
        resolved: new Map(),
        deleted: new Set(),
      };
      if (state.corrupt !== loaded.reason) {
        vscode.window.showErrorMessage(
          `Comments for ${docRelPath} could not be read: ${loaded.reason}. They will not be modified until the file is fixed.`,
        );
      }
      state.corrupt = loaded.reason;
      this.docs.set(docRelPath, state);
      return state;
    }

    const state: DocState = {
      docRelPath,
      file: loaded.file,
      resolved: new Map(),
      deleted: previous?.deleted ?? new Set(),
    };
    this.docs.set(docRelPath, state);
    const text = await this.documentText(docRelPath);
    if (text !== undefined) this.reanchor(state, text);
    return state;
  }

  async ensure(docRelPath: string): Promise<DocState> {
    return this.docs.get(docRelPath) ?? (await this.load(docRelPath));
  }

  /** Current text: the open (possibly dirty) buffer if there is one, else disk. */
  async documentText(docRelPath: string): Promise<string | undefined> {
    const uri = vscode.Uri.file(path.join(this.root, ...docRelPath.split('/')));
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (open) return open.getText();
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      return undefined;
    }
  }

  /**
   * Re-run every anchor against `text`.
   *
   * `persistStatus` is false while the user is mid-keystroke: a quote can be
   * transiently unmatchable halfway through an edit, and writing 'stale' for
   * that would be a lie that outlives the edit.
   */
  reanchor(state: DocState, text: string, persistStatus = false): boolean {
    let changed = false;
    state.resolved.clear();
    for (const t of state.file.threads) {
      const hit = resolveAnchor(text, t.anchor, { threshold: this.threshold });
      if (hit) state.resolved.set(t.id, hit);
      if (!persistStatus || t.status === 'resolved') continue;

      if (!hit && t.status !== 'stale') {
        t.status = 'stale';
        t.updatedAt = nowIso();
        changed = true;
      } else if (hit && t.status === 'stale') {
        // Recovered. Whose turn it is follows from who spoke last.
        t.status = t.messages[t.messages.length - 1]?.author === 'claude' ? 'answered' : 'open';
        t.updatedAt = nowIso();
        changed = true;
      }
      if (hit?.kind === 'drifted' && !t.driftedAt) {
        t.driftedAt = nowIso();
        changed = true;
      } else if (hit?.kind === 'exact' && t.driftedAt) {
        delete t.driftedAt;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Reload from disk, re-resolve, and persist any status transitions.
   *
   * The reload matters: this is the documented recovery for a missed watcher
   * event, and it used to re-anchor the cached copy and save it — writing stale
   * data over whatever had actually changed on disk.
   */
  async refresh(docRelPath: string): Promise<void> {
    const state = await this.load(docRelPath);
    const text = await this.documentText(docRelPath);
    if (text === undefined) return;
    const changed = this.reanchor(state, text, true);
    if (changed) await this.save(docRelPath);
    else this.emitter.fire(docRelPath);
  }

  async refreshAll(): Promise<void> {
    for (const d of this.all()) await this.refresh(d.docRelPath);
  }

  async save(docRelPath: string): Promise<void> {
    const state = this.docs.get(docRelPath);
    if (!state) return;
    if (state.corrupt) {
      vscode.window.showErrorMessage(
        `Not saving comments for ${docRelPath}: its file is unreadable (${state.corrupt}).`,
      );
      return;
    }

    const file = this.reviewFilePath(docRelPath);
    // Re-read immediately before writing and merge. Another process — the MCP
    // server — holds and rewrites this same file, and without this whoever
    // writes second silently reverts the other.
    const current = await loadReview(file, docRelPath);
    if (current.kind === 'corrupt') {
      state.corrupt = current.reason;
      vscode.window.showErrorMessage(
        `Not saving comments for ${docRelPath}: its file became unreadable (${current.reason}).`,
      );
      return;
    }
    state.file = mergeReviewFiles(state.file, current.file, state.deleted);
    state.deleted.clear();

    const mtime = await writeReview(file, state.file);
    this.selfWrites.set(file, mtime);
    this.emitter.fire(docRelPath);
  }

  /** Mutate a document's threads and persist in one step. */
  async update(docRelPath: string, fn: (state: DocState) => void): Promise<DocState> {
    const state = await this.ensure(docRelPath);
    fn(state);
    const text = await this.documentText(docRelPath);
    if (text !== undefined) this.reanchor(state, text);
    await this.save(docRelPath);
    return state;
  }

  findThread(id: string): { state: DocState; thread: Thread } | undefined {
    for (const state of this.docs.values()) {
      const thread = state.file.threads.find((t) => t.id === id);
      if (thread) return { state, thread };
    }
    return undefined;
  }

  private async wasSelfWrite(file: string): Promise<boolean> {
    const ours = this.selfWrites.get(file);
    if (ours === undefined) return false;
    try {
      const stat = await fsp.stat(file);
      if (stat.mtimeMs === ours) return true;
    } catch {
      /* gone; treat as external */
    }
    // Someone else has written since; stop attributing events to us.
    this.selfWrites.delete(file);
    return false;
  }

  dispose(): void {
    for (const t of this.reanchorTimers.values()) clearTimeout(t);
    this.reanchorTimers.clear();
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
    this.reanchorEmitter.dispose();
  }
}
