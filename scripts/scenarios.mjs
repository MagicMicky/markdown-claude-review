#!/usr/bin/env node
/**
 * Trials for the four ways a review gets scoped.
 *
 * Everything else in this repo tests code we wrote. This tests something we do
 * not control: whether Claude, reading the tool descriptions and the generated
 * slash command, actually says which document it is reviewing. That cannot be
 * asserted from a unit test, because the thing under test is a prompt.
 *
 * So each scenario builds a throwaway workspace with two unrelated documents,
 * both carrying open comments, and drives a real `claude -p` session against a
 * real MCP server over stdio. What it checks is not the wording of the reply
 * but the calls that were made and the files that changed: which `document`
 * reached `list_threads` first, whether the untouched document stayed
 * untouched, and — for the sweep — whether asking for everything still gets
 * everything.
 *
 * Local only, and deliberately not wired into CI: it spends your Claude
 * subscription, and a model is not a deterministic function. Read the pass
 * rates as evidence, not as a gate.
 *
 *   npm run scenarios                 # every scenario, once each
 *   npm run scenarios -- --runs 5     # five trials each, for a rate
 *   npm run scenarios -- --only sweep --keep
 */

import * as esbuild from 'esbuild';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(REPO, 'dist', 'mcp.js');

const FIREWALL = 'policies/firewall-egress.md';
const HIRING = 'strategy/hiring-plan.md';

/* ---------------------------------------------------------------- fixtures */

const DOCS = {
  [FIREWALL]: `# Firewall egress policy

## Scope

This policy covers every workload in the production VPC. Workloads in staging
follow it where it is not in conflict with the staging exemptions.

## Egress rules

All outbound traffic leaves through the managed proxy on 10.0.4.8:3128.

Direct egress to the internet is denied at the security group level. A workload
that needs it must be listed in the exceptions register.

## Exceptions

Exceptions are granted for 90 days.

An exception names the workload, the destination, and the owner accountable for
removing it. Renewal is not automatic.

## Default deny

Anything not described above is denied.
`,
  [HIRING]: `# Q3 hiring plan

## Headcount

We will hire four engineers in Q3.

Two go to the platform team and two to product. The platform roles are the
constraint: nothing else in the plan moves until they are filled.

## Process

Offers close within two weeks of final interview.

Every candidate sees the same four-stage loop. Panels are drawn from both
teams so that neither hires in isolation.
`,
};

/** Comments a human would plausibly have left, anchored to real text. */
const COMMENTS = [
  [FIREWALL, 'All outbound traffic leaves through the managed proxy on 10.0.4.8:3128.',
    'Check this against the terraform — I am fairly sure the proxy address moved last month.'],
  [FIREWALL, 'Exceptions are granted for 90 days.',
    'Is 90 right? I remember agreeing 30 in the security review.'],
  [HIRING, 'We will hire four engineers in Q3.',
    'Finance approved three, not four. Fix the number and anything downstream of it.'],
  [HIRING, 'Offers close within two weeks of final interview.',
    'Two weeks is aspirational. Say what actually happens, or drop the sentence.'],
];

/* ------------------------------------------------------------------ harness */

/**
 * The real slash command and the real anchor builder, from source.
 *
 * Bundled here rather than read from `dist-test/` so a trial can never run
 * against a stale compile of the prompt it is meant to be testing.
 */
