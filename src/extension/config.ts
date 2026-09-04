import * as vscode from 'vscode';
import type { PreviewSettings } from './markdown.js';

export type { PreviewSettings };

/** How comment threads appear in the editor itself. */
export type InlineMode = 'collapsed' | 'expanded' | 'off';

export function inlineMode(): InlineMode {
  const raw = vscode.workspace
    .getConfiguration('mdreview')
    .get<string>('inlineThreads', 'collapsed');
  return raw === 'expanded' || raw === 'off' ? raw : 'collapsed';
}

/**
 * Whether the preview lists closed threads alongside the live ones.
 *
 * Off by default: the preview is the working surface, and the inline widget is
 * where the closed history normally lives. Turning it on is a read-through of
 * what was already decided, so resolved bubbles offer Reopen rather than
 * Resolve and never re-attach.
 */
export function showResolvedInPreview(): boolean {
  return vscode.workspace.getConfiguration('mdreview').get('showResolvedInPreview', false);
}

export function previewSettings(resource?: vscode.Uri): PreviewSettings {
  const md = vscode.workspace.getConfiguration('markdown', resource);
  return {
    breaks: md.get('preview.breaks', false),
    linkify: md.get('preview.linkify', true),
    typographer: md.get('preview.typographer', false),
    fontFamily: md.get<string>('preview.fontFamily'),
    fontSize: md.get<number>('preview.fontSize'),
    lineHeight: md.get<number>('preview.lineHeight'),
    scrollPreviewWithEditor: md.get('preview.scrollPreviewWithEditor', true),
    scrollEditorWithPreview: md.get('preview.scrollEditorWithPreview', true),
    markEditorSelection: md.get('preview.markEditorSelection', true),
    doubleClickToSwitchToEditor: md.get('preview.doubleClickToSwitchToEditor', true),
    styles: md.get<string[]>('styles', []),
  };
}
