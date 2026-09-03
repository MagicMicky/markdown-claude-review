import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNELS,
  READING_THE_DOCUMENT,
  EDITING_CONTRACT,
  HOW_TO_APPLY,
  IN_THE_DOCUMENT,
  MECHANICS,
  NEVER_IN_THE_DOCUMENT,
  REVIEW_GOAL,
  WHEN_UNSURE,
} from '../core/guidance.js';

test('the prose contract renders every rule', () => {
  const all = [
    ...READING_THE_DOCUMENT,
    ...IN_THE_DOCUMENT,
    ...NEVER_IN_THE_DOCUMENT,
    ...WHEN_UNSURE,
    ...CHANNELS,
  ];
  for (const rule of all) {
    assert.ok(EDITING_CONTRACT.includes(rule), `contract is missing: ${rule.slice(0, 40)}…`);
  }
  assert.ok(EDITING_CONTRACT.includes(REVIEW_GOAL));
});

test('the structured form carries the same rules as the prose form', () => {
  assert.deepEqual(HOW_TO_APPLY.context_to_read, READING_THE_DOCUMENT);
  assert.deepEqual(HOW_TO_APPLY.in_the_document, IN_THE_DOCUMENT);
  assert.deepEqual(HOW_TO_APPLY.never_in_the_document, NEVER_IN_THE_DOCUMENT);
  assert.deepEqual(HOW_TO_APPLY.when_unsure, WHEN_UNSURE);
  assert.deepEqual(HOW_TO_APPLY.where_everything_else_goes, CHANNELS);
  assert.deepEqual(HOW_TO_APPLY.mechanics, MECHANICS);
  assert.equal(HOW_TO_APPLY.goal, REVIEW_GOAL);
});

test('no rule list is empty', () => {
  for (const [name, list] of Object.entries({
    READING_THE_DOCUMENT,
    IN_THE_DOCUMENT,
    NEVER_IN_THE_DOCUMENT,
    WHEN_UNSURE,
    CHANNELS,
    MECHANICS,
  })) {
    assert.ok(list.length > 0, `${name} is empty`);
    for (const rule of list) assert.ok(rule.trim().length > 20, `${name} has a stub rule`);
  }
});

test('the goal states the reader-cannot-tell test', () => {
  assert.match(REVIEW_GOAL, /never saw the review/);
});
