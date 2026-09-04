# Working on this repo

A VS Code extension plus an MCP server. You comment on markdown documents in the
editor; Claude Code reads those comments over MCP, edits the document, and replies
or resolves. See `README.md` for what it does and how it is used.

## Environment

`node` and `npm` are not on `PATH` in non-interactive shells on this machine. Prefix
commands with the nvm bin directory:

```sh
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"
```

## Commands

```sh
npm run typecheck   # tsc --noEmit, strict
npm test            # compiles to dist-test/, runs node:test
npm run build       # esbuild -> dist/extension.js, dist/mcp.js, dist/preview.js
npm run watch       # rebuild on change
npm run package     # build + vsce -> markdown-claude-review.vsix
npm run scenarios   # local only, spends a Claude subscription. See below.
```

Run `typecheck` and `test` before committing. CI runs both on Node 20 and 22.

Press `F5` in VS Code to launch an Extension Development Host.

## Layout

| Path | What lives there |
| --- | --- |
| `src/core/` | Everything with no VS Code dependency. All tests live against this. |
| `src/extension/` | The VS Code UI layer. Untested — no extension-host harness. |
| `src/webview/` | The preview's client script, bundled to `dist/preview.js`. |
| `src/mcp/` | The stdio MCP server Claude Code talks to. |
| `src/test/` | `node:test` suites, `src/core` only. |
| `scripts/` | Local-only harnesses. Not typechecked, not shipped, not run by CI. |
| `media/` | Static webview assets. Shipped as-is; do not add them to `.vscodeignore`. |

**`src/core/` must never import `vscode`.** All three bundles depend on it, and it is
the only part that can be tested. It is not "pure domain logic" — it is "code that has
tests", which is why `mergeMcpConfig`, `sectionText` and `rendermap` live there. When logic is worth testing, that is where it goes —
`mergeMcpConfig`, `sectionText`, `rendermap` and the card view-model live there for
exactly that reason.

**`src/webview/` must never import `vscode` or `node:*`, and neither may anything in
`src/core/` that it pulls in.** `src/core/store.ts` imports `node:fs`, so a stray
re-export would reach the webview. The webview's esbuild target uses
`platform: 'browser'` so that fails the build instead of showing a blank panel. It is
typechecked separately (`tsconfig.webview.json`) because it needs `lib: ["DOM"]`, which
must not leak into the root project.

## Invariants worth not breaking

**Anchors store no positions.** Claude rewrites files out of band, so any line number
or offset persisted to disk is wrong by the time it is read back. A thread keeps a
quote, ~48 characters of context either side, and the heading trail (`src/core/types.ts`).

**`resolveAnchor` returns `null` rather than guessing.** The cascade in
`src/core/anchor.ts` is ordered most-trustworthy-first and gives up below a similarity
threshold. A comment pointing confidently at the wrong paragraph is worse than one
marked stale. Do not add a "closest match wins" fallback.

**Status is never destroyed.** Threads go `open → answered → resolved`, or `stale` when
their text disappears. Nothing is deleted implicitly; `stale` recovers to whichever side
last spoke if the text comes back.

**One source for the prompts.** `src/core/guidance.ts` renders into all three places
Claude reads instructions — the MCP connect-time `instructions`, the `list_threads`
result, and the generated `/markdown-review` slash command. Change the arrays there, never the
call sites; a test asserts every rule reaches the prose form. Two contracts, kept apart:
`SCOPE_CONTRACT` is which document, `EDITING_CONTRACT` is what to do to it. Folding
either into the other leaves a call site that renders one silently missing half the rules.

**A review is scoped to what was asked for, and an unscoped call returns candidates
rather than threads.** One tool answers "which documents have comments", and it is this
one — a second listing tool existed until a scenario trial reached for it to pick a
document, which is what any tool named for listing documents will be used for.
`list_threads` takes `document` for one, `all_documents` for the
workspace, and answers neither with the documents that have comments — paths, counts and
the headings they sit under (`src/core/scope.ts`). None of the three is discouraged; the
point is that the scope is stated rather than assumed, because "everything unfinished in
the workspace" is almost never what "address my comments" meant. Which document is being
worked on is a fact about the conversation, so the candidate list is ordered by path and
carries no recency signal: ranking it would invite picking the top entry over the right
one. The same list comes back on a `document` that matches nothing, so recovering from a
bad path never costs less than staying scoped.

**Writes are atomic.** `writeReview` goes through a temp file and a rename, because the
extension and the MCP server write the same JSON from different processes.

**Every mutation goes through `ReviewActions`, and every surface is a subscriber.** The
inline threads, the decorations and the preview all render `Session` and post commands
back; none of them owns state or calls another. That is what keeps them in sync, and
what lets `inlineThreads: 'off'` dispose the whole comment controller without taking
any command with it. Two events, not one: `onDidChange` for thread content,
`onDidReanchor` for offsets moving while typing.

