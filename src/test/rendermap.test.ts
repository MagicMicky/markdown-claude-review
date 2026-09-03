import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockRange, lineOffsets } from '../core/rendermap.js';

test('lineOffsets marks the start of every line', () => {
  assert.deepEqual(lineOffsets('a\nbb\n\nc'), [0, 2, 5, 6]);
  assert.deepEqual(lineOffsets(''), [0]);
});

test('blockRange turns a token.map pair into character offsets', () => {
  const src = 'one\ntwo\nthree\n';
  assert.equal(src.slice(...offsetsOf(src, 1, 2)), 'two\n');
});

test('blockRange clamps an end line past the document', () => {
  const src = 'one\ntwo';
  assert.equal(src.slice(...offsetsOf(src, 1, 99)), 'two');
});

test('precomputed offsets give the same answer as computing them per call', () => {
  const src = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const shared = lineOffsets(src);
  for (let i = 0; i < 49; i++) {
    assert.deepEqual(blockRange(src, i, i + 1, shared), blockRange(src, i, i + 1));
  }
});

function offsetsOf(src: string, a: number, b: number): [number, number] {
  const r = blockRange(src, a, b);
  return [r.start, r.end];
}
