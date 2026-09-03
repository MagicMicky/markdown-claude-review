import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockRange,
  lineOffsets,
  locateInSource,
  renderedNeedle,
  stripInline,
} from '../core/rendermap.js';

/* ---------------- offsets ---------------- */

test('lineOffsets marks the start of every line', () => {
  assert.deepEqual(lineOffsets('a\nbb\n\nc'), [0, 2, 5, 6]);
  assert.deepEqual(lineOffsets(''), [0]);
});

test('blockRange turns a token.map pair into character offsets', () => {
  const src = 'one\ntwo\nthree\n';
  const r = blockRange(src, 1, 2);
  assert.equal(src.slice(r.start, r.end), 'two\n');
});

test('blockRange clamps an end line past the document', () => {
  const src = 'one\ntwo';
  const r = blockRange(src, 1, 99);
  assert.equal(src.slice(r.start, r.end), 'two');
});

/* ---------------- stripInline ---------------- */

/** Every surviving character must point at an identical source character. */
function assertMapConsistent(source: string): void {
  const { text, map } = stripInline(source);
  assert.equal(text.length, map.length, `map length for: ${source}`);
  for (let i = 0; i < text.length; i++) {
    assert.equal(source[map[i]], text[i], `map[${i}] for: ${source}`);
  }
}

test('the offset map is consistent across every construct', () => {
  for (const s of [
    'plain prose with nothing special',
    'text with **strong** in it',
    'text with _emphasis_ and *more*',
    'text with `inline code` in it',
    'a [link label](https://example.com) here',
    'an ![image alt](img.png) here',
    'an autolink <https://example.com> here',
    'escaped \\* asterisk and \\_ underscore',
    '## A heading',
    '- a list item',
    '1. an ordered item',
    '> a block quote',
    'nested **bold with `code` inside** here',
    'multi\nline\nparagraph',
  ]) {
    assertMapConsistent(s);
  }
});

test('emphasis and strong markers are removed, text preserved', () => {
  assert.equal(stripInline('a **bold** word').text, 'a bold word');
  assert.equal(stripInline('a _quiet_ word').text, 'a quiet word');
  assert.equal(stripInline('a ~~struck~~ word').text, 'a struck word');
});

test('inline code keeps its contents and drops the fences', () => {
  assert.equal(stripInline('run `npm test` now').text, 'run npm test now');
  assert.equal(stripInline('a ``literal ` tick`` here').text, 'a literal ` tick here');
});

test('links keep the label and drop the destination', () => {
  assert.equal(stripInline('see [the policy](https://x.com/y) now').text, 'see the policy now');
  assert.equal(stripInline('see [the policy][ref] now').text, 'see the policy now');
});

test('images drop the marker and the destination', () => {
  assert.equal(stripInline('an ![diagram](a.png) here').text, 'an diagram here');
});

test('autolinks keep the target', () => {
  assert.equal(stripInline('go <https://example.com> now').text, 'go https://example.com now');
});

test('backslash escapes yield the literal character', () => {
  assert.equal(stripInline('a \\* literal star').text, 'a * literal star');
  assert.equal(stripInline('a \\_ literal underscore').text, 'a _ literal underscore');
});

test('leading block markers are removed', () => {
  assert.equal(stripInline('### 3.2 Key Rotation').text, '3.2 Key Rotation');
  assert.equal(stripInline('- an item').text, 'an item');
  assert.equal(stripInline('1. an item').text, 'an item');
  assert.equal(stripInline('> quoted').text, 'quoted');
  assert.equal(stripInline('>> deeply quoted').text, 'deeply quoted');
});

test('markers only count at the start of a line', () => {
  assert.equal(stripInline('rates are 5 - 10 percent').text, 'rates are 5 - 10 percent');
});

/* ---------------- locateInSource ---------------- */

const DOC = `# Access Control Policy

## 3.2 Key Rotation

Keys are rotated every 90 days via the **KMS pipeline**.
Audit logs are retained for [one year](https://example.com/retention).

Keys are rotated every 90 days via the KMS pipeline.
`;

function paragraph(startLine: number, endLine: number) {
  return blockRange(DOC, startLine, endLine);
}

