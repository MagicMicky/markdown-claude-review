import * as vscode from 'vscode';
import type { Thread, ThreadStatus } from '../core/types.js';
import type { Session } from './session.js';

const ICON: Record<ThreadStatus, vscode.ThemeIcon> = {
  open: new vscode.ThemeIcon('comment', new vscode.ThemeColor('charts.blue')),
  answered: new vscode.ThemeIcon('comment-discussion', new vscode.ThemeColor('charts.yellow')),
  resolved: new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green')),
  stale: new vscode.ThemeIcon('unlink', new vscode.ThemeColor('charts.orange')),
};

const ORDER: ThreadStatus[] = ['open', 'stale', 'answered', 'resolved'];

type Node = { kind: 'doc'; docRelPath: string } | { kind: 'thread'; docRelPath: string; thread: Thread };

/** Every thread in the workspace, including resolved and stale ones — the history view. */
export class ThreadTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly session: Session) {
    session.onDidChange(() => this.emitter.fire(undefined));
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.session
        .all()
        .filter((d) => d.file.threads.length > 0)
        .map((d) => ({ kind: 'doc', docRelPath: d.docRelPath }) as Node);
    }
    if (node.kind !== 'doc') return [];
    const state = this.session.get(node.docRelPath);
    if (!state) return [];
    return [...state.file.threads]
      .sort(
        (a, b) =>
          ORDER.indexOf(a.status) - ORDER.indexOf(b.status) ||
          a.createdAt.localeCompare(b.createdAt),
      )
      .map((thread) => ({ kind: 'thread', docRelPath: node.docRelPath, thread }) as Node);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'doc') {
      const state = this.session.get(node.docRelPath);
      const open = state?.file.threads.filter((t) => t.status === 'open' || t.status === 'stale').length ?? 0;
      const item = new vscode.TreeItem(
        node.docRelPath,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon('markdown');
      item.description = open ? `${open} open` : 'all addressed';
      item.contextValue = 'doc';
      return item;
    }

    const t = node.thread;
    const first = t.messages[0];
    const last = t.messages[t.messages.length - 1];
    const item = new vscode.TreeItem(
      first ? first.body.split('\n')[0].slice(0, 80) : t.id,
      vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = ICON[t.status];
    item.description = [
      t.anchor.headingPath[t.anchor.headingPath.length - 1] ?? '(root)',
      t.messages.length > 1 ? `${t.messages.length} msgs` : undefined,
      t.driftedAt ? 'text edited' : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
    item.tooltip = new vscode.MarkdownString(
      [
        `**${t.anchor.headingPath.join(' › ') || '(document root)'}**`,
        '',
        '> ' + t.anchor.quote.trim().split('\n').join('\n> '),
        '',
        ...t.messages.map(
          (m) => `**${m.author === 'claude' ? 'Claude' : m.authorName}:** ${m.body}`,
        ),
        '',
        `_${t.status}, last activity ${new Date(last?.ts ?? t.updatedAt).toLocaleString()}_`,
      ].join('\n'),
    );
    item.contextValue = `thread.${t.status}`;
    item.command = {
      command: 'mdreview.revealThread',
      title: 'Go to Thread',
      arguments: [t.id],
    };
    return item;
  }
}
