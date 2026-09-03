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
  loadReview,
  mergeReviewFiles,
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

  const back = await loadReview(file, 'docs/a.md');
  assert.equal(back.kind, 'ok');
  assert.equal(back.kind === 'ok' && back.file.threads.length, 1);
  assert.equal(back.kind === 'ok' && back.file.threads[0].id, t.id);
  assert.deepEqual(await listReviewFiles(root, '.review'), [file]);
  await fsp.rm(root, { recursive: true, force: true });
});

test('an absent file is missing; an unreadable one is corrupt, never empty', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdreview-'));
  const file = reviewPathFor(root, '.review', 'x.md');

  // Absent is safe to write over.
  const absent = await loadReview(file, 'x.md');
  assert.equal(absent.kind, 'missing');

  // Unreadable is NOT. Reporting it as empty would let the next save erase
  // every comment in it — the file is the only copy of that history.
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, '<<<<<<< HEAD\n{ "threads": [] }\n=======');
  assert.equal((await loadReview(file, 'x.md')).kind, 'corrupt');

  await fsp.rm(root, { recursive: true, force: true });
});

test('a structurally broken thread makes the file corrupt, not a crash later', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdreview-'));
  const file = reviewPathFor(root, '.review', 'x.md');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // This used to load fine, then throw inside resolveAnchor during activate().
  await fsp.writeFile(
    file,
    JSON.stringify({ version: 1, document: 'x.md', threads: [{ id: 'a', status: 'open', messages: [] }] }),
  );
  const loaded = await loadReview(file, 'x.md');
  assert.equal(loaded.kind, 'corrupt');
  assert.match(loaded.kind === 'corrupt' ? loaded.reason : '', /missing required fields/);
  await fsp.rm(root, { recursive: true, force: true });
});

test('merging keeps both sides: their reply and our resolve both survive', () => {
  const base = sampleThread();
  const ours = structuredClone(base);
  setStatus(ours, 'resolved');

  const theirs = structuredClone(base);
  appendMessage(theirs, makeMessage('claude', 'Claude', 'modules/kms sets 30d.'));

  const merged = mergeReviewFiles(
    { version: 1, document: 'a.md', threads: [ours] },
    { version: 1, document: 'a.md', threads: [theirs] },
  );
  assert.equal(merged.threads.length, 1);
  assert.equal(merged.threads[0].messages.length, 2, "Claude's reply must not be reverted");
  assert.equal(merged.threads[0].status, 'resolved', 'and neither must our resolve');
});

test('merging adopts threads created by the other process', () => {
  const mine = sampleThread();
  const theirs = { ...sampleThread(), id: 'mr_theirs' };
  const merged = mergeReviewFiles(
    { version: 1, document: 'a.md', threads: [mine] },
    { version: 1, document: 'a.md', threads: [theirs] },
  );
  assert.deepEqual(merged.threads.map((t) => t.id).sort(), [mine.id, 'mr_theirs'].sort());
});

test('a thread we deleted does not come back from disk', () => {
  const t = sampleThread();
  const merged = mergeReviewFiles(
    { version: 1, document: 'a.md', threads: [] },
    { version: 1, document: 'a.md', threads: [t] },
    new Set([t.id]),
  );
  assert.deepEqual(merged.threads, []);
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



