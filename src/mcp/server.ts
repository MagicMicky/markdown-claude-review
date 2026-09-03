import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { buildAnchor, resolveAnchor } from '../core/anchor.js';
import {
  DEFAULT_REVIEW_DIR,
  appendMessage,
  docRelPathFor,
  findThread,
  listReviewFiles,
  makeMessage,
  newThread,
  readReview,
  reviewPathFor,
  setStatus,
  writeReview,
} from '../core/store.js';
import {
  SHORT_DOCUMENT_LINES,
  countLines,
  documentOutline,
  lineAt,
  sectionText,
  sizeHint,
} from '../core/context.js';
import { EDITING_CONTRACT, HOW_TO_APPLY, HOW_TO_APPLY_REMINDER } from '../core/guidance.js';
import type { ReviewFile, Thread } from '../core/types.js';

const ROOT = process.env.MDREVIEW_ROOT ?? process.cwd();
const REVIEW_DIR = process.env.MDREVIEW_DIR ?? DEFAULT_REVIEW_DIR;

/* ------------------------------------------------------------------ */

async function docText(docRelPath: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(path.join(ROOT, ...docRelPath.split('/')), 'utf8');
  } catch {
    return undefined;
  }
}

interface LoadedDoc {
  docRelPath: string;
  file: ReviewFile;
  reviewPath: string;
}

async function loadAll(): Promise<LoadedDoc[]> {
  const out: LoadedDoc[] = [];
  for (const f of await listReviewFiles(ROOT, REVIEW_DIR)) {
    const rel = docRelPathFor(ROOT, REVIEW_DIR, f);
    out.push({ docRelPath: rel, file: await readReview(f, rel), reviewPath: f });
  }
  return out;
}

async function locate(threadId: string): Promise<{ doc: LoadedDoc; thread: Thread } | undefined> {
  for (const doc of await loadAll()) {
    const thread = findThread(doc.file, threadId);
    if (thread) return { doc, thread };
  }
  return undefined;
}

/** Render a thread the way Claude needs to act on it. */
async function describe(doc: LoadedDoc, t: Thread): Promise<Record<string, unknown>> {
  const text = await docText(doc.docRelPath);
  const hit = text ? resolveAnchor(text, t.anchor) : null;
  return {
    id: t.id,
    document: doc.docRelPath,
    status: t.status,
    section: t.anchor.headingPath.join(' > ') || '(document root)',
    quoted_text: t.anchor.quote,
    location: hit
      ? { line: lineAt(text!, hit.start), match: hit.kind }
      : { line: null, match: 'lost' },
    text_changed_since_comment: hit?.kind === 'drifted' || Boolean(t.driftedAt),
    messages: t.messages.map((m) => ({
      author: m.author === 'claude' ? 'claude' : 'user',
      name: m.authorName,
      body: m.body,
      at: m.ts,
    })),
    updated_at: t.updatedAt,
  };
}

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/* ------------------------------------------------------------------ */

/**
 * Surfaced to the client at connect time, so "address my review comments" works
 * as a bare instruction with no slash command and no digest file in between.
 */
const INSTRUCTIONS = `Comment threads a human reviewer left on markdown documents in this workspace.

When the user asks you to look at, address, or answer their comments, review notes, or
feedback on a document, call list_threads first — do not go looking for comments in the
markdown itself, they are not stored there.

${EDITING_CONTRACT}`;

/** Whether this process has already sent the full editing contract. */
let servedGuidance = false;

const server = new McpServer(
  { name: 'markdown-review', version: '0.1.0' },
  { instructions: INSTRUCTIONS },
);


server.registerTool(
  'list_threads',
  {
    title: 'List review comments',
    description:
      "List the human reviewer's comment threads on markdown documents. Call this first when asked to address review comments. Defaults to threads that need your attention (open and stale).",
    inputSchema: {
      document: z
        .string()
        .optional()
        .describe('Workspace-relative path of one document, e.g. "docs/compliance.md".'),
      status: z
        .enum(['open', 'answered', 'resolved', 'stale', 'needs_attention', 'all'])
        .optional()
        .describe(
          'needs_attention (default) = open + stale. open = waiting on you. answered = you replied, waiting on the human. stale = the text it pointed at is gone.',
        ),
    },
  },
  async ({ document, status = 'needs_attention' }) => {
    const docs = (await loadAll()).filter((d) => !document || d.docRelPath === document);
    if (document && docs.length === 0) return err(`No review file for "${document}".`);
    const wanted = (t: Thread) =>
      status === 'all'
        ? true
        : status === 'needs_attention'
          ? t.status === 'open' || t.status === 'stale'
          : t.status === status;

    let count = 0;
    const documents: unknown[] = [];
    for (const d of docs) {
      const matching = d.file.threads.filter(wanted);
      if (matching.length === 0) continue;
      count += matching.length;

      const text = await docText(d.docRelPath);
      const threads = [];
      for (const t of matching) threads.push(await describe(d, t));

      if (text === undefined) {
        documents.push({
          document: d.docRelPath,
          lines: null,
          size_hint: 'document not found on disk',
          threads,
        });
        continue;
      }

      const lines = countLines(text);
      // A document short enough to read in full needs no excerpting: shipping
      // an outline and section bodies too would just bill the same prose twice.
      if (lines <= SHORT_DOCUMENT_LINES) {
        documents.push({ document: d.docRelPath, lines, size_hint: sizeHint(lines), threads });
        continue;
      }

      // The enclosing section of each commented passage, once per section
      // rather than once per thread: several comments usually land in the same
      // one, and repeating its text would cost more than reading the file.
      const context: Record<string, string> = {};
      for (const t of matching) {
        const key = t.anchor.headingPath.join(' > ') || '(document root)';
        if (context[key] !== undefined) continue;
        const body = sectionText(text, t.anchor.headingPath);
        if (body !== undefined) context[key] = body;
      }

      documents.push({
        document: d.docRelPath,
        lines,
        size_hint: sizeHint(lines),
        outline: documentOutline(text),
        threads,
        section_context: context,
      });
    }

    if (count === 0) {
      return ok({ count: 0, documents: [], note: 'No comments match. Nothing to address.' });
    }
    // Instructions given once at connect time are easy to lose in a long
    // session, so they ride along here too — in full the first time, and as the
    // rule most often broken thereafter, rather than a page on every call.
    const guidance = servedGuidance ? HOW_TO_APPLY_REMINDER : HOW_TO_APPLY;
    servedGuidance = true;
    return ok({ count, documents, how_to_apply: guidance });
  },
);

