import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMAND_MARKER,
  COMMAND_NAME,
  LEGACY_COMMAND_NAME,
  isOurCommand,
  mergeMcpConfig,
  type McpServerEntry,
} from '../core/setup.js';

const ENTRY: McpServerEntry = { command: '/usr/bin/node', args: ['/ext/dist/mcp.js'] };

test('creates a config when there is no file', () => {
  const r = mergeMcpConfig(undefined, 'markdown-review', ENTRY);
  assert.ok(r.ok);
  assert.deepEqual(JSON.parse(r.json), { mcpServers: { 'markdown-review': ENTRY } });
  assert.equal(r.replacedExisting, false);
});

test('keeps every other MCP server', () => {
  const before = JSON.stringify({
    mcpServers: {
      'home-assistant': { command: 'uvx', args: ['hass-mcp'] },
      github: { command: 'docker', args: ['run', 'ghcr.io/github/mcp'] },
    },
  });
  const r = mergeMcpConfig(before, 'markdown-review', ENTRY);
  assert.ok(r.ok);
  const after = JSON.parse(r.json);
  assert.deepEqual(Object.keys(after.mcpServers).sort(), [
    'github',
    'home-assistant',
    'markdown-review',
  ]);
  assert.deepEqual(after.mcpServers['home-assistant'], { command: 'uvx', args: ['hass-mcp'] });
  assert.deepEqual(r.siblings.sort(), ['github', 'home-assistant']);
});

test('keeps unrelated top-level keys', () => {
  const before = JSON.stringify({ $schema: './schema.json', inputs: [{ id: 'token' }], mcpServers: {} });
  const r = mergeMcpConfig(before, 'markdown-review', ENTRY);
  assert.ok(r.ok);
  const after = JSON.parse(r.json);
  assert.equal(after.$schema, './schema.json');
  assert.deepEqual(after.inputs, [{ id: 'token' }]);
});

test('handles a file with no mcpServers key', () => {
  const r = mergeMcpConfig(JSON.stringify({ inputs: [] }), 'markdown-review', ENTRY);
  assert.ok(r.ok);
  assert.deepEqual(JSON.parse(r.json).mcpServers, { 'markdown-review': ENTRY });
});

test('refuses to touch a file that does not parse', () => {
  const r = mergeMcpConfig('{ "mcpServers": { "github": {} }, }', 'markdown-review', ENTRY);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /not valid JSON/);
});

test('refuses a top-level array or scalar', () => {
  assert.equal(mergeMcpConfig('[]', 'markdown-review', ENTRY).ok, false);
  assert.equal(mergeMcpConfig('"nope"', 'markdown-review', ENTRY).ok, false);
});

test('refuses when mcpServers is the wrong shape', () => {
  const r = mergeMcpConfig('{"mcpServers": []}', 'markdown-review', ENTRY);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /not an object/);
});

test('an empty file is treated as absent, not as corrupt', () => {
  const r = mergeMcpConfig('   \n', 'markdown-review', ENTRY);
  assert.ok(r.ok);
  assert.deepEqual(JSON.parse(r.json).mcpServers, { 'markdown-review': ENTRY });
});

test('re-running setup reports that it replaced its own entry', () => {
  const before = JSON.stringify({ mcpServers: { 'markdown-review': { command: 'old', args: [] } } });
  const r = mergeMcpConfig(before, 'markdown-review', ENTRY);
  assert.ok(r.ok);
  assert.equal(r.replacedExisting, true);
  assert.deepEqual(JSON.parse(r.json).mcpServers['markdown-review'], ENTRY);
});

test('the generated command does not take a name Claude Code already has', () => {
  // /review is a Claude Code built-in. Naming ours the same means a workspace
  // that never ran setup gets a code review out of the hand-off instead of an
  // unknown-command error — a failure that looks like success. If this ever
  // gets "simplified" back to a shorter name, it has to be an unused one.
  assert.notEqual(COMMAND_NAME, 'review');
  assert.notEqual(COMMAND_NAME, LEGACY_COMMAND_NAME);
});

test('recognises its own generated slash command', () => {
  assert.equal(isOurCommand(`---\ndescription: x\n---\n${COMMAND_MARKER}\nbody`), true);
  assert.equal(isOurCommand('---\ndescription: my own review command\n---\nDo my thing.'), false);
});
