import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { render, type PreviewSettings } from '../../extension/markdown.js';

/**
 * Runs whose source spelling is a longer than what they render — an entity, a
 * backslash escape — cannot have offsets interpolated inside them. They are
 * marked, and the mapping treats them as one unit rather than landing on the
 * wrong characters.
 */

const SETTINGS: PreviewSettings = {
  breaks: false,
  linkify: true,
  typographer: false,
  scrollPreviewWithEditor: true,
  scrollEditorWithPreview: true,
  markEditorSelection: true,
  doubleClickToSwitchToEditor: true,
  styles: [],
};

function mount(markdown: string) {
  const { html } = render(markdown, { settings: SETTINGS });
  const dom = new JSDOM(`<!doctype html><body><div id="doc">${html}</div></body>`);
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.Node = dom.window.Node;
  g.NodeFilter = dom.window.NodeFilter;
  return dom.window.document.getElementById('doc')!;
}

test('a run whose source matches its rendered text is exact', () => {
  const doc = mount('Keys rotate every 90 days.\n');
  const run = doc.querySelector('[data-o]')!;
  assert.equal(run.hasAttribute('data-approx'), false);
});

test('a run containing an entity is marked approximate', () => {
  // The source spends five characters on `&amp;`; the page shows one. Offsets
  // after it do not line up, and pretending they do anchors the wrong text.
  const doc = mount('Vendor is AT&amp;T today.\n');
  const run = doc.querySelector('[data-o]')!;
  assert.equal(run.hasAttribute('data-approx'), true);
});

test('a run containing a backslash escape is marked approximate', () => {
  const doc = mount('A literal \\* asterisk here.\n');
  const run = doc.querySelector('[data-o]')!;
  assert.equal(run.hasAttribute('data-approx'), true);
});

test('an approximate run still covers its whole passage when highlighted', async () => {
  const doc = mount('Vendor is AT&amp;T today.\n');
  const { rangeForSource } = await import('../../webview/textrange.js');
  const run = doc.querySelector('[data-o]')!;
  const start = Number(run.getAttribute('data-o'));
  const end = Number(run.getAttribute('data-e'));
  const range = rangeForSource(doc, start, end);
  assert.ok(range);
  assert.equal(range.toString(), 'Vendor is AT&T today.');
});
