import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNELS,
  CHOOSING_THE_DOCUMENT,
  READING_THE_DOCUMENT,
  EDITING_CONTRACT,
  HOW_TO_APPLY,
  IN_THE_DOCUMENT,
  MECHANICS,
  NEVER_IN_THE_DOCUMENT,
  REVIEW_GOAL,
  SCOPE_CONTRACT,
  WHEN_UNSURE,
} from '../core/guidance.js';
import { COMMAND_MARKER, REVIEW_COMMAND } from '../core/setup.js';

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
    CHOOSING_THE_DOCUMENT,
  })) {
    assert.ok(list.length > 0, `${name} is empty`);
    for (const rule of list) assert.ok(rule.trim().length > 20, `${name} has a stub rule`);
  }
});

test('the goal states the reader-cannot-tell test', () => {
  assert.match(REVIEW_GOAL, /never saw the review/);
});

test('the scope contract renders every rule for choosing a document', () => {
  for (const rule of CHOOSING_THE_DOCUMENT) {
    assert.ok(SCOPE_CONTRACT.includes(rule), `scope contract is missing: ${rule.slice(0, 40)}…`);
  }
});

// Both parameters have to be named where Claude reads the rules, or the prose
// describes a tool surface it cannot actually reach.
test('the scope contract names both ways of stating a scope', () => {
  assert.match(SCOPE_CONTRACT, /`document`/);
  assert.match(SCOPE_CONTRACT, /`all_documents: true`/);
});

// Scoping and editing are separate contracts on purpose: one is about which
// document, the other about what to do to it. Folding either into the other
// leaves a caller that renders one silently missing half the rules.
test('the scope rules stay out of the editing contract', () => {
  for (const rule of CHOOSING_THE_DOCUMENT) {
    assert.ok(!EDITING_CONTRACT.includes(rule), `editing contract absorbed: ${rule.slice(0, 40)}…`);
  }
});

// The slash command is the third rendering of the same rules. It used to be
// written out in the extension layer, where nothing could assert that.
test('the generated slash command carries both contracts whole', () => {
  assert.ok(REVIEW_COMMAND.includes(SCOPE_CONTRACT), 'slash command lost the scope contract');
  assert.ok(REVIEW_COMMAND.includes(EDITING_CONTRACT), 'slash command lost the editing contract');
  assert.ok(REVIEW_COMMAND.includes(COMMAND_MARKER), 'slash command lost its marker');
  // Backticks survive the move between template literals: `document` and
  // `all_documents` have to reach Claude as parameter names, not as prose.
  assert.match(REVIEW_COMMAND, /`list_threads`/);
  assert.match(REVIEW_COMMAND, /`all_documents: true`/);
});
