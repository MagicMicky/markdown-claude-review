import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { render, type PreviewSettings } from '../../extension/markdown.js';

/**
 * The mapping between rendered DOM and markdown source, tested end to end:
 * real renderer output, real DOM, real Ranges.
 *
 * This layer had three regressions in a row while every other test stayed
 * green, because nothing exercised it. Each case below is a shape that broke.
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

let rangeForSource: typeof import('../../webview/textrange.js').rangeForSource;
let selectionRange: typeof import('../../webview/textrange.js').selectionRange;
let sourceOffsetAt: typeof import('../../webview/textrange.js').sourceOffsetAt;

before(async () => {
  // textrange.ts reaches for globals at call time, so they must exist first.
  const dom = new JSDOM('<!doctype html><body><div id="doc"></div></body>');
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.Node = dom.window.Node;
  g.NodeFilter = dom.window.NodeFilter;
  ({ rangeForSource, selectionRange, sourceOffsetAt } = await import('../../webview/textrange.js'));
});

/** Render markdown into a document, as the preview does. */
function mount(markdown: string): { doc: Element; win: Window & typeof globalThis } {
  const { html } = render(markdown, { settings: SETTINGS });
  const dom = new JSDOM(`<!doctype html><body><div id="doc">${html}</div></body>`);
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.Node = dom.window.Node;
  g.NodeFilter = dom.window.NodeFilter;
  return {
    doc: dom.window.document.getElementById('doc')!,
    win: dom.window as unknown as Window & typeof globalThis,
  };
}