test('a verbatim selection is located exactly', () => {
  const block = paragraph(4, 6);
  const hit = locateInSource(DOC, block, 'Keys are rotated every 90 days');
  assert.ok(hit);
  assert.equal(hit.precision, 'exact');
  assert.equal(DOC.slice(hit.start, hit.end), 'Keys are rotated every 90 days');
});

test('a selection spanning a bold run maps back through the stripped text', () => {
  const block = paragraph(4, 6);
  // What the DOM gives us: the rendered text, with no asterisks.
  const hit = locateInSource(DOC, block, 'every 90 days via the KMS pipeline.');
  assert.ok(hit);
  assert.equal(hit.precision, 'stripped');
  const slice = DOC.slice(hit.start, hit.end);
  assert.ok(slice.includes('**KMS pipeline**'), `got: ${slice}`);
  assert.ok(slice.startsWith('every 90 days'));
});

test('a selection spanning a link maps back to the source including its target', () => {
  const block = paragraph(4, 6);
  const hit = locateInSource(DOC, block, 'retained for one year');
  assert.ok(hit);
  assert.equal(hit.precision, 'stripped');
  const slice = DOC.slice(hit.start, hit.end);
  assert.ok(slice.includes('[one year]'), `got: ${slice}`);
});

test('a range clipping a link is snapped out to cover the whole construct', () => {
  const block = paragraph(4, 6);
  const hit = locateInSource(DOC, block, 'retained for one year');
  assert.ok(hit);
  const slice = DOC.slice(hit.start, hit.end);
  assert.ok(
    slice.endsWith('[one year](https://example.com/retention)'),
    `a quote must not stop halfway through a link; got: ${slice}`,
  );
});

test('a range clipping emphasis absorbs the delimiters', () => {
  const src = 'Keys rotate via the **KMS pipeline** daily.\n';
  const hit = locateInSource(src, blockRange(src, 0, 1), 'via the KMS pipeline');
  assert.ok(hit);
  assert.equal(src.slice(hit.start, hit.end), 'via the **KMS pipeline**');
});

test('an unlocatable selection falls back to the whole block, never a wrong span', () => {
  const block = paragraph(4, 6);
  const hit = locateInSource(DOC, block, 'text that simply is not there at all');
  assert.ok(hit);
  assert.equal(hit.precision, 'block');
  assert.equal(DOC.slice(hit.start, hit.end).split('\n')[0], 'Keys are rotated every 90 days via the **KMS pipeline**.');
});

test('the block boundary keeps a repeated sentence in its own paragraph', () => {
  const first = locateInSource(DOC, paragraph(4, 6), 'Keys are rotated every 90 days via the KMS pipeline.');
  const second = locateInSource(DOC, paragraph(7, 8), 'Keys are rotated every 90 days via the KMS pipeline.');
  assert.ok(first && second);
  assert.notEqual(first.start, second.start, 'identical text in two blocks must not collapse to one');
  assert.equal(second.precision, 'exact');
});

test('an empty or whitespace selection is refused', () => {
  assert.equal(locateInSource(DOC, paragraph(4, 6), '   '), null);
  assert.equal(locateInSource(DOC, paragraph(4, 6), ''), null);
});

test('selection whitespace need not match the source line wrapping', () => {
  const src = 'The quick brown\nfox jumps over.\n';
  const hit = locateInSource(src, blockRange(src, 0, 2), 'quick brown fox jumps');
  assert.ok(hit);
  assert.equal(hit.precision, 'stripped');
  assert.ok(src.slice(hit.start, hit.end).includes('fox jumps'));
});

/* ---------------- renderedNeedle ---------------- */

test('renderedNeedle produces text that locateInSource can round-trip', () => {
  const block = paragraph(4, 6);
  const original = { start: DOC.indexOf('every 90 days'), end: DOC.indexOf('pipeline**.') + 'pipeline**.'.length };
  const needle = renderedNeedle(DOC, original);

  assert.ok(!needle.includes('*'), 'the needle is what the DOM shows, so no markup');
  const back = locateInSource(DOC, block, needle);
  assert.ok(back);
  assert.equal(back.start, original.start);
});

test('renderedNeedle strips a link down to its label', () => {
  const range = { start: DOC.indexOf('[one year]'), end: DOC.indexOf('retention)') + 'retention)'.length };
  assert.equal(renderedNeedle(DOC, range), 'one year');
});
