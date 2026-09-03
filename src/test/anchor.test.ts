import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnchor, headingPathAt, resolveAnchor, sectionRange, similarity, splitBlocks } from '../core/anchor.js';

const DOC = `# Compliance Overview

Intro paragraph about the program.

## 3. Access Control

Some preamble text.

### 3.2 Key Rotation

Keys are rotated every 90 days via the KMS pipeline.
Audit logs are retained for one year.

### 3.3 MFA

MFA is enforced for all human operators.

## 4. Incident Response

Some preamble text.
`;

test('headingPathAt returns the full trail', () => {
  const at = DOC.indexOf('Keys are rotated');
  assert.deepEqual(headingPathAt(DOC, at), ['Compliance Overview', '3. Access Control', '3.2 Key Rotation']);
});

test('sectionRange scopes to the named section', () => {
  const r = sectionRange(DOC, ['Compliance Overview', '3. Access Control', '3.2 Key Rotation']);
  assert.ok(r);
  const body = DOC.slice(r.start, r.end);
  assert.ok(body.includes('Keys are rotated'));
  assert.ok(!body.includes('MFA is enforced'));
});

test('sectionRange returns null when the heading is gone', () => {
  assert.equal(sectionRange(DOC, ['Nonexistent Section']), null);
});

test('exact anchor round-trips', () => {
  const start = DOC.indexOf('Keys are rotated every 90 days via the KMS pipeline.');
  const anchor = buildAnchor(DOC, start, start + 'Keys are rotated every 90 days via the KMS pipeline.'.length);
  const hit = resolveAnchor(DOC, anchor);
  assert.ok(hit);
  assert.equal(hit.kind, 'exact');
  assert.equal(hit.start, start);
});

test('ambiguous quote picks the occurrence with matching context', () => {
  const second = DOC.lastIndexOf('Some preamble text.');
  const anchor = buildAnchor(DOC, second, second + 'Some preamble text.'.length);
  const hit = resolveAnchor(DOC, anchor);
  assert.ok(hit);
  assert.equal(hit.start, second, 'should resolve to the Incident Response occurrence, not the first');
});

test('survives a rewrite of the anchored paragraph', () => {
  const quote = 'Keys are rotated every 90 days via the KMS pipeline.';
  const start = DOC.indexOf(quote);
  const anchor = buildAnchor(DOC, start, start + quote.length);

  const edited = DOC.replace(
    quote,
    'Keys are rotated every 30 days via the KMS rotation pipeline.',
  );
  const hit = resolveAnchor(edited, anchor);
  assert.ok(hit, 'should re-attach to the rewritten paragraph');
  assert.equal(hit.kind, 'drifted');
  assert.ok(edited.slice(hit.start, hit.end).includes('30 days'));
});

test('survives the section moving elsewhere in the document', () => {
  const quote = 'MFA is enforced for all human operators.';
  const start = DOC.indexOf(quote);
  const anchor = buildAnchor(DOC, start, start + quote.length);

  const moved = `# Compliance Overview\n\nBrand new intro.\n\n## 9. Identity\n\n${quote}\n`;
  const hit = resolveAnchor(moved, anchor);
  assert.ok(hit, 'exact text still present under a different heading');
  assert.equal(hit.kind, 'exact');
});

test('returns null when the passage is genuinely gone', () => {
  const quote = 'Keys are rotated every 90 days via the KMS pipeline.';
  const start = DOC.indexOf(quote);
  const anchor = buildAnchor(DOC, start, start + quote.length);

  const gutted = `# Compliance Overview\n\n## 4. Incident Response\n\nOn-call rotates weekly and pages via the escalation policy.\n`;
  assert.equal(resolveAnchor(gutted, anchor), null);
});

test('short quotes are never fuzzy-matched', () => {
  const anchor = buildAnchor(DOC, DOC.indexOf('MFA'), DOC.indexOf('MFA') + 3);
  const rewritten = DOC.replace(/MFA/g, 'multi-factor auth');
  assert.equal(resolveAnchor(rewritten, anchor), null);
});

test('splitBlocks keeps fenced code together', () => {
  const doc = 'Para one.\n\n```hcl\nresource "a" {\n\n  b = 1\n}\n```\n\nPara two.\n';
  const blocks = splitBlocks(doc);
  assert.equal(blocks.length, 3);
  assert.ok(blocks[1].text.startsWith('```hcl'));
  assert.ok(blocks[1].text.includes('b = 1'));
});

test('headings inside code fences are ignored', () => {
  const doc = '# Real\n\n```\n# Not a heading\n```\n\nBody.\n';
  assert.deepEqual(headingPathAt(doc, doc.indexOf('Body.')), ['Real']);
});

test('similarity is 1 for identical text and low for unrelated text', () => {
  assert.equal(similarity('hello world', 'hello world'), 1);
  assert.ok(similarity('hello world', 'entirely different string') < 0.3);
});
