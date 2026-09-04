/**
 * What Claude is being asked to do when it acts on a review, and which document
 * it is being asked to do it to.
 *
 * Stated once here and rendered into all three places it is needed — the MCP
 * server's connect-time instructions, the `list_threads` tool result, and the
 * generated /markdown-review slash command — so the three cannot drift apart.
 *
 * Deliberately about *how to edit*, not about any particular kind of document:
 * the same rules should hold for a compliance policy, a team strategy, or a set
 * of quarterly goals.
 */

/**
 * Which document a review is about.
 *
 * Three ways to answer that, none of them preferred on principle: the point is
 * that the scope is stated rather than assumed. The single-document case leads
 * because it is the common one, not because the workspace-wide case is
 * discouraged — a sweep is a fine thing to ask for, and this says how to ask.
 */
export const CHOOSING_THE_DOCUMENT = [
  'A document the user named, or one this session has already been reading or editing: pass it as `document` on the first call. That is the usual case, and it returns the threads straight away.',
  'Every document in the workspace — "all my comments", a pass over everything before publishing: pass `all_documents: true`. A scope like any other; it just has to be the one that was actually asked for.',
  'Nothing has settled it yet: call with neither and you get back the documents that have comments. Recognise the one the user means, or show them the list and ask which.',
  'A description is not a path. "The new firewall policy" is specific enough to act on, but turning it into a path is what the unscoped call is for — pass the path it lists, not the words the user used.',
  'Review the scope you were given. Comments on other documents are a separate request, not the remainder of this one.',
];

export const REVIEW_GOAL =
  'Make the document correct and useful on its own terms. A reader who never saw the review should not be able to tell that one happened.';

export const IN_THE_DOCUMENT = [
  'Only substance a reader needs. Rewrite the passage so it reads as though it had always been written that way.',
  "Match the document's existing voice, register, terminology and level of detail.",
  'Keep the edit proportionate to the comment. Do not restructure, retitle, reorder or polish passages nobody commented on.',
  'If a fix makes another part of the document wrong — a figure quoted twice, a cross-reference, a summary line — fix that too, and say so in your note.',
];

export const NEVER_IN_THE_DOCUMENT = [
  'Any trace of the review: "updated per feedback", "as requested", "clarified below", changelog lines, TODOs, HTML comments, or markers tying text back to a comment.',
  'Your reasoning or justification for the change. The document states what is true; it does not argue for itself.',
  "Answers to the reviewer's questions, or questions back to the reviewer. Those are replies, not prose.",
  "The reviewer's own wording. Their comment says what is wrong; you decide how the prose should read.",
  'Hedging, caveats or vagueness added to cover your own uncertainty.',
  'New sections the comment did not ask for — no "Notes", "Assumptions" or "Changes" appendix.',
];

export const WHEN_UNSURE = [
  'A comment asserting something about the code or the world ("this is not how it works", "check repo x") is a pointer, not text to transcribe. Go read the source and write what is actually true.',
  'If you cannot establish the truth, leave the passage alone. Do not guess, and do not write something vague to paper over the gap — reply with what you found and what you still need.',
  'If the source contradicts the comment, say so in a reply rather than writing something you believe is wrong.',
];

export const READING_THE_DOCUMENT = [
  'The enclosing section of each commented passage comes back in `section_context`. Use it — it is there so that judging a paragraph in place does not cost a re-read of the whole file.',
  '`outline` says what else the document contains. Read past the section when your change touches something stated elsewhere — a figure, a definition, a cross-reference, an opening summary — or when the comment is about consistency rather than one passage.',
  'Read the whole document once when `size_hint` says it is short. Do it before your first edit to that document, not once per thread.',
  'Do not re-read a document already in your context unless it has changed since you read it.',
  'Never edit from `quoted_text` alone. A paragraph rewritten in isolation is how you end up contradicting or repeating the one next to it.',
];

export const CHANNELS = [
  'resolve_thread — you edited the document. One line on what changed.',
  'reply_thread — you need clarification, you disagree, or you found something the reviewer should see. Leaves the thread open.',
  'create_thread — a problem you noticed that nobody commented on. Raise it; do not silently fix it.',
];

export const MECHANICS = [
  '`quoted_text` is what the passage said when the comment was made; if `text_changed_since_comment` is true it may be out of date, so trust the document over the quote.',
  '`location.match: "lost"` means the passage no longer exists. Decide whether the comment still applies and say which — never re-add deleted text just to have something to attach a comment to.',
  'Never edit `.review/*.review.json` by hand. Use the tools.',
  'Finish by summarising what you changed, and what you left open and why.',
];

/** Machine-readable form, returned alongside threads so it is hardest to miss. */
export const HOW_TO_APPLY = {
  goal: REVIEW_GOAL,
  context_to_read: READING_THE_DOCUMENT,
  in_the_document: IN_THE_DOCUMENT,
  never_in_the_document: NEVER_IN_THE_DOCUMENT,
  when_unsure: WHEN_UNSURE,
  where_everything_else_goes: CHANNELS,
  mechanics: MECHANICS,
};

const bullets = (xs: readonly string[]): string => xs.map((x) => `- ${x}`).join('\n');

/** Prose form of the scope rules, for the MCP instructions and the slash command. */
export const SCOPE_CONTRACT = `**Say what you are reviewing.** A review is about a document, or about the whole workspace; either way the scope comes from the request, not from a guess about which document is in play.

${bullets(CHOOSING_THE_DOCUMENT)}`;

/** Prose form, for the MCP instructions and the slash command. */
export const EDITING_CONTRACT = `**Goal.** ${REVIEW_GOAL}

**Context to read before editing:**
${bullets(READING_THE_DOCUMENT)}

**In the document:**
${bullets(IN_THE_DOCUMENT)}

**Never in the document:**
${bullets(NEVER_IN_THE_DOCUMENT)}

**When you are unsure:**
${bullets(WHEN_UNSURE)}

**Everything else belongs in the thread, not the prose:**
${bullets(CHANNELS)}`;

/**
 * Sent on repeat calls in place of the full contract. Keeps the rule that is
 * broken most often — review chatter leaking into the prose — in front of
 * Claude without re-billing the whole page every time.
 */
export const HOW_TO_APPLY_REMINDER = {
  goal: REVIEW_GOAL,
  never_in_the_document: NEVER_IN_THE_DOCUMENT,
  note: 'Full guidance was returned on the first list_threads call this session.',
};
