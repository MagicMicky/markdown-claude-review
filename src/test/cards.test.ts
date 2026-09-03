import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOST_SORT_KEY,
  QUOTE_CHARS,
  activeThreadAt,
  buildCard,
  buildCards,
  relativeTime,
  truncateQuote,
  type AnchorHit,
} from '../core/cards.js';
import type { Thread } from '../core/types.js';

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: 'mr_1',
    anchor: {
      quote: 'Keys are rotated every 90 days via the KMS pipeline.',
      prefix: '',
      suffix: '',
      headingPath: ['Compliance', '3. Access Control', '3.2 Key Rotation'],
    },
    status: 'open',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    messages: [
      {
        id: 'm_1',
        author: 'user',
        authorName: 'MagicMicky',
        body: 'Not factual — check work/terraform.',
        ts: '2026-09-01T10:00:00.000Z',
      },
    ],
    ...over,
  };
}

const hit = (over: Partial<AnchorHit> = {}): AnchorHit => ({
  start: 100,
  end: 150,
  kind: 'exact',
  score: 1,
  ...over,
});

/* ---------------- card construction ---------------- */


test('a lost anchor is reported, not guessed at', () => {
  const card = buildCard(thread({ status: 'stale' }), undefined);
  assert.equal(card.anchor.attachment, 'lost');
  assert.equal(card.canReattach, true);
  assert.equal(card.sortKey, LOST_SORT_KEY);
});

test('a drifted card shows the original wording plus what it says now', () => {
  const card = buildCard(
    thread(),
    hit({ kind: 'drifted', score: 0.8, currentText: 'Keys are rotated every 30 days via the KMS pipeline.' }),
  );
  assert.equal(card.anchor.attachment, 'drifted');
  assert.match(card.anchor.quote, /90 days/, 'quote stays the wording at comment time');
  assert.match(card.anchor.currentQuote ?? '', /30 days/);
  assert.equal(card.canReattach, false, 'drifted still has a home; only lost needs re-attaching');
});

test('an exact card carries no currentQuote', () => {
  const card = buildCard(thread(), hit({ currentText: 'ignored when exact' }));
  assert.equal(card.anchor.currentQuote, undefined);
});


/* ---------------- quotes ---------------- */

test('truncateQuote collapses whitespace and leaves short quotes alone', () => {
  const r = truncateQuote('  Keys   are\n  rotated.  ');
  assert.equal(r.text, 'Keys are rotated.');
  assert.equal(r.truncated, false);
});

test('truncateQuote clips on a word boundary and marks it', () => {
  const long = 'word '.repeat(60);
  const r = truncateQuote(long);
  assert.equal(r.truncated, true);
  assert.ok(r.text.endsWith('…'));
  assert.ok(r.text.length <= QUOTE_CHARS + 1, 'stays within the limit plus the ellipsis');
  assert.ok(!r.text.includes('  '), 'no double spaces survive');
});

test('truncateQuote does not gut an unbroken token', () => {
  const r = truncateQuote('x'.repeat(300), 40);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length >= 40, 'a long token is cut at the limit, not at a distant space');
});

test('a quote exactly at the limit is not truncated', () => {
  const exact = 'a'.repeat(QUOTE_CHARS);
  assert.deepEqual(truncateQuote(exact), { text: exact, truncated: false });
});

/* ---------------- ordering ---------------- */

test('cards sort by document position, not by creation time', () => {
  const threads = [
    thread({ id: 'late-in-doc', createdAt: '2026-09-01T09:00:00.000Z' }),
    thread({ id: 'early-in-doc', createdAt: '2026-09-01T11:00:00.000Z' }),
  ];
  const hits = new Map<string, AnchorHit>([
    ['late-in-doc', hit({ start: 900 })],
    ['early-in-doc', hit({ start: 100 })],
  ]);
  assert.deepEqual(
    buildCards(threads, hits).map((c) => c.id),
    ['early-in-doc', 'late-in-doc'],
  );
});

test('lost anchors sort last, keeping creation order among themselves', () => {
  const threads = [
    thread({ id: 'lost-b', createdAt: '2026-09-02T00:00:00.000Z' }),
    thread({ id: 'placed', createdAt: '2026-09-03T00:00:00.000Z' }),
    thread({ id: 'lost-a', createdAt: '2026-09-01T00:00:00.000Z' }),
  ];
  const hits = new Map<string, AnchorHit>([['placed', hit({ start: 500 })]]);
  assert.deepEqual(
    buildCards(threads, hits).map((c) => c.id),
    ['placed', 'lost-a', 'lost-b'],
  );
});

/* ---------------- active thread ---------------- */

test('activeThreadAt finds the containing span', () => {
  const spans = [
    { id: 'a', start: 0, end: 10 },
    { id: 'b', start: 20, end: 30 },
  ];
  assert.equal(activeThreadAt(5, spans), 'a');
  assert.equal(activeThreadAt(25, spans), 'b');
});

test('activeThreadAt refuses to guess outside every span', () => {
  const spans = [{ id: 'a', start: 10, end: 20 }];
  assert.equal(activeThreadAt(5, spans), null);
  assert.equal(activeThreadAt(50, spans), null);
  assert.equal(activeThreadAt(0, []), null);
});

test('spans are half-open: start is inside, end is not', () => {
  const spans = [{ id: 'a', start: 10, end: 20 }];
  assert.equal(activeThreadAt(10, spans), 'a');
  assert.equal(activeThreadAt(19, spans), 'a');
  assert.equal(activeThreadAt(20, spans), null);
});

test('a comment on a phrase beats one on the paragraph around it', () => {
  const spans = [
    { id: 'paragraph', start: 0, end: 200 },
    { id: 'phrase', start: 50, end: 70 },
  ];
  assert.equal(activeThreadAt(60, spans), 'phrase');
  assert.equal(activeThreadAt(10, spans), 'paragraph');
});

test('identical spans resolve deterministically', () => {
  const spans = [
    { id: 'second', start: 10, end: 20 },
    { id: 'first', start: 10, end: 20 },
  ];
  assert.equal(activeThreadAt(15, spans), 'second', 'first match wins, stably');
  assert.equal(activeThreadAt(15, [...spans].reverse()), 'first');
});






/* ---------------- time ---------------- */

test('relativeTime covers each boundary', () => {
  const now = Date.parse('2026-09-03T12:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(relativeTime(ago(30_000), now), 'now');
  assert.equal(relativeTime(ago(5 * 60_000), now), '5m');
  assert.equal(relativeTime(ago(3 * 3_600_000), now), '3h');
  assert.equal(relativeTime(ago(30 * 3_600_000), now), 'yesterday');
  assert.equal(relativeTime('2026-03-04T12:00:00.000Z', now), '4 Mar');
  assert.equal(relativeTime('2025-03-04T12:00:00.000Z', now), '4 Mar 2025');
  assert.equal(relativeTime('not a date', now), '');
});