async function loadCore() {
  const built = await esbuild.build({
    stdin: {
      contents: [
        "export * from './src/core/setup.js';",
        "export * from './src/core/anchor.js';",
        "export * from './src/core/store.js';",
      ].join('\n'),
      resolveDir: REPO,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  });
  const url = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`;
  return import(url);
}

async function buildWorkspace(core) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdreview-scenario-'));

  for (const [rel, text] of Object.entries(DOCS)) {
    const file = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text, 'utf8');
  }

  const byDoc = new Map();
  for (const [rel, quote, body] of COMMENTS) {
    const text = DOCS[rel];
    const start = text.indexOf(quote);
    if (start === -1) throw new Error(`fixture quote missing from ${rel}: ${quote}`);
    const thread = core.newThread(
      core.buildAnchor(text, start, start + quote.length),
      core.makeMessage('user', 'Mickael', body),
    );
    if (!byDoc.has(rel)) byDoc.set(rel, []);
    byDoc.get(rel).push(thread);
  }
  for (const [rel, threads] of byDoc) {
    await core.writeReview(core.reviewPathFor(root, '.review', rel), {
      version: 1,
      document: rel,
      threads,
    });
  }

  // The server is launched exactly as the extension would launch it, so the
  // trial exercises the registration shape too, not just the tool payloads.
  await fsp.writeFile(
    path.join(root, '.mcp.json'),
    JSON.stringify(
      { mcpServers: { 'markdown-review': { command: process.execPath, args: [SERVER], env: { MDREVIEW_ROOT: root } } } },
      null,
      2,
    ),
    'utf8',
  );

  const commands = path.join(root, '.claude', 'commands');
  await fsp.mkdir(commands, { recursive: true });
  await fsp.writeFile(path.join(commands, `${core.COMMAND_NAME}.md`), core.REVIEW_COMMAND, 'utf8');

  return root;
}

const TRACKED = [
  ...Object.keys(DOCS),
  ...Object.keys(DOCS).map((d) => `.review/${d}.review.json`),
];

async function snapshot(root) {
  const out = {};
  for (const rel of TRACKED) {
    try {
      const buf = await fsp.readFile(path.join(root, ...rel.split('/')));
      out[rel] = crypto.createHash('sha256').update(buf).digest('hex');
    } catch {
      out[rel] = 'absent';
    }
  }
  return out;
}

const SERVER_PREFIX = 'mcp__markdown-review__';
const ALLOWED = ['mcp__markdown-review', 'Read', 'Edit', 'Write', 'Glob', 'Grep'].join(',');

function runClaude({ cwd, prompt, sessionId, resume, model }) {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--mcp-config', '.mcp.json',
    '--allowedTools', ALLOWED,
    '--max-turns', '40',
  ];
  if (sessionId) args.push('--session-id', sessionId);
  if (resume) args.push('--resume', resume);
  if (model) args.push('--model', model);

  return new Promise((resolve, reject) => {
    const p = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errText = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (errText += d));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out, errText }));
  });
}

/** Tool calls and the final reply, pulled out of the stream-json transcript. */
function parseTranscript(raw) {
  const toolCalls = [];
  let finalText = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === 'assistant') {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'tool_use') toolCalls.push({ name: block.name, input: block.input ?? {} });
      }
    } else if (msg.type === 'result') {
      finalText = typeof msg.result === 'string' ? msg.result : finalText;
    }
  }
  return { toolCalls, finalText };
}

/* ---------------------------------------------------------------- scenarios */

const scoped = (c) => typeof c.input.document === 'string';
const sweeping = (c) => c.input.all_documents === true;

/**
 * Each check is named for what it protects, so a failure reads as a sentence
 * about the behaviour rather than as an assertion that did not hold.
 */
const SCENARIOS = [
  {
    name: 'named-path',
    what: 'The UI hand-off types the document path. Nothing should have to be looked up.',
    turns: [`/markdown-review ${FIREWALL}`],
    checks: [
      ['the first call names the document', (o) => o.lists[0]?.input.document === FIREWALL],
      ['no call went unscoped', (o) => o.lists.every((c) => scoped(c) || sweeping(c))],
      ['the hiring plan was left alone', (o) => !o.touched(HIRING)],
      ['it actually addressed something', (o) => o.mutations.length > 0],
    ],
  },
  {
    name: 'session-context',
    what: 'A session already working on one document should not have to ask which document.',
    turns: [
      `Read ${HIRING} and tell me in one sentence what it commits to. Do not change any files.`,
      'Address my review comments.',
    ],
    checks: [
      ['the first call names the document already in play', (o) => o.lists[0]?.input.document === HIRING],
      ['no wasted round trip', (o) => o.lists.filter((c) => !scoped(c) && !sweeping(c)).length === 0],
      ['the firewall policy was left alone', (o) => !o.touched(FIREWALL)],
      ['it actually addressed something', (o) => o.mutations.length > 0],
    ],
  },
  {
    name: 'described-document',
    what: 'A description is not a path. One lookup to turn it into one is the expected cost.',
    turns: ['Go through my comments on the firewall policy.'],
    checks: [
      ['it settled on the firewall policy', (o) => o.lists.some((c) => c.input.document === FIREWALL)],
      ['it never swept the workspace', (o) => !o.lists.some(sweeping)],
      ['it never scoped to the wrong document', (o) => !o.lists.some((c) => c.input.document === HIRING)],
      ['the hiring plan was left alone', (o) => !o.touched(HIRING)],
      ['one lookup was enough', (o) => o.lists.filter((c) => !scoped(c) && !sweeping(c)).length <= 1],
    ],
  },
  {
    name: 'no-context',
    what: 'Nothing identifies a document, so the answer is a question, not a guess.',
    turns: ['Review my comments.'],
    checks: [
      ['it asked instead of picking one', (o) => o.mutations.length === 0],
      ['nothing was edited', (o) => !o.touched(FIREWALL) && !o.touched(HIRING)],
      ['it did not sweep the workspace instead', (o) => !o.lists.some(sweeping)],
      ['it showed both documents to choose from',
        (o) => o.finalText.includes('firewall') && o.finalText.includes('hiring')],
    ],
  },
  {
    // The scope rules exist to stop a sweep nobody asked for, not to make a
    // sweep hard to ask for. This is the check that keeps that honest.
    name: 'explicit-sweep',
    what: 'Asking for every document still gets every document.',
    turns: ['Go through all my review comments, in every document in this workspace.'],
    checks: [
      ['it took the sweep it was offered',
        (o) => o.lists.some(sweeping) || new Set(o.lists.filter(scoped).map((c) => c.input.document)).size === 2],
      ['both documents were addressed', (o) => o.touched(FIREWALL) && o.touched(HIRING)],
    ],
  },
];

/* -------------------------------------------------------------------- main */

function parseArgs(argv) {
  const opts = { runs: 1, only: null, keep: false, model: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') opts.runs = Number(argv[++i]);
    else if (a === '--only') opts.only = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--keep') opts.keep = true;
    else if (a === '--list') opts.list = true;
    else throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

async function runOnce(scenario, core, opts) {
  const root = await buildWorkspace(core);
  const before = await snapshot(root);
  const sessionId = crypto.randomUUID();
  const toolCalls = [];
  let finalText = '';
  const transcripts = [];

  for (const [i, prompt] of scenario.turns.entries()) {
    const r = await runClaude({
      cwd: root,
      prompt,
      sessionId: i === 0 ? sessionId : undefined,
      resume: i === 0 ? undefined : sessionId,
      model: opts.model,
    });
    transcripts.push(r.out);
    if (r.code !== 0 && r.out.trim() === '') {
      throw new Error(`claude exited ${r.code}: ${r.errText.trim().slice(0, 400)}`);
    }
    const parsed = parseTranscript(r.out);
    toolCalls.push(...parsed.toolCalls);
    finalText = parsed.finalText || finalText;
  }

  const after = await snapshot(root);
  const ours = toolCalls.filter((c) => c.name.startsWith(SERVER_PREFIX));
  const observed = {
    lists: ours.filter((c) => c.name === `${SERVER_PREFIX}list_threads`),
    mutations: ours.filter((c) => /_(resolve|reply|create)_thread$/.test(c.name)),
    finalText: finalText.toLowerCase(),
    touched: (doc) =>
      before[doc] !== after[doc] || before[`.review/${doc}.review.json`] !== after[`.review/${doc}.review.json`],
  };

  const results = scenario.checks.map(([label, fn]) => {
    let ok = false;
    try {
      ok = Boolean(fn(observed));
    } catch {
      ok = false;
    }
    return { label, ok };
  });

  if (opts.keep) {
    await fsp.writeFile(path.join(root, 'transcript.jsonl'), transcripts.join('\n'), 'utf8');
  } else {
    await fsp.rm(root, { recursive: true, force: true });
  }

  return { results, observed, root: opts.keep ? root : null };
}

function describeCalls(observed) {
  if (observed.lists.length === 0) return 'list_threads was never called';
  return observed.lists
    .map((c) =>
      c.input.document
        ? `document=${c.input.document}`
        : c.input.all_documents
          ? 'all_documents'
          : 'unscoped',
    )
    .join(' → ');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.list) {
    for (const s of SCENARIOS) console.log(`${s.name.padEnd(20)} ${s.what}`);
    return;
  }

  await fsp.access(SERVER).catch(() => {
    throw new Error(`${SERVER} is missing. Run \`npm run build\` first.`);
  });

  const core = await loadCore();
  const chosen = opts.only ? SCENARIOS.filter((s) => s.name.includes(opts.only)) : SCENARIOS;
  if (chosen.length === 0) throw new Error(`no scenario matches "${opts.only}"`);

  let failed = 0;
  const summary = [];

  for (const scenario of chosen) {
    console.log(`\n\x1b[1m${scenario.name}\x1b[0m — ${scenario.what}`);
    let passes = 0;
    for (let run = 1; run <= opts.runs; run++) {
      let outcome;
      try {
        outcome = await runOnce(scenario, core, opts);
      } catch (e) {
        console.log(`  run ${run}: \x1b[31merrored\x1b[0m — ${e.message}`);
        failed++;
        continue;
      }
      const bad = outcome.results.filter((r) => !r.ok);
      if (bad.length === 0) {
        passes++;
        console.log(`  run ${run}: \x1b[32mpass\x1b[0m   ${describeCalls(outcome.observed)}`);
      } else {
        failed++;
        console.log(`  run ${run}: \x1b[31mfail\x1b[0m   ${describeCalls(outcome.observed)}`);
        for (const r of bad) console.log(`           ✗ ${r.label}`);
        if (outcome.root) console.log(`           transcript: ${path.join(outcome.root, 'transcript.jsonl')}`);
      }
    }
    summary.push([scenario.name, passes, opts.runs]);
  }

  console.log('\n\x1b[1msummary\x1b[0m');
  for (const [name, passes, runs] of summary) {
    const mark = passes === runs ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`  ${mark} ${name.padEnd(20)} ${passes}/${runs}`);
  }
  // A model is not a deterministic function, so treat a non-zero exit as "go
  // read the transcript", not as a broken build.
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(2);
});
