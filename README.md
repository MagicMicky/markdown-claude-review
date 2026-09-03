# Markdown Claude Review

[![CI](https://github.com/MagicMicky/markdown-claude-review/actions/workflows/ci.yml/badge.svg)](https://github.com/MagicMicky/markdown-claude-review/actions/workflows/ci.yml)

Google-Docs-style comment threads on markdown in VS Code, wired back to Claude Code
over MCP.

Claude writes the document. You read it rendered, select a passage, and comment — the
thread appears as a bubble in the margin beside it. Claude reads your comments, edits
the document, replies where it needs clarification, and resolves what it addressed.
Everything is local files.

## The loop

1. Claude Code writes `docs/strategy.md`.
2. You open the review preview (`Ctrl+K V`), select a passage, and comment on it.
3. You type `/review` in Claude Code. Or just say "address my comments on the strategy doc".
4. Claude calls `list_threads`, edits the doc, then `resolve_thread` (done) or
   `reply_thread` (needs your input). Its replies appear in the bubble.
5. Threads you have not resolved stay open. Nothing is ever silently dropped.

There is no hand-off file and nothing to paste. The threads live behind an MCP server,
so asking Claude for them in plain English is the whole interface; `/review` is a
shortcut, not a requirement.

## Install

Nothing here is OS-specific: macOS, Linux and Windows all work. You need VS Code 1.90+,
Claude Code, and the `code` CLI on your `PATH` (on macOS, run **Shell Command: Install
'code' command in PATH** from the command palette first).

From the latest [release](https://github.com/MagicMicky/markdown-claude-review/releases),
no toolchain needed:

```sh
gh release download -R MagicMicky/markdown-claude-review -p '*.vsix'
code --install-extension markdown-claude-review.vsix
```

Re-run those two lines to upgrade. There is no auto-update: the extension is not on the
Marketplace, so VS Code has nowhere to check.

From source instead, with Node 18+:

```sh
npm install
npm run package          # -> markdown-claude-review.vsix
code --install-extension markdown-claude-review.vsix
```

Then, in the workspace where you write documents:

- Run **Markdown Review: Set Up Claude Code Integration** from the command palette. It
  writes `.mcp.json` and a `/review` slash command into `.claude/commands/`.
- Restart Claude Code in that workspace and approve the `markdown-review` server.

The generated `.mcp.json` points at VS Code's bundled Node and the installed extension
by absolute path, so it is machine-specific — if you commit it, everyone else re-runs
the setup command on their own machine.

The extension is disabled in [Restricted Mode](https://code.visualstudio.com/docs/editor/workspace-trust):
it reads comment threads from files in the workspace, and the hand-off types a
configurable line into a terminal. Trust the folder before using it.

## Two surfaces

**The review preview** is where you comment. It renders the document — using VS Code's
own preview stylesheet, loaded from the built-in extension at runtime, so it looks like
the preview you already know — and puts comment bubbles in the right margin, aligned to
the passages they belong to.

**The source editor** shows the same threads as VS Code comment threads, collapsed to a
gutter marker and an underline so your prose never moves.

Both are projections of the same state. A reply typed in either appears in the other.

| Action | How |
| --- | --- |
| Open the preview | `Ctrl+K V`, or the preview icon in the editor title bar |
| Comment | Select rendered text, click **Comment**, type, `Ctrl+Enter` |
| Comment from the source | Select text, `Ctrl+Alt+M`, or the gutter `+` |
| Reply | Click a bubble, type in its reply box, `Ctrl+Enter` |
| Resolve | **Resolve** on the bubble |
| Jump to the source | Alt+click a passage in the preview |
| Jump between comments | **Next / Previous Comment** from the palette |
| Re-attach a stale comment | Select the new passage, then **Re-attach to selection** on the bubble |
| Hand off to Claude | Type `/review` in Claude Code |
| Force a re-scan | **Markdown Review: Refresh Threads**, if state ever looks stale |

Three visual layers, deliberately distinct: every open thread tints its passage faintly;
a bar in the left margin tracks where the source editor's cursor is; and the thread you
are actually in gets a strong tint and an expanded bubble.

Ours replaces the built-in preview: it takes `Ctrl+K V` and `Ctrl+Shift+V`, and VS
Code's own preview buttons hide themselves so the title bar shows one preview icon
rather than three. The built-in preview is still on **Markdown: Open Preview** in the
command palette.

Set `mdreview.replaceBuiltInPreview` to `false` to reverse all of that in one go — the
built-in buttons and keybindings come back, and the review preview moves to
**Markdown Review: Open Review Preview** in the palette.

`mdreview.inlineThreads` controls the editor layer: `collapsed` (default), `expanded`
if you want threads to open in place, or `off` for preview-only.

### Thread states

| State | Meaning |
| --- | --- |
| **open** | You commented; waiting on Claude |
| **answered** | Claude replied or edited; waiting on you |
| **resolved** | Closed. Kept forever as history |
| **stale** | The text it pointed at no longer exists. Kept and shown, never deleted |

**answered** and **resolved** are not interchangeable. *answered* is whose-turn-it-is,
and it is set automatically: whoever posts the last message flips the thread to the
other side, so a Claude reply makes it *answered* and your reply back makes it *open*
again. The conversation is still live. *resolved* is the end of the thread's life, and
only ever happens on purpose — Claude calling `resolve_thread` after making the edit, or
you clicking **Resolve**.

A resolved thread disappears from the preview, which is the live review surface. It is
not gone: it stays in the review file and in the source editor's inline thread, where
you can reopen it.

Claude only sees **open** and **stale** threads by default, so an *answered* thread is
not waiting on Claude and a *resolved* one is out of the loop entirely.

## How comments stay attached

Comments store no line numbers. Claude rewrites files out-of-band, so anything
positional would be wrong by the time it is read back. Instead each thread keeps a
[W3C-style text quote selector](https://www.w3.org/TR/annotation-model/#text-quote-selector):
the exact quote, ~48 characters either side, and the heading trail it sat under.

On every save, anchors re-resolve through a cascade, most trustworthy first:

1. Exact quote, unique in the document → **exact**
2. Exact quote appearing several times → pick the occurrence whose surrounding text
   agrees. Enough agreement → **exact**; little or none → **drifted**, because with
   several identical passages the context is the only thing telling them apart
3. Fuzzy paragraph match (Sørensen–Dice over character trigrams) *within the original
   section* → **drifted**
4. Fuzzy paragraph match document-wide, at a stricter threshold → **drifted**
5. Nothing above threshold → **stale**

A comment pointing confidently at the wrong paragraph is worse than one that admits it
lost its place, so the cascade refuses to guess rather than always returning something.
Drifted threads keep showing the original wording, flagged as edited, so you can see
what Claude changed under your comment.

Tune the bar with `mdreview.fuzzyThreshold` (default `0.62`).

## How the preview knows what you selected

A comment anchors to source characters, but you select *rendered* text — and the two are
not the same string. Rather than reconstruct which characters were markup, the renderer
labels every run of rendered text with the source offsets it came from, taken from
markdown-it's own token stream.

Highlighting and selection are then arithmetic on those offsets. That is what makes a
comment work on a table cell, inside a fenced code block, on a `snake_case` identifier,
across an HTML entity, or spanning several paragraphs — all cases where guessing what
the page would say produced no highlight at all.

Rendering uses `markdown-it` with the built-in preview's own options and highlight.js
alias map, so output matches rather than merely resembles it. It is not pinned to the
version VS Code bundles: 12 and 15 render this repo's documents, and every edge case the
offset mapping depends on, to byte-identical HTML.

## Storage

One JSON file per document, mirroring its path:

```
docs/strategy.md  ->  .review/docs/strategy.md.review.json
```

Plain, diffable, greppable, commit it or don't. Nothing else is written; Claude reads
threads through the MCP server, not through a generated hand-off file.

Two processes write these files — this extension and the MCP server — so both merge
against what is on disk immediately before writing, unioning messages and resolving the
rest by timestamp. Without that, whoever wrote second would silently revert the other:
your resolve overwriting Claude's reply, or the reverse.

A file that cannot be parsed is never written over. It is reported, and its threads are
left alone until you fix it — the sidecar is the only copy of that history, and treating
an unreadable file as an empty one would destroy it.

## MCP tools Claude gets

| Tool | Purpose |
| --- | --- |
| `list_threads` | Comments needing attention (default), or filtered by document/status |
| `get_thread` | One thread with its full history |
| `reply_thread` | Ask a clarifying question or push back; leaves the thread open |
| `resolve_thread` | Close a thread after editing, with a note on what changed |
| `create_thread` | Flag an unverified claim in its own document and ask you about it |
| `list_documents` | Which documents have open comments |

The server also ships connect-time instructions telling Claude to reach for
`list_threads` whenever you mention comments or feedback on a document — so plain
English works without the slash command, and Claude will not go hunting for comments
inside the markdown.

## What Claude is told to do

The goal, stated once in `src/core/guidance.ts` and rendered into the MCP instructions,
the `list_threads` result and the `/review` command so the three cannot drift:

> Make the document correct and useful on its own terms. A reader who never saw the
> review should not be able to tell that one happened.

Which means, generically — the same rules whether it is a compliance policy, a team
strategy or a set of goals:

- **Nothing about the review goes in the document.** No "updated per feedback", no
  changelog lines, no TODOs, no HTML comments, no markers tying prose back to a comment.
- **No reasoning in the prose.** The document states what is true; it does not argue for
  itself. Justification, findings and disagreement go in the thread reply.
- **Questions are replies, not paragraphs.** Neither answers to your questions nor
  questions back to you belong in the text.
- **Your comment is a pointer, not copy.** It says what is wrong; Claude decides how the
  prose should read, rather than transcribing your shorthand.
- **Edits stay proportionate.** No restructuring or polishing passages nobody commented
  on. Something else looks wrong? `create_thread` raises it instead of silently fixing it.
- **Uncertainty stops the edit.** If Claude cannot establish the truth it leaves the
  passage alone and replies, rather than hedging or guessing in the document.

To change any of this, edit the lists in `src/core/guidance.ts` and rebuild — all three
prompts follow.

## What Claude reads, and what that costs

A paragraph judged in isolation gets edited into something that contradicts or repeats
the one next to it — so Claude needs the surrounding document. Re-reading the whole file
on every review round is the expensive way to get that, so `list_threads` groups threads
by document and adapts:

| Document | What comes back | Instruction |
| --- | --- | --- |
| ≤ 400 lines | Threads only | Read the whole file once, before your first edit to it |
| > 400 lines | Threads, plus the heading `outline` and the `section_context` around each commented passage | Read further only where the change touches something stated elsewhere |

Short documents get no excerpts on purpose: shipping an outline and section bodies for a
file Claude is about to read in full would bill the same prose twice. Section bodies are
sent once per section, not once per thread, since several comments usually land in the
same one.

Measured on a 1041-line policy document with three comments (est. tokens, chars/4):

| | tokens |
| --- | --- |
| Reading the whole document | 21,369 |
| `list_threads` — first call, everything included | 4,129 |
| `list_threads` — subsequent calls | 3,437 |

The full editing contract is returned once per session; later calls carry only the goal
and the *never in the document* rules, which are the ones broken most often.

Thresholds live in `src/core/context.ts` (`SHORT_DOCUMENT_LINES`, `MAX_SECTION_LINES`).

## Settings

| Setting | Default | |
| --- | --- | --- |
| `mdreview.replaceBuiltInPreview` | `true` | Hide VS Code's preview buttons and take `Ctrl+K V` |
| `mdreview.inlineThreads` | `collapsed` | Editor layer: `collapsed`, `expanded`, `off` |
| `mdreview.highlightCommentedRanges` | `true` | Underline commented passages in the editor |
| `mdreview.fuzzyThreshold` | `0.62` | Similarity needed to re-attach to rewritten prose |
| `mdreview.reviewDir` | `.review` | Where threads are stored |
| `mdreview.author` | git `user.name` | Name on your comments |
| `mdreview.terminalName` | `claude` | Substring matching your Claude Code terminal |
| `mdreview.sendPrompt` | `/review` | What the Send Review command types for you |

The last four are machine-scoped on purpose: `sendPrompt` and `terminalName` decide what
gets typed into a terminal, so a cloned repository must not be able to set them.

The preview also honours VS Code's own `markdown.preview.*` settings — `fontFamily`,
`fontSize`, `lineHeight`, `breaks`, `linkify`, `typographer`, the scroll-sync pair — and
your `markdown.styles`, so it behaves like the built-in preview you have already
configured.

## Development

```sh
npm run typecheck  # root project and the webview project
npm test           # core suite plus the webview's DOM tests
npm run watch      # rebuild on change
npm run build      # three bundles: extension, MCP server, preview webview
```

Press `F5` and pick **Run Extension (sandbox)** to launch an Extension Development Host
already opened on `sandbox/`, which is gitignored and yours to scribble in.

Tests run as two `tsc` projects. Most of them are plain `node:test` over `src/core`. The
webview's DOM mapping is tested separately with jsdom against real renderer output,
because that layer is where the bugs have actually been, and the DOM lib must not leak
into `src/core`.

See [CLAUDE.md](CLAUDE.md) for the invariants worth not breaking.
