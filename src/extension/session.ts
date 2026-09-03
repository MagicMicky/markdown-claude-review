import * as vscode from 'vscode';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveAnchor } from '../core/anchor.js';
import {
  DEFAULT_REVIEW_DIR,
  docRelPathFor,
  listReviewFiles,
  readReview,
  reviewPathFor,
  writeReview,
} from '../core/store.js';
import { nowIso, type ReviewFile, type ResolvedAnchor, type Thread } from '../core/types.js';

const execFileAsync = promisify(execFile);

export interface DocState {
  /** Workspace-relative, forward-slashed. */
  docRelPath: string;
  file: ReviewFile;
  /** Live positions, keyed by thread id. Absent means the anchor did not resolve. */
  resolved: Map<string, ResolvedAnchor>;
}

/**
 * Owns every review file in the workspace: reads, writes, and keeps anchors
 * resolved against current document text. The comment UI and the tree view are
 * both projections of this.
 */
export class Session implements vscode.Disposable {
  private readonly docs = new Map<string, DocState>();
  private readonly emitter = new vscode.EventEmitter<string | undefined>();
  /** Paths we just wrote, so the file watcher does not echo our own changes back. */
  private readonly selfWrites = new Map<string, number>();
  private authorName = 'You';
  private disposables: vscode.Disposable[] = [];

  /** Fires with a docRelPath, or undefined when everything changed. */
  readonly onDidChange = this.emitter.event;

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
      if (this.wasSelfWrite(uri.fsPath)) return;
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

    for (const f of await listReviewFiles(this.root, this.reviewDir)) {
      await this.load(docRelPathFor(this.root, this.reviewDir, f));
    }
    this.emitter.fire(undefined);
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
    const file = await readReview(this.reviewFilePath(docRelPath), docRelPath);
    const state: DocState = { docRelPath, file, resolved: new Map() };
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

  /** Re-resolve against current text and persist any status transitions. */
  async refresh(docRelPath: string): Promise<void> {
    const state = await this.ensure(docRelPath);
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
    const file = this.reviewFilePath(docRelPath);
    this.selfWrites.set(file, Date.now());
    await writeReview(file, state.file);
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

  private wasSelfWrite(file: string): boolean {
    const at = this.selfWrites.get(file);
    if (at === undefined) return false;
    if (Date.now() - at > 3000) {
      this.selfWrites.delete(file);
      return false;
    }
    this.selfWrites.delete(file);
    return true;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }
}