server.registerTool(
  'get_thread',
  {
    title: 'Get one review comment thread',
    description: 'Full detail for a single thread, including its whole message history.',
    inputSchema: { thread_id: z.string() },
  },
  async ({ thread_id }) => {
    const found = await locate(thread_id);
    if (!found) return err(`No thread "${thread_id}".`);
    return ok(await describe(found.doc, found.thread));
  },
);

server.registerTool(
  'reply_thread',
  {
    title: 'Reply to a review comment',
    description:
      'Post a reply into a comment thread, where the human reads it next to the text it is about. This is where every explanation belongs: clarifying questions, disagreement, what you found in the source, why you did not make a change. None of that goes into the document. Leaves the thread open; if you already made the change, call resolve_thread instead.',
    inputSchema: {
      thread_id: z.string(),
      body: z
        .string()
        .describe(
          'Markdown, addressed to the reviewer. Be specific and brief — this appears in a comment bubble, not in the document.',
        ),
    },
  },
  async ({ thread_id, body }) => {
    const found = await locate(thread_id);
    if (!found) return err(`No thread "${thread_id}".`);
    appendMessage(found.thread, makeMessage('claude', 'Claude', body));
    await writeReview(found.doc.reviewPath, found.doc.file);
    return ok({ id: thread_id, status: found.thread.status, message: 'Reply posted.' });
  },
);

server.registerTool(
  'resolve_thread',
  {
    title: 'Resolve a review comment',
    description:
      'Mark a thread resolved once you have edited the document to address it. Always pass a note saying what you changed: the note is how the reviewer sees your reasoning, so none of it needs to appear in the document itself.',
    inputSchema: {
      thread_id: z.string(),
      note: z
        .string()
        .optional()
        .describe(
          'One line on what you changed, and why if it is not obvious. Goes in the thread, never in the document.',
        ),
    },
  },
  async ({ thread_id, note }) => {
    const found = await locate(thread_id);
    if (!found) return err(`No thread "${thread_id}".`);
    if (note) appendMessage(found.thread, makeMessage('claude', 'Claude', note));
    setStatus(found.thread, 'resolved');
    await writeReview(found.doc.reviewPath, found.doc.file);
    return ok({ id: thread_id, status: 'resolved' });
  },
);

server.registerTool(
  'create_thread',
  {
    title: 'Start a comment thread',
    description:
      'Open a comment on a passage to flag uncertainty, ask the reviewer a question, or raise a problem nobody commented on — e.g. a claim you could not verify. Use this instead of writing a caveat, TODO or note into the document. Anchor it by quoting the exact text; the quote must appear verbatim in the document.',
    inputSchema: {
      document: z.string().describe('Workspace-relative path, e.g. "docs/compliance.md".'),
      quote: z
        .string()
        .describe('Exact text from the document to attach the comment to. Must match verbatim.'),
      body: z.string().describe('Your question or note for the human reviewer.'),
    },
  },
  async ({ document, quote, body }) => {
    const text = await docText(document);
    if (text === undefined) return err(`Cannot read "${document}".`);
    const start = text.indexOf(quote);
    if (start === -1) {
      return err(
        `That quote does not appear verbatim in "${document}". Re-read the file and copy the exact text, whitespace included.`,
      );
    }
    if (text.indexOf(quote, start + 1) !== -1) {
      return err(
        `That quote appears more than once in "${document}". Include enough surrounding text to make it unique.`,
      );
    }
    const reviewPath = reviewPathFor(ROOT, REVIEW_DIR, document);
    const file = await readReview(reviewPath, document);
    const thread = newThread(
      buildAnchor(text, start, start + quote.length),
      makeMessage('claude', 'Claude', body),
    );
    file.threads.push(thread);
    await writeReview(reviewPath, file);
    return ok({ id: thread.id, status: thread.status, line: lineAt(text, start) });
  },
);

server.registerTool(
  'list_documents',
  {
    title: 'List reviewed documents',
    description: 'Documents that have comment threads, with a count of what needs your attention.',
    inputSchema: {},
  },
  async () => {
    const docs = await loadAll();
    return ok({
      root: ROOT,
      documents: docs.map((d) => ({
        document: d.docRelPath,
        needs_attention: d.file.threads.filter((t) => t.status === 'open' || t.status === 'stale')
          .length,
        answered: d.file.threads.filter((t) => t.status === 'answered').length,
        resolved: d.file.threads.filter((t) => t.status === 'resolved').length,
        total: d.file.threads.length,
      })),
    });
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`markdown-review MCP server failed: ${e?.stack ?? e}\n`);
  process.exit(1);
});
