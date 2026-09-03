import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEXT_RUN_CLASS, render, type PreviewSettings } from '../extension/markdown.js';

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

interface Run {
  start: number;
  end: number;
  text: string;
}

/** Every element carrying source offsets, with the text it renders. */
function runs(html: string): Run[] {
  const out: Run[] = [];
  const re = /<(\w+)[^>]*\bdata-o="(\d+)"[^>]*\bdata-e="(\d+)"[^>]*>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({
      start: Number(m[2]),
      end: Number(m[3]),
      text: m[4]
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&'),
    });
  }
  return out;
}

const html = (src: string) => render(src, { settings: SETTINGS }).html;

/**
 * The whole point of the offsets: what the page shows must be exactly what the
 * source says at those positions. Guessing which characters were markup is
 * what used to make highlights vanish.
 */
function assertRunsQuoteSource(src: string, decodeEntities = false): Run[] {
  const found = runs(html(src));
  assert.ok(found.length > 0, `no source offsets emitted for: ${src}`);
  for (const r of found) {
    const fromSource = decodeEntities
      ? src.slice(r.start, r.end).replace(/&(\w+);/g, (_, e) => (e === 'amp' ? '&' : _))
      : src.slice(r.start, r.end);
    assert.equal(r.text, fromSource, `run [${r.start},${r.end}) for: ${src}`);
  }
  return found;
}

test('an identifier with underscores is not mistaken for emphasis', () => {
  // This produced `maxretrycount`, which appears nowhere on the page.
  const [run] = assertRunsQuoteSource('The max_retry_count is five.');
  assert.equal(run.text, 'The max_retry_count is five.');
});

test('offsets skip emphasis markers without swallowing the words', () => {
  const found = assertRunsQuoteSource('Keys rotate via the **KMS pipeline** daily.');
  assert.ok(found.some((r) => r.text === 'KMS pipeline'));
});

test('a link contributes its label, not its destination', () => {
  const found = assertRunsQuoteSource('See [the policy](https://example.com/p) now.');
  assert.ok(found.some((r) => r.text === 'the policy'));
  assert.ok(!found.some((r) => r.text.includes('example.com')));
});

test('inline code is addressable', () => {
  const found = assertRunsQuoteSource('Set `rotation_period` to 30d.');
  assert.ok(found.some((r) => r.text === 'rotation_period'));
});

test('table cells each get their own offsets', () => {
  const src = '| Key | Rotation |\n| --- | --- |\n| KMS | 30d |';
  const found = assertRunsQuoteSource(src);
  assert.ok(found.some((r) => r.text === 'Rotation'));
  assert.ok(found.some((r) => r.text === '30d'));
});

test('raw HTML in the document does not break the mapping', () => {
  const found = assertRunsQuoteSource('The <b>signing key</b> is stored in the vault.');
  assert.ok(found.some((r) => r.text === 'signing key'));
});

test('a task list marker is not treated as emphasis', () => {
  assertRunsQuoteSource('- [ ] Rotate the signing key');
});

test('asterisks used as arithmetic stay literal', () => {
  const [run] = assertRunsQuoteSource('Math: 3 * 4 * 5 equals sixty.');
  assert.equal(run.text, 'Math: 3 * 4 * 5 equals sixty.');
});

test('an entity maps to the source it was written as', () => {
  // The page shows `&`; the source spent five characters on it. The offsets
  // must cover the source spelling, or the anchor would be short.
  const src = 'Vendor is AT&amp;T today.';
  const [run] = runs(html(src));
  assert.equal(run.text, 'Vendor is AT&T today.');
  assert.equal(src.slice(run.start, run.end), 'Vendor is AT&amp;T today.');
});

test('a fenced code block is addressable as one run', () => {
  const src = '```js\nconst x = [1,2,3];\n```';
  const [run] = runs(html(src));
  assert.equal(src.slice(run.start, run.end), 'const x = [1,2,3];\n');
});

test('blocks carry both their start and end line', () => {
  const { blocks } = render('# One\n\nTwo\n\nThree\n', { settings: SETTINGS });
  assert.ok(blocks.length >= 3);
  for (const b of blocks) assert.ok(b.endLine > b.startLine, 'end line must be real, not inferred');
});

test('runs never overlap and always advance', () => {
  const src = 'A **bold** and `code` and [link](x) and _em_ in one paragraph.\n';
  let previousEnd = -1;
  for (const r of runs(html(src))) {
    assert.ok(r.start >= previousEnd, `run [${r.start},${r.end}) overlaps the previous one`);
    assert.ok(r.end > r.start);
    previousEnd = r.end;
  }
});

test('the run class is applied so the webview can find them', () => {
  assert.ok(html('plain text').includes(TEXT_RUN_CLASS));
});
