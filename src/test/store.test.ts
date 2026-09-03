import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import {
  appendMessage,
  docRelPathFor,
  listReviewFiles,
  makeMessage,
  newThread,
  readReview,
  reviewPathFor,
  setStatus,
  writeReview,
} from '../core/store.js';
import { buildAnchor } from '../core/anchor.js';

const DOC = '# Doc\n\n## Section A\n\nThe original sentence lives here.\n';

function sampleThread() {
  const start = DOC.indexOf('The original sentence');
  const anchor = buildAnchor(DOC, start, start + 'The original sentence lives here.'.length);
  return newThread(anchor, makeMessage('user', 'Mickael', 'This is not factual, check work/terraform.'));
}

test('review path mirrors the document path', () => {
  const p = reviewPathFor('/w', '.review', 'docs/a/b.md');
  assert.equal(p, path.join('/w', '.review', 'docs', 'a', 'b.md.review.json'));
  assert.equal(docRelPathFor('/w', '.review', p), 'docs/a/b.md');
});

test('round-trips through disk and lists files', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdreview-'));
  const file = reviewPathFor(root, '.review', 'docs/a.md');
  const t = sampleThread();
  await writeReview(file, { version: 1, document: 'docs/a.md', threads: [t] });

  const back = await readReview(file, 'docs/a.md');
  assert.equal(back.threads.length, 1);
  assert.equal(back.threads[0].id, t.id);
  assert.deepEqual(await listReviewFiles(root, '.review'), [file]);
  await fsp.rm(root, { recursive: true, force: true });
});

test('missing or corrupt files read as empty, never throw', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdreview-'));
  const file = reviewPathFor(root, '.review', 'x.md');
  assert.deepEqual((await readReview(file, 'x.md')).threads, []);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, '{ not json');
  assert.deepEqual((await readReview(file, 'x.md')).threads, []);
  await fsp.rm(root, { recursive: true, force: true });
});

test('replies flip whose turn it is', () => {
  const t = sampleThread();
  assert.equal(t.status, 'open');
  appendMessage(t, makeMessage('claude', 'Claude', 'Which module should I look at?'));
  assert.equal(t.status, 'answered');
  appendMessage(t, makeMessage('user', 'Mickael', 'modules/kms.'));
  assert.equal(t.status, 'open');
});

test('a resolved thread stays resolved when replied to', () => {
  const t = setStatus(sampleThread(), 'resolved');
  appendMessage(t, makeMessage('claude', 'Claude', 'Fixed.'));
  assert.equal(t.status, 'resolved');
});



