import * as vscode from 'vscode';
import type { InlineMode } from '../core/sidebarProtocol.js';
import type { Scope } from '../core/sidebar.js';

/** How comment threads appear in the editor itself. */
export function inlineMode(): InlineMode {
  const raw = vscode.workspace.getConfiguration('mdreview').get<string>('inlineThreads', 'collapsed');
  return raw === 'expanded' || raw === 'off' ? raw : 'collapsed';
}

export function defaultScope(): Scope {
  return vscode.workspace.getConfiguration('mdreview').get<string>('sidebar.defaultScope', 'document') ===
    'workspace'
    ? 'workspace'
    : 'document';
}

export function showResolvedByDefault(): boolean {
  return vscode.workspace.getConfiguration('mdreview').get('sidebar.showResolved', false);
}