function select(win: Window, apply: (r: Range) => void): Selection {
  const range = win.document.createRange();
  apply(range);
  const sel = win.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

/* ---------------- highlighting: source range -> DOM ---------------- */

test('a highlight lands on the passage its offsets name', () => {
  const src = 'Keys are rotated every 90 days via the KMS pipeline.\n';
  const { doc } = mount(src);
  const start = src.indexOf('every 90 days');
  const range = rangeForSource(doc, start, start + 'every 90 days'.length);
  assert.ok(range);
  assert.equal(range.toString(), 'every 90 days');
});

test('a highlight spans paragraphs', () => {
  const src = 'Keys rotate every 90 days.\n\nAudit logs are kept for a year.\n';
  const { doc } = mount(src);
  const range = rangeForSource(doc, src.indexOf('every 90'), src.indexOf('kept for') + 8);
  assert.ok(range, 'a comment across a paragraph break must still highlight');
  const text = range.toString();
  assert.ok(text.includes('every 90'), text);
  assert.ok(text.includes('kept for'), text);
});

test('a highlight survives inline markup inside the passage', () => {
  const src = 'Keys rotate via the **KMS pipeline** every day.\n';
  const { doc } = mount(src);
  const range = rangeForSource(doc, src.indexOf('via the'), src.indexOf('every day'));
  assert.ok(range);
  assert.ok(range.toString().includes('KMS pipeline'), range.toString());
});

test('a highlight lands inside a table cell, not the whole table', () => {
  const src = '| Key | Rotation |\n| --- | --- |\n| KMS | 30d |\n';
  const { doc } = mount(src);
  const range = rangeForSource(doc, src.indexOf('30d'), src.indexOf('30d') + 3);
  assert.ok(range);
  assert.equal(range.toString(), '30d');
});

test('a highlight lands inside a fenced code block', () => {
  const src = '```js\nconst x = 1;\n```\n';
  const { doc } = mount(src);
  const at = src.indexOf('const x = 1;');
  const range = rangeForSource(doc, at, at + 'const x = 1;'.length);
  assert.ok(range, 'code blocks used to get no highlight at all');
  assert.ok(range.toString().includes('const'), range.toString());
});

test('an identifier with underscores highlights', () => {
  const src = 'The max_retry_count is five.\n';
  const { doc } = mount(src);
  const at = src.indexOf('max_retry_count');
  const range = rangeForSource(doc, at, at + 'max_retry_count'.length);
  assert.ok(range, 'underscores were being read as emphasis');
  assert.equal(range.toString(), 'max_retry_count');
});

test('a range covering no rendered text yields no highlight rather than a wrong one', () => {
  const src = 'Some prose here.\n';
  const { doc } = mount(src);
  assert.equal(rangeForSource(doc, 9999, 10000), null);
});

/* ---------------- selection: DOM -> source range ---------------- */

test('selecting a word gives back exactly that word', () => {
  const src = 'Keys are rotated every 90 days.\n';
  const { doc, win } = mount(src);
  const textNode = doc.querySelector('[data-o]')!.firstChild!;
  const at = src.indexOf('rotated');
  const sel = select(win, (r) => {
    r.setStart(textNode, at);
    r.setEnd(textNode, at + 'rotated'.length);
  });
  assert.deepEqual(selectionRange(doc, sel), { start: at, end: at + 'rotated'.length });
});

test('triple-clicking a paragraph is not treated as selecting nothing', () => {
  // The end point lands on the <p>, which carries no offsets. Requiring both
  // endpoints to resolve made the Comment button silently never appear.
  const src = 'Keys are rotated every 90 days.\n';
  const { doc, win } = mount(src);
  const p = doc.querySelector('p')!;
  const sel = select(win, (r) => r.selectNodeContents(p));
  const range = selectionRange(doc, sel);
  assert.ok(range, 'triple-click must produce a commentable range');
  assert.equal(src.slice(range.start, range.end).trim(), 'Keys are rotated every 90 days.');
});

test('selecting across two paragraphs produces one range covering both', () => {
  const src = 'First paragraph here.\n\nSecond paragraph here.\n';
  const { doc, win } = mount(src);
  const ps = doc.querySelectorAll('p');
  const sel = select(win, (r) => {
    r.setStart(ps[0].firstChild!.firstChild ?? ps[0].firstChild!, 0);
    r.selectNodeContents(ps[1]);
    r.setStartBefore(ps[0]);
  });
  const range = selectionRange(doc, sel);
  assert.ok(range);
  const covered = src.slice(range.start, range.end);
  assert.ok(covered.includes('First'), covered);
  assert.ok(covered.includes('Second'), covered);
});

test('selecting a table cell maps to that cell', () => {
  const src = '| Key | Rotation |\n| --- | --- |\n| KMS | 30d |\n';
  const { doc, win } = mount(src);
  const cells = doc.querySelectorAll('td');
  const sel = select(win, (r) => r.selectNodeContents(cells[cells.length - 1]));
  const range = selectionRange(doc, sel);
  assert.ok(range);
  assert.equal(src.slice(range.start, range.end), '30d');
});

test('a selection outside the rendered document is refused', () => {
  const src = 'Prose.\n';
  const { doc, win } = mount(src);
  const outside = win.document.createElement('div');
  outside.textContent = 'a reply typed in a bubble';
  win.document.body.append(outside);
  const sel = select(win, (r) => r.selectNodeContents(outside));
  assert.equal(selectionRange(doc, sel), null, 'commenting on a bubble is not commenting on the doc');
});

test('a collapsed selection is refused', () => {
  const src = 'Prose here.\n';
  const { doc, win } = mount(src);
  const node = doc.querySelector('[data-o]')!.firstChild!;
  const sel = select(win, (r) => {
    r.setStart(node, 3);
    r.setEnd(node, 3);
  });
  assert.equal(selectionRange(doc, sel), null);
});

/* ---------------- round trip ---------------- */

test('a selection round-trips back to the same highlight', () => {
  const src = 'Keys rotate via the **KMS pipeline** every day.\n';
  const { doc, win } = mount(src);
  const run = [...doc.querySelectorAll('[data-o]')].find((e) => e.textContent === 'KMS pipeline')!;
  const sel = select(win, (r) => r.selectNodeContents(run));
  const range = selectionRange(doc, sel)!;
  assert.ok(range);
  const back = rangeForSource(doc, range.start, range.end);
  assert.ok(back);
  assert.equal(back.toString(), 'KMS pipeline');
});

test('sourceOffsetAt reports a position inside a run', () => {
  const src = 'Keys are rotated.\n';
  const { doc } = mount(src);
  const node = doc.querySelector('[data-o]')!.firstChild!;
  assert.equal(sourceOffsetAt(node, 5), 5);
});
