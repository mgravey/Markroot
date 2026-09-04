import type { AuthorIdentity, SourceRange } from '@markroot/core';

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

export interface CommentThread {
  readonly id: string;
  readonly status: 'open' | 'resolved';
  readonly selector: CommentSelector;
  readonly messages: readonly CommentMessage[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ThreadEnvelope { readonly version: 1; readonly threads: readonly CommentThread[] }

export interface ParsedComments {
  readonly cleanSource: string;
  readonly threads: readonly CommentThread[];
  readonly ranges: ReadonlyMap<string, SourceRange>;
  readonly orphans: readonly string[];
}

export function parseComments(source: string): ParsedComments {
  const block = THREAD_BLOCK.exec(source);
  const body = block ? source.slice(0, block.index) : source;
  let threads: readonly CommentThread[] = [];
  if (block?.[1]) {
    try {
      const envelope = JSON.parse(block[1]) as ThreadEnvelope;
      if (envelope.version === 1 && Array.isArray(envelope.threads)) threads = envelope.threads;
    } catch { threads = []; }
  }
  const positions = new Map<string, Partial<Record<'start' | 'end', number>>>();
  for (const match of body.matchAll(ANCHOR)) {
    const id = match[1]!;
    const edge = match[2]! as 'start' | 'end';
    const item = positions.get(id) ?? {};
    item[edge] = match.index;
    positions.set(id, item);
  }
  const ranges = new Map<string, SourceRange>();
  const orphans: string[] = [];
  for (const thread of threads) {
    const position = positions.get(thread.id);
    if (position?.start !== undefined && position.end !== undefined && position.end >= position.start) {
      const startMarker = anchor(thread.id, 'start');
      ranges.set(thread.id, { from: position.start + startMarker.length, to: position.end });
    } else orphans.push(thread.id);
  }
  return { cleanSource: body, threads, ranges, orphans };
}

export function createThread(
  source: string,
  range: SourceRange,
  body: string,
  author: AuthorIdentity,
  options: Readonly<{ blockLevel?: boolean; now?: string; id?: string }> = {},
): { readonly source: string; readonly thread: CommentThread } {
  if (!body.trim()) throw new Error('A comment body is required.');
  if (range.from < 0 || range.to < range.from || range.to > source.length) throw new RangeError('Invalid comment range.');
  const parsed = parseComments(source);
  const id = options.id ?? crypto.randomUUID();
  const now = options.now ?? new Date().toISOString();
  const exact = parsed.cleanSource.slice(range.from, range.to);
  const thread: CommentThread = Object.freeze({
    id,
    status: 'open',
    selector: {
      from: range.from,
      to: range.to,
      exact,
      prefix: parsed.cleanSource.slice(Math.max(0, range.from - 32), range.from),
      suffix: parsed.cleanSource.slice(range.to, range.to + 32),
      blockLevel: options.blockLevel === true,
    },
    messages: [message(body, author, now)],
    createdAt: now,
    updatedAt: now,
  });
  const anchored = `${parsed.cleanSource.slice(0, range.from)}${anchor(id, 'start')}${exact}${anchor(id, 'end')}${parsed.cleanSource.slice(range.to)}`;
  return { source: serialize(anchored, [...parsed.threads, thread]), thread };
}

export function replyToThread(source: string, threadId: string, body: string, author: AuthorIdentity, now = new Date().toISOString()): string {
  return update(source, threadId, (thread) => ({ ...thread, messages: [...thread.messages, message(body, author, now)], updatedAt: now }));
}

export function setThreadStatus(source: string, threadId: string, status: CommentThread['status'], now = new Date().toISOString()): string {
  return update(source, threadId, (thread) => ({ ...thread, status, updatedAt: now }));
}

export function deleteThread(source: string, threadId: string): string {
  const parsed = parseComments(source);
  const escaped = escapeRegExp(threadId);
  const withoutAnchors = parsed.cleanSource.replace(new RegExp(`<!-- markroot:anchor:v1 id=${escaped} edge=(?:start|end) -->`, 'g'), '');
  return serialize(withoutAnchors, parsed.threads.filter((thread) => thread.id !== threadId));
}

export function recoverOrphan(source: string, threadId: string): string {
  const parsed = parseComments(source);
  const thread = parsed.threads.find((candidate) => candidate.id === threadId);
  if (!thread || !parsed.orphans.includes(threadId) || !thread.selector.exact) return source;
  const candidates: number[] = [];
  let cursor = 0;
  while ((cursor = parsed.cleanSource.indexOf(thread.selector.exact, cursor)) >= 0) { candidates.push(cursor); cursor += Math.max(1, thread.selector.exact.length); }
  const ranked = candidates.filter((position) => {
    const prefix = parsed.cleanSource.slice(Math.max(0, position - thread.selector.prefix.length), position);
    const suffix = parsed.cleanSource.slice(position + thread.selector.exact.length, position + thread.selector.exact.length + thread.selector.suffix.length);
    return (!thread.selector.prefix || prefix === thread.selector.prefix) && (!thread.selector.suffix || suffix === thread.selector.suffix);
  });
  const positions = ranked.length === 1 ? ranked : candidates;
  if (positions.length !== 1) return source;
  const from = positions[0]!;
  const to = from + thread.selector.exact.length;
  const anchored = `${parsed.cleanSource.slice(0, from)}${anchor(threadId, 'start')}${thread.selector.exact}${anchor(threadId, 'end')}${parsed.cleanSource.slice(to)}`;
  return serialize(anchored, parsed.threads);
}

export function stripCommentMarkup(source: string): string {
  return parseComments(source).cleanSource.replace(ANCHOR, '');
}

function update(source: string, id: string, mutate: (thread: CommentThread) => CommentThread): string {
  const parsed = parseComments(source);
  let found = false;
  const threads = parsed.threads.map((thread) => {
    if (thread.id !== id) return thread;
    found = true;
    return mutate(thread);
  });
  if (!found) throw new Error(`Comment thread not found: ${id}`);
  return serialize(parsed.cleanSource, threads);
}

function serialize(source: string, threads: readonly CommentThread[]): string {
  const clean = source.replace(/\s+$/, '');
  if (!threads.length) return `${clean}\n`;
  const json = JSON.stringify({ version: 1, threads }, null, 2).replaceAll('--', '\\u002d\\u002d');
  return `${clean}\n\n<!-- markroot:threads:v1\n${json}\n-->\n`;
}

function anchor(id: string, edge: 'start' | 'end'): string { return `<!-- markroot:anchor:v1 id=${id} edge=${edge} -->`; }
function message(body: string, author: AuthorIdentity, createdAt: string): CommentMessage { return { id: crypto.randomUUID(), author, body: body.trim(), createdAt }; }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
