# Markdown Claude Review

[![CI](https://github.com/MagicMicky/markdown-claude-review/actions/workflows/ci.yml/badge.svg)](https://github.com/MagicMicky/markdown-claude-review/actions/workflows/ci.yml)

Google-Docs-style comment threads on markdown files in VS Code, wired back to Claude Code over MCP.

Claude writes the document. You comment on specific words, sentences and paragraphs.
Claude reads your comments, edits the document, replies where it needs clarification,
and resolves what it addressed. Everything is local files.

## The loop

1. Claude Code writes `docs/strategy.md`.
2. You select a passage in VS Code and comment on it — same gutter UI as a GitHub PR review.
3. You type `/review` in Claude Code. Or just say "address my comments on the strategy doc".
4. Claude calls `list_threads`, edits the doc, then `resolve_thread` (done) or
   `reply_thread` (needs your input). Its replies appear in the comment bubble.
5. Threads you have not resolved stay open. Nothing is ever silently dropped.

There is no hand-off file and nothing to paste. The comment threads live behind an MCP
server, so asking Claude for them in plain English is the whole interface. The
**Send Review** button in the editor is a convenience that types `/review` for you.

## Install

Nothing here is OS-specific: macOS, Linux and Windows all work. You need VS Code 1.90+,
Node 18+, Claude Code, and the `code` CLI on your `PATH` (on macOS, run
**Shell Command: Install 'code' command in PATH** from the command palette first). Every
build step is plain `node`, so the same four commands run in `sh`, `zsh` and PowerShell.

```sh
npm install
npm run build
npm run package          # -> markdown-claude-review.vsix
code --install-extension markdown-claude-review.vsix
```

Or grab a prebuilt `.vsix` from the artifacts of any green
[CI run](https://github.com/MagicMicky/markdown-claude-review/actions/workflows/ci.yml)
on `main`, and skip the toolchain.

Then, in the workspace where you write documents:

- Run **Markdown Review: Set Up Claude Code Integration** from the command palette. It writes
  `.mcp.json` and a `/review` slash command into `.claude/commands/`.
- Restart Claude Code in that workspace and approve the `markdown-review` server.

The generated `.mcp.json` points at VS Code's bundled Node and the installed extension by
absolute path, so it is machine-specific — if you commit it, everyone else re-runs the
setup command on their own machine.

## Using it

Comments live in a **Comments sidebar** — Docs-style bubbles under the
**Markdown Review** icon in the activity bar. The editor itself only ever shows a
gutter marker and an underline, so your prose never moves.

| Action | How |
| --- | --- |
| Comment | Select text, press `Ctrl+Alt+M` (`Cmd+Alt+M`), type, `Ctrl+Enter` |
| Reply | Click a card, type in its reply box, `Ctrl+Enter` |
| Resolve | **Resolve** on the card |
| Jump between comments | **Next / Previous Comment** from the palette |
| Filter | Status chips and the `This document` / `All` toggle in the sidebar header |
| Search | `/` in the sidebar, or the magnifier |
| Re-attach a stale comment | Select the new text, then **Re-attach to selection** on the card |
| Hand off to Claude | Type `/review` in Claude Code — or **Send N to Claude** in the sidebar |

Clicking a card selects its passage in the editor; moving the cursor into a commented
passage expands its card and scrolls it into view. That coordinated pair is what ties
the two together — VS Code exposes no line geometry to a webview, so a card cannot be
pixel-aligned to its text, and pretending otherwise would drift with word wrap and
folding.

Keyboard in the sidebar: `↑`/`↓` or `j`/`k` to move, `Enter` to jump to the passage,
`r` to reply, `/` to search.

Open the built-in markdown preview beside the editor (`Ctrl+K V`) to read the rendered
document while commenting on the source.

### The inline layer

Threads still exist in the editor, collapsed. Click a gutter marker to open one in
place. `mdreview.inlineThreads` controls this:

| Value | Editor shows |
| --- | --- |
| `collapsed` (default) | A gutter marker and an underline. Nothing displaces prose. |
| `expanded` | Threads open inline, pushing text down. |
| `off` | Nothing but the underline. The sidebar is the only surface. |

Both surfaces are projections of the same state, so a reply typed in either appears in
the other immediately.

### Thread states

| State | Meaning |
| --- | --- |
| **open** | You commented; waiting on Claude |
| **answered** | Claude replied or edited; waiting on you |
| **resolved** | Closed. Kept forever as history |
| **stale** | The text it pointed at no longer exists. Kept and shown, never deleted |

**answered** and **resolved** are not interchangeable. *answered* is whose-turn-it-is, and
it is set automatically: whoever posts the last message flips the thread to the other side,
so a Claude reply makes it *answered* and your reply back makes it *open* again. The
conversation is still live. *resolved* is the end of the thread's life, and only ever
happens on purpose — Claude calling `resolve_thread` after making the edit, or you clicking
the check icon. Replies no longer move a resolved thread; reopen it with **Reopen Thread**
in the panel if you want to keep going.

Claude only sees **open** and **stale** threads by default, so an *answered* thread is not
waiting on Claude and a *resolved* one is out of the loop entirely.

## How comments stay attached

Comments store no line numbers. Claude rewrites files out-of-band, so anything positional
would be wrong by the time it is read back. Instead each thread keeps a
[W3C-style text quote selector](https://www.w3.org/TR/annotation-model/#text-quote-selector):
the exact quote, ~48 characters either side, and the heading trail it sat under.

On every save, anchors re-resolve through a cascade, most trustworthy first:

1. Exact quote, unique in the document → **exact**
2. Exact quote appearing several times → pick the occurrence whose surrounding text matches → **exact**
3. Fuzzy paragraph match (Sørensen–Dice over character trigrams) *within the original section* → **drifted**
4. Fuzzy paragraph match document-wide, at a stricter threshold → **drifted**
5. Nothing above threshold → **stale**

A comment pointing confidently at the wrong paragraph is worse than one that admits it
lost its place, so step 5 refuses to guess. Drifted threads keep showing the original
wording, flagged as edited, so you can see what Claude changed under your comment.

Tune the bar with `mdreview.fuzzyThreshold` (default `0.62`).

## Storage

One JSON file per document, mirroring its path:

```
docs/strategy.md  ->  .review/docs/strategy.md.review.json
```

Plain, diffable, greppable, commit it or don't. Writes go through a temp file and a
rename, because Claude and the extension write it from different processes.

Nothing else is written. Claude reads threads through the MCP server, not through a
generated hand-off file.

## MCP tools Claude gets

| Tool | Purpose |
| --- | --- |
| `list_threads` | Comments needing attention (default), or filtered by document/status |
| `get_thread` | One thread with its full history |
| `reply_thread` | Ask a clarifying question or push back; leaves the thread open |
| `resolve_thread` | Close a thread after editing, with a note on what changed |
| `create_thread` | Flag an unverified claim in its own document and ask you about it |
| `list_documents` | Which documents have open comments |

The server also ships connect-time instructions telling Claude to reach for `list_threads`
whenever you mention comments or feedback on a document — so plain English works without
the slash command, and Claude will not go hunting for comments inside the markdown.

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
- **Edits stay proportionate.** No restructuring or polishing passages nobody commented on.
  Something else looks wrong? `create_thread` raises it instead of silently fixing it.
- **Uncertainty stops the edit.** If Claude cannot establish the truth it leaves the
  passage alone and replies, rather than hedging or guessing in the document.

To change any of this, edit the lists in `src/core/guidance.ts` and rebuild — all three
prompts follow.

## What Claude reads, and what that costs

A paragraph judged in isolation gets edited into something that contradicts or repeats the
one next to it — so Claude needs the surrounding document. Re-reading the whole file on
every review round is the expensive way to get that, so `list_threads` groups threads by
document and adapts:

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
| `mdreview.reviewDir` | `.review` | Where threads are stored |
| `mdreview.author` | git `user.name` | Name on your comments |
| `mdreview.terminalName` | `claude` | Substring matching your Claude Code terminal |
| `mdreview.sendPrompt` | `/review` | What the Send Review button types for you |
| `mdreview.highlightCommentedRanges` | `true` | Underline commented passages |
| `mdreview.fuzzyThreshold` | `0.62` | Similarity needed to re-attach to rewritten prose |
| `mdreview.inlineThreads` | `collapsed` | How threads appear in the editor: `collapsed`, `expanded`, `off` |
| `mdreview.sidebar.defaultScope` | `document` | Whether the sidebar opens on this document or the workspace |
| `mdreview.sidebar.showResolved` | `false` | Whether resolved comments show on first open |

## Development

```sh
npm run watch      # rebuild on change
npm test           # anchoring, context, store, guidance and sidebar view-model tests
npm run typecheck
```

Press `F5` in VS Code to launch an Extension Development Host.
See [CLAUDE.md](CLAUDE.md) for the invariants worth not breaking.
