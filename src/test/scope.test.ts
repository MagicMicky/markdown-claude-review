import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CANDIDATE_SECTIONS,
  candidateDocuments,
  matchesStatus,
  type CandidateInput,
} from '../core/scope.js';
import type { Thread, ThreadStatus } from '../core/types.js';

function thread(status: ThreadStatus, headingPath: string[] = ['Section A']): Thread {
  return {
    id: `t_${status}_${headingPath.join('/')}_${Math.random().toString(36).slice(2, 6)}`,
    anchor: { quote: 'q', prefix: '', suffix: '', headingPath },
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [],
  };
}

function doc(document: string, ...threads: Thread[]): CandidateInput {
  return { document, threads };
}

test('needs_attention is open plus stale, and nothing else', () => {
  const wanted: ThreadStatus[] = ['open', 'stale'];
  for (const status of ['open', 'answered', 'resolved', 'stale'] as ThreadStatus[]) {
    assert.equal(
      matchesStatus(thread(status), 'needs_attention'),
      wanted.includes(status),
      `needs_attention disagreed about ${status}`,
    );
    assert.ok(matchesStatus(thread(status), 'all'));
    assert.ok(matchesStatus(thread(status), status));
  }
});

test('a document with nothing matching is not a candidate', () => {
  const candidates = candidateDocuments(
    [doc('a.md', thread('resolved')), doc('b.md', thread('open'))],
    'needs_attention',
  );
  assert.deepEqual(
    candidates.map((c) => c.document),
    ['b.md'],
  );
});

test('candidates count what matched and say where it sits', () => {
  const candidates = candidateDocuments(
    [
      doc(
        'policies/egress.md',
        thread('open', ['Egress rules']),
        thread('open', ['Egress rules']),
        thread('stale', ['Default deny']),
        thread('resolved', ['Anything else']),
      ),
    ],
    'needs_attention',
  );
  assert.deepEqual(candidates, [
    {
      document: 'policies/egress.md',
      matching: 3,
      status: { open: 2, stale: 1 },
      sections: ['Egress rules', 'Default deny'],
    },
  ]);
});

test('a thread outside any heading is still placeable', () => {
  const [c] = candidateDocuments([doc('a.md', thread('open', []))], 'needs_attention');
  assert.deepEqual(c.sections, ['(document root)']);
});

test('the section list stays short enough to read', () => {
  const threads = Array.from({ length: MAX_CANDIDATE_SECTIONS + 3 }, (_, i) =>
    thread('open', [`Section ${i}`]),
  );
  const [c] = candidateDocuments([doc('a.md', ...threads)], 'needs_attention');
  assert.equal(c.sections.length, MAX_CANDIDATE_SECTIONS + 1);
  assert.equal(c.sections[MAX_CANDIDATE_SECTIONS], '… 3 more');
  assert.equal(c.matching, MAX_CANDIDATE_SECTIONS + 3);
});

test('nested headings are shown as their trail', () => {
  const [c] = candidateDocuments(
    [doc('a.md', thread('open', ['3. Access Control', '3.2 Key Rotation']))],
    'needs_attention',
  );
  assert.deepEqual(c.sections, ['3. Access Control > 3.2 Key Rotation']);
});

// Ordering is a promise, not an accident: ranking candidates by recency would
// invite picking the top one instead of the one the conversation is about.
test('candidates come back in path order, whatever order they were loaded in', () => {
  const candidates = candidateDocuments(
    [doc('z.md', thread('open')), doc('a.md', thread('open')), doc('m.md', thread('open'))],
    'needs_attention',
  );
  assert.deepEqual(
    candidates.map((c) => c.document),
    ['a.md', 'm.md', 'z.md'],
  );
});

test('a status filter narrows the candidates as well as the counts', () => {
  const files = [doc('a.md', thread('open')), doc('b.md', thread('answered'))];
  assert.deepEqual(
    candidateDocuments(files, 'answered').map((c) => c.document),
    ['b.md'],
  );
  assert.deepEqual(
    candidateDocuments(files, 'all').map((c) => c.document),
    ['a.md', 'b.md'],
  );
});