**Resolved threads default to one home.** They are hidden in the preview and kept in the
inline widget, so the closed history has somewhere to live without cluttering the
surface you work on. `showResolvedInPreview` opts into a second view of it, and the
bubble changes shape to match: Reopen instead of Resolve, and `canReattach` is false, so
reading the history can never silently pull a thread back out of `resolved`. Both the
cards and the highlights come off one filtered list in `pushThreads`, or the margin and
the tinting would disagree about which threads exist.

**Never reassign a `CommentThread.collapsibleState` on update.** Set it at creation and
in the reveal path only. Reassigning on every fan-out snaps a thread the user just
expanded shut the next time anything changes — which, with the collapsed default, is
any keystroke.

**Comment bodies never reach an HTML sink.** They are written by another process into a
JSON file, so `src/webview/preview.ts` sets them with `textContent` only, and markdown
is deliberately not rendered in a bubble.

The one `innerHTML` is the rendered document itself (`doc.innerHTML = m.html`), which is
inherent to being a preview — VS Code's own does the same, with the same `html: true`
markdown-it option, so documents that embed HTML render at all. What makes that safe is
the CSP in `src/extension/preview.ts`: `script-src` is nonce-only, so neither a
`<script>` tag nor an inline `onerror=` in the document can execute, and
`default-src 'none'` blocks frames and outbound requests.

**The hand-off names its scope.** The send button reads the focused preview (or markdown
editor) and types the document path after the prompt, so the UI answers "which document"
with something it actually knows rather than leaving Claude to work it out. Reached from
the palette with nothing focused, it asks rather than falling back to the workspace. The
toast counts that document's threads: it used to report the workspace total, which said
nothing true about what had just been sent.

**Config merges never clobber.** `mergeMcpConfig` refuses to write when an existing
`.mcp.json` does not parse, rather than replacing a file that may hold other servers.
Same for `/markdown-review`: a command without our marker prompts before being
overwritten. The name is not `review` on purpose — that is a Claude Code built-in, so
the old name made a workspace that never ran setup get a code review out of the hand-off
instead of an error. `COMMAND_NAME` and `LEGACY_COMMAND_NAME` in `src/core/setup.ts` are
the only place either name is written, and setup deletes the legacy file when it still
carries our marker.

**Nothing durable points at a versioned path.** Both paths a registration needs rot:
VS Code's bundled node lives under a directory named after its build, and an extension's
install directory is named after its version. So the server is launched from
`globalStorageUri`, which is keyed on the extension id alone, and `syncStableServer`
copies `dist/mcp.js` there on activation. `healMcpConfig` re-checks the stored entry
every activation and rewrites it when a path has genuinely gone — not when it merely
differs from what setup would write today, or a hand-repointed interpreter would be
stomped. It repairs, never registers: a workspace with no entry is one nobody enabled.

**A review file is never overwritten from a bad read.** `loadReview` distinguishes
absent from unreadable, and both `Session` and the MCP server refuse to write over the
latter — the sidecar is the only copy of that comment history. Both also merge against
disk before writing, because the two processes each hold a whole file.

**Context is rationed.** `list_threads` sends section excerpts and an outline only for
documents longer than `SHORT_DOCUMENT_LINES` (`src/core/context.ts`); shorter ones are
meant to be read in full, and sending both bills the same prose twice.

## Testing the MCP server

There is no unit harness for it. Drive it over real stdio with a small script: spawn
`dist/mcp.js` with `MDREVIEW_ROOT` pointing at a scratch directory, send `initialize`,
then `notifications/initialized`, then `tools/call` frames as newline-delimited JSON-RPC.
Worth doing for any change to tool shapes or the guidance payload.

For anything that changes what Claude is *told*, that is not enough — the payload can be
correct and the behaviour still wrong. `npm run scenarios` (`scripts/scenarios.mjs`)
drives a real `claude -p` session against a throwaway workspace and asserts on the calls
made and the files changed: which `document` reached `list_threads` first, whether the
other document stayed untouched, whether an explicit sweep still sweeps. Local only —
it spends a Claude subscription, so it is a script, not part of `npm test`, and CI never
runs it. Add a scenario when you change the scope rules or the slash command; a pass
rate below 100% is a prompt to read the transcript, not a broken build.

The prompts it exercises come from source, bundled at run time — never from `dist-test/`,
or a trial can pass against a stale compile of the thing it is testing.

## Conventions

Comments explain why, not what — the invariants above are the kind of thing worth
writing down, mechanics are not. Match the surrounding style; there is no linter.
