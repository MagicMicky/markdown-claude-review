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
npm run build       # esbuild -> dist/extension.js and dist/mcp.js
npm run watch       # rebuild on change
npm run package     # build + vsce -> markdown-claude-review.vsix
```

Run `typecheck` and `test` before committing. CI runs both on Node 20 and 22.

Press `F5` in VS Code to launch an Extension Development Host.

## Layout

| Path | What lives there |
| --- | --- |
| `src/core/` | Everything with no VS Code dependency. All tests live against this. |
| `src/extension/` | The VS Code UI layer. Untested — no extension-host harness. |
| `src/mcp/` | The stdio MCP server Claude Code talks to. |
| `src/test/` | `node:test` suites, `src/core` only. |

**`src/core/` must never import `vscode`.** Both bundles depend on it, and it is the
only part that can be tested. When logic is worth testing, that is where it goes —
`mergeMcpConfig` and `sectionText` were pulled out of the extension for exactly that
reason.

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
result, and the generated `/review` slash command. Change the arrays there, never the
call sites; a test asserts every rule reaches the prose form.

**Writes are atomic.** `writeReview` goes through a temp file and a rename, because the
extension and the MCP server write the same JSON from different processes.

**Config merges never clobber.** `mergeMcpConfig` refuses to write when an existing
`.mcp.json` does not parse, rather than replacing a file that may hold other servers.
Same for `/review`: a command without our marker prompts before being overwritten.

**Context is rationed.** `list_threads` sends section excerpts and an outline only for
documents longer than `SHORT_DOCUMENT_LINES` (`src/core/context.ts`); shorter ones are
meant to be read in full, and sending both bills the same prose twice.

## Testing the MCP server

There is no test harness for it. Drive it over real stdio with a small script: spawn
`dist/mcp.js` with `MDREVIEW_ROOT` pointing at a scratch directory, send `initialize`,
then `notifications/initialized`, then `tools/call` frames as newline-delimited JSON-RPC.
Worth doing for any change to tool shapes or the guidance payload.

## Conventions

Comments explain why, not what — the invariants above are the kind of thing worth
writing down, mechanics are not. Match the surrounding style; there is no linter.
