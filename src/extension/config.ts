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
