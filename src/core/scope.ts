import type { Thread, ThreadStatus } from './types.js';

/**
 * Which threads a request is about, and which documents could answer it.
 *
 * A review is scoped to what the user asked about. When that is a document, the
 * caller says so; when it is the whole workspace, the caller says that too. This
 * module exists for the third case — the request did not settle it — where the
 * answer is the list of documents that have comments, so the scope can be
 * recognised from the conversation or put to the user, rather than assumed.
 */

export type StatusFilter = ThreadStatus | 'needs_attention' | 'all';

/** open + stale: the two states waiting on Claude rather than on the reviewer. */
export function matchesStatus(thread: Thread, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'needs_attention') return thread.status === 'open' || thread.status === 'stale';
  return thread.status === filter;
}

/**
 * Enough of a document to recognise it by, and nothing more.
 *
 * `sections` is the point: a request names a document the way a person does
 * ("the firewall policy", "the bit about egress"), and the headings a document's
 * comments sit under are what that matches against. Thread bodies would match
 * better still and cost a hundred times more, which is the wrong trade for a
 * list whose only job is to be chosen from.
 */
export interface DocumentCandidate {
  document: string;
  /** Threads matching the requested status. */
  matching: number;
  /** Breakdown of those threads, omitting statuses with none. */
  status: Partial<Record<ThreadStatus, number>>;
  sections: string[];
}

/** Past this a section list stops helping you recognise a document. */
export const MAX_CANDIDATE_SECTIONS = 6;

const sectionOf = (t: Thread): string => t.anchor.headingPath.join(' > ') || '(document root)';

/**
 * The documents with threads matching `filter`, in path order.
 *
 * Deliberately not ordered by recency, and carrying no "most recent" marker.
 * Which document is being worked on is a fact about the conversation, not about
 * these files: two documents edited in parallel from two sessions would both
 * look current here, and a list that ranks them invites picking the top one
 * instead of the right one.
 */
export interface CandidateInput {
  document: string;
  threads: readonly Thread[];
}

export function candidateDocuments(
  files: readonly CandidateInput[],
  filter: StatusFilter,
): DocumentCandidate[] {
  const out: DocumentCandidate[] = [];
  for (const file of files) {
    const matching = file.threads.filter((t) => matchesStatus(t, filter));
    if (matching.length === 0) continue;

    const status: Partial<Record<ThreadStatus, number>> = {};
    for (const t of matching) status[t.status] = (status[t.status] ?? 0) + 1;

    const seen: string[] = [];
    for (const t of matching) {
      const section = sectionOf(t);
      if (!seen.includes(section)) seen.push(section);
    }
    const sections = seen.slice(0, MAX_CANDIDATE_SECTIONS);
    if (seen.length > sections.length) sections.push(`… ${seen.length - sections.length} more`);

    out.push({ document: file.document, matching: matching.length, status, sections });
  }
  return out.sort((a, b) => a.document.localeCompare(b.document));
}
