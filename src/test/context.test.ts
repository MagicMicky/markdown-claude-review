import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SECTION_LINES,
  countLines,
  documentOutline,
  lineAt,
  sectionText,
  sizeHint,
} from '../core/context.js';

const DOC = `# Compliance Overview

Intro paragraph.

## 3. Access Control

### 3.2 Key Rotation

Keys are rotated every 90 days via the KMS pipeline.
Audit logs are retained for one year.

### 3.3 MFA

MFA is enforced for all human operators.
`;

test('outline lists headings with line numbers', () => {
  assert.deepEqual(documentOutline(DOC), [
    { line: 1, heading: '# Compliance Overview' },
    { line: 5, heading: '## 3. Access Control' },
    { line: 7, heading: '### 3.2 Key Rotation' },
    { line: 12, heading: '### 3.3 MFA' },
  ]);
});

test('section context includes the heading and stops at the next one', () => {
  const body = sectionText(DOC, ['Compliance Overview', '3. Access Control', '3.2 Key Rotation']);
  assert.ok(body);
  assert.ok(body.startsWith('### 3.2 Key Rotation'));
  assert.ok(body.includes('Keys are rotated'));
  assert.ok(body.includes('Audit logs'));
  assert.ok(!body.includes('MFA is enforced'), 'must not bleed into the next section');
});

test('a parent section carries its subsections', () => {
  const body = sectionText(DOC, ['Compliance Overview', '3. Access Control']);
  assert.ok(body);
  assert.ok(body.includes('Keys are rotated'));
  assert.ok(body.includes('MFA is enforced'));
});

test('section context is undefined when the heading is gone', () => {
  assert.equal(sectionText(DOC, ['Renamed Section']), undefined);
  assert.equal(sectionText(DOC, []), undefined);
});

test('an oversized section is truncated rather than dumped', () => {
  const big = `# Top\n\n## Huge\n\n${'filler line\n'.repeat(MAX_SECTION_LINES + 50)}`;
  const body = sectionText(big, ['Top', 'Huge']);
  assert.ok(body);
  assert.ok(body.split('\n').length <= MAX_SECTION_LINES + 3);
  assert.match(body, /section truncated/);
});

test('size hint distinguishes short from long documents', () => {
  assert.match(sizeHint(120), /^short \(120 lines\) — read the whole document/);
  assert.match(sizeHint(2000), /^long \(2000 lines\)/);
});

test('line counting and lookup agree', () => {
  assert.equal(countLines('a\nb\nc\n'), 3);
  assert.equal(countLines('a\nb\nc'), 3);
  assert.equal(countLines(''), 0);
  assert.equal(lineAt(DOC, 0), 1);
  assert.equal(lineAt(DOC, DOC.indexOf('Keys are rotated')), 9);
});
