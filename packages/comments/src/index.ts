import type { AuthorIdentity, SourceRange } from '@markroot/core';
export { CommentStore } from './store.js';

const THREAD_BLOCK = /\n?<!-- markroot:threads:v1\n([\s\S]*?)\n-->\s*$/;
const ANCHOR = /<!-- markroot:anchor:v1 id=([0-9a-f-]+) edge=(start|end) -->/g;

export interface CommentMessage {
  readonly id: string;
  readonly author: AuthorIdentity;
  readonly body: string;
  readonly createdAt: string;
}
export interface CommentSelector extends SourceRange {
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly blockLevel: boolean;
}
export interface CommentRevision {
  readonly commit: string | null;
  readonly contentHash: string;
}
export interface CommentResolution {
  readonly revision: CommentRevision;
  readonly selector: CommentSelector;
  readonly author: AuthorIdentity;
  readonly at: string;
}
export interface CommentThread {
  readonly id: string;
  readonly status: 'open' | 'resolved';
  readonly selector: CommentSelector;
  readonly messages: readonly CommentMessage[];
  readonly createdAt: string;
  /** Derived from messages and resolution; never a shared counter in storage. */
  readonly updatedAt: string;
  readonly sourceRevision?: CommentRevision;
  readonly resolution?: CommentResolution;
}
export interface ParsedComments {
  readonly cleanSource: string;
  readonly threads: readonly CommentThread[];
  readonly ranges: ReadonlyMap<string, SourceRange>;
  readonly orphans: readonly string[];
  readonly needsReview?: readonly string[];
}

export function createSelector(source: string, range: SourceRange, blockLevel = false): CommentSelector {
  if (!Number.isInteger(range.from) || !Number.isInteger(range.to) || range.from < 0 || range.to <= range.from || range.to > source.length) throw new RangeError('Select a non-empty comment range.');
  return { ...range, exact: source.slice(range.from, range.to), prefix: source.slice(Math.max(0, range.from - 32), range.from), suffix: source.slice(range.to, range.to + 32), blockLevel };
}

/** Never guess between repeated passages or attach deleted text to an old offset. */
export function locateSelector(source: string, selector: CommentSelector): SourceRange | undefined {
  if (!selector.exact) return undefined;
  const candidates: number[] = [];
  let cursor = 0;
  while ((cursor = source.indexOf(selector.exact, cursor)) >= 0) { candidates.push(cursor); cursor += 1; }
  const contextual = candidates.filter((from) => matchesContext(source, from, selector));
  const matches = contextual.length === 1 ? contextual : candidates;
  if (matches.length !== 1) return undefined;
  return { from: matches[0]!, to: matches[0]! + selector.exact.length };
}
function matchesContext(source: string, from: number, selector: CommentSelector): boolean {
  const to = from + selector.exact.length;
  return source.slice(Math.max(0, from - selector.prefix.length), from) === selector.prefix && source.slice(to, to + selector.suffix.length) === selector.suffix;
}

export function locateComments(source: string, threads: readonly CommentThread[]): ParsedComments {
  const ranges = new Map<string, SourceRange>();
  const orphans: string[] = [];
  const needsReview: string[] = [];
  for (const thread of threads) {
    const range = locateSelector(source, thread.selector);
    if (range) ranges.set(thread.id, range); else orphans.push(thread.id);
    if (thread.status === 'resolved') {
      const resolvedRange = thread.resolution && locateSelector(source, thread.resolution.selector);
      if (!resolvedRange || !matchesContext(source, resolvedRange.from, thread.resolution!.selector)) needsReview.push(thread.id);
    }
  }
  return { cleanSource: source, threads, ranges, orphans, needsReview };
}

/** Read-only compatibility reader. New comments are always written as YAML sidecars. */
export function parseComments(source: string): ParsedComments {
  const block = THREAD_BLOCK.exec(source);
  if (!block) return locateComments(source, []);
  const envelope = JSON.parse(block[1]!) as { version: number; threads: CommentThread[] };
  if (envelope.version !== 1 || !Array.isArray(envelope.threads)) throw new Error('Invalid embedded comment data; Markdown has been left unchanged.');
  const body = source.slice(0, block.index);
  const positions = new Map<string, Partial<Record<'start' | 'end', number>>>();
  let removed = 0;
  for (const match of body.matchAll(ANCHOR)) {
    const edges = positions.get(match[1]!) ?? {};
    edges[match[2] as 'start' | 'end'] = match.index - removed;
    positions.set(match[1]!, edges);
    removed += match[0].length;
  }
  const cleanSource = body.replace(ANCHOR, '');
  const threads = envelope.threads.map((thread) => {
    if (!thread.id || !thread.selector || !Array.isArray(thread.messages)) throw new Error('Invalid embedded comment thread; Markdown has been left unchanged.');
    const edges = positions.get(thread.id);
    const selector = edges?.start !== undefined && edges.end !== undefined && edges.end > edges.start
      ? createSelector(cleanSource, { from: edges.start, to: edges.end }, thread.selector.blockLevel)
      : thread.selector;
    return { ...thread, selector };
  });
  return locateComments(cleanSource, threads);
}

export function stripCommentMarkup(source: string): string {
  // Rendering must remain possible while a malformed legacy envelope is repaired.
  return source.replace(THREAD_BLOCK, '').replace(ANCHOR, '');
}

export async function commentRevision(source: string, commit: string | null): Promise<CommentRevision> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return { commit, contentHash: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('') };
}
