import { Document, isScalar, parseDocument, visit } from 'yaml';
import { MarkrootError, workspacePath, type AuthorIdentity, type SourceRange, type WorkspacePath } from '@markroot/core';
import type { GuardedWorkspace } from '@markroot/workspace';
import { createSelector, type CommentMessage, type CommentResolution, type CommentRevision, type CommentSelector, type CommentThread } from './index.js';

const ROOT = workspacePath('.markroot/comments');
/** Immutable after creation. Legacy files may still carry mutated state, which is read as the initial state. */
interface ThreadRecord {
  version: 1;
  id: string;
  document: string;
  createdAt: string;
  sourceRevision: CommentRevision | null;
  selector: CommentSelector;
  status: 'open' | 'resolved';
  resolution: CommentResolution | null;
  deleted: boolean;
}
type ThreadEvent = { readonly seq?: number } & (
  | { version: 1; id: string; at: string; type: 'resolve'; resolution: CommentResolution }
  | { version: 1; id: string; at: string; type: 'reopen' | 'delete' }
  | { version: 1; id: string; at: string; type: 'reattach'; selector: CommentSelector; sourceRevision: CommentRevision | null });
interface ThreadState {
  readonly record: ThreadRecord;
  readonly status: 'open' | 'resolved';
  readonly selector: CommentSelector;
  readonly sourceRevision: CommentRevision | null;
  readonly resolution: CommentResolution | null;
  readonly deleted: boolean;
  readonly updatedAt: string;
}
/** A thread directory that could not be read (malformed YAML, unresolved Git conflict, invalid ID). */
export interface BrokenCommentThread {
  readonly id: string;
  /** Known only when thread.yaml itself was readable. */
  readonly document?: string;
  readonly error: string;
}
export interface CommentLoadResult {
  readonly threads: readonly CommentThread[];
  readonly broken: readonly BrokenCommentThread[];
}

/**
 * Git is the transport. Every reply and every state change (resolve, reopen, reattach, delete) is an
 * independent immutable file, so concurrent branches only ever add files and merge without conflicts.
 */
export class CommentStore {
  private readonly cache = new Map<string, { readonly version: string; readonly value: unknown }>();
  constructor(private readonly workspace: GuardedWorkspace) {}

  /** Threads of a document; unreadable threads are skipped (see loadWithIssues). */
  async load(document: WorkspacePath): Promise<readonly CommentThread[]> { return (await this.loadWithIssues(document)).threads; }

  async loadWithIssues(document: WorkspacePath): Promise<CommentLoadResult> {
    const threads: CommentThread[] = [];
    const broken: BrokenCommentThread[] = [];
    for (const entry of await this.list(ROOT)) {
      if (entry.kind !== 'directory') continue;
      const id = entry.path.split('/').at(-1)!;
      let owner: string | undefined;
      try {
        const record = await this.record(id);
        // A directory without thread.yaml can be an interrupted write; retain its messages.
        if (!record || record.document !== document) continue;
        owner = record.document;
        const state = await this.state(record);
        if (state.deleted) continue;
        const messages: CommentMessage[] = [];
        for (const messageEntry of await this.list(workspacePath(`${entry.path}/messages`))) {
          if (messageEntry.kind !== 'file' || !messageEntry.path.endsWith('.yaml')) continue;
          const value = await this.parsed(messageEntry.path);
          validateMessage(value);
          if (messageEntry.path.split('/').at(-1) !== `${value.id}.yaml`) throw new Error(`Comment message ID does not match ${messageEntry.path}`);
          messages.push(value);
        }
        messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
        threads.push({ id, selector: state.selector, status: state.status, createdAt: record.createdAt, messages,
          updatedAt: [...messages.map((message) => message.createdAt), state.updatedAt].sort().at(-1)!,
          ...(state.sourceRevision ? { sourceRevision: state.sourceRevision } : {}),
          ...(state.resolution ? { resolution: state.resolution } : {}),
        });
      } catch (error) {
        broken.push({ id, ...(owner ? { document: owner } : {}), error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { threads: threads.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)), broken };
  }

  /** Include tombstones when preparing a document commit. Threads whose thread.yaml is unreadable are left out. */
  async paths(document: WorkspacePath): Promise<readonly WorkspacePath[]> {
    const paths: WorkspacePath[] = [];
    for (const entry of await this.list(ROOT)) {
      if (entry.kind !== 'directory') continue;
      const id = entry.path.split('/').at(-1)!;
      const record = await this.record(id).catch(() => undefined);
      if (!record || record.document !== document) continue;
      paths.push(threadPath(id));
      for (const folder of ['events', 'messages']) {
        for (const file of await this.list(workspacePath(`${entry.path}/${folder}`))) {
          if (file.kind === 'file' && file.path.endsWith('.yaml')) paths.push(file.path);
        }
      }
    }
    return paths.sort();
  }

  async create(document: WorkspacePath, source: string, range: SourceRange, body: string, author: AuthorIdentity, revision: CommentRevision, blockLevel = false): Promise<string> {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const selector = createSelector(source, range, blockLevel);
    const message = newMessage(body, author, createdAt);
    // Publish metadata last, so an interrupted creation does not display an empty thread.
    await this.writeMessage(id, message);
    await this.workspace.writeFileGuarded(threadPath(id), encode({ version: 1, id, document, createdAt, sourceRevision: revision, selector, status: 'open', resolution: null, deleted: false } satisfies ThreadRecord));
    return id;
  }

  async reply(document: WorkspacePath, id: string, body: string, author: AuthorIdentity): Promise<void> {
    await this.requireState(document, id);
    await this.writeMessage(id, newMessage(body, author, new Date().toISOString()));
  }

  async setStatus(document: WorkspacePath, id: string, status: 'open' | 'resolved', resolution?: CommentResolution): Promise<void> {
    if (status === 'resolved' && !resolution) throw new Error('A resolution must identify the reviewed passage and revision.');
    await this.requireState(document, id);
    await this.writeEvent(id, status === 'resolved' ? { type: 'resolve', resolution: resolution! } : { type: 'reopen' });
  }

  async reattach(document: WorkspacePath, id: string, source: string, range: SourceRange, revision: CommentRevision): Promise<void> {
    const state = await this.requireState(document, id);
    await this.writeEvent(id, { type: 'reattach', selector: createSelector(source, range, state.selector.blockLevel), sourceRevision: revision });
  }

  async delete(document: WorkspacePath, id: string): Promise<void> {
    // A tombstone event always wins, so a concurrent reply or resolution cannot resurrect the thread after merging.
    await this.requireState(document, id);
    await this.writeEvent(id, { type: 'delete' });
  }

  /** Idempotent, sidecars-first migration. Never overwrite newer replies or resolutions. */
  async importLegacy(document: WorkspacePath, threads: readonly CommentThread[], revision: CommentRevision): Promise<void> {
    for (const thread of threads) {
      const existing = await this.record(thread.id);
      if (existing && existing.document !== document) throw new Error(`Comment ${thread.id} already belongs to another document.`);
      for (const message of thread.messages) await this.writeMessage(thread.id, message, true);
      if (existing) continue;
      const value: ThreadRecord = { version: 1, id: thread.id, document, createdAt: thread.createdAt, sourceRevision: thread.sourceRevision ?? revision, selector: thread.selector, status: thread.status, resolution: null, deleted: false };
      validateRecord(value);
      await this.workspace.writeFileGuarded(threadPath(thread.id), encode(value));
    }
  }

  private async writeMessage(id: string, message: CommentMessage, preserveExisting = false): Promise<void> {
    validateMessage(message);
    const path = workspacePath(`${threadDirectory(id)}/messages/${safeId(message.id)}.yaml`);
    if (preserveExisting && await this.exists(path)) return;
    await this.workspace.writeFileGuarded(path, encode({ id: message.id, author: message.author, createdAt: message.createdAt, body: message.body }));
  }
  private async writeEvent(threadId: string, change: DistributiveOmit<ThreadEvent, 'version' | 'id' | 'at' | 'seq'>): Promise<void> {
    const known = await this.events(threadId);
    const seq = 1 + known.reduce((maximum, event) => Math.max(maximum, event.seq ?? 0), 0);
    const event = { version: 1, id: crypto.randomUUID(), at: new Date().toISOString(), seq, ...change } as ThreadEvent;
    validateEvent(event);
    await this.workspace.writeFileGuarded(workspacePath(`${threadDirectory(threadId)}/events/${event.id}.yaml`), encode(event));
  }
  private async requireState(document: WorkspacePath, id: string): Promise<ThreadState> {
    const record = await this.record(id);
    const state = record && record.document === document ? await this.state(record) : undefined;
    if (!state || state.deleted) throw new Error(`Comment thread not found: ${id}`);
    return state;
  }
  private async events(id: string): Promise<ThreadEvent[]> {
    const events: ThreadEvent[] = [];
    for (const entry of await this.list(workspacePath(`${threadDirectory(id)}/events`))) {
      if (entry.kind !== 'file' || !entry.path.endsWith('.yaml')) continue;
      const value = await this.parsed(entry.path);
      validateEvent(value);
      if (entry.path.split('/').at(-1) !== `${value.id}.yaml`) throw new Error(`Comment event ID does not match ${entry.path}`);
      events.push(value);
    }
    return events;
  }
  /** Legacy unsequenced events form the initial history in timestamp order; new causal events follow.
   * Concurrent events at the same sequence use timestamp and ID as deterministic tie breakers. */
  private async state(record: ThreadRecord): Promise<ThreadState> {
    const events = await this.events(record.id);
    events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    let { status, selector, sourceRevision, resolution, deleted } = record;
    for (const event of events) {
      if (event.type === 'resolve') { status = 'resolved'; resolution = event.resolution; }
      else if (event.type === 'reopen') { status = 'open'; resolution = null; }
      else if (event.type === 'reattach') { selector = event.selector; sourceRevision = event.sourceRevision; status = 'open'; resolution = null; }
      else deleted = true;
    }
    const updatedAt = [record.createdAt, record.resolution?.at ?? '', ...events.map((event) => event.at)].sort().at(-1)!;
    return { record, status, selector, sourceRevision, resolution, deleted, updatedAt };
  }
  private async record(id: string): Promise<ThreadRecord | undefined> {
    const path = threadPath(id);
    try {
      const value = await this.parsed(path);
      validateRecord(value);
      if (value.id !== id) throw new Error(`Comment thread ID does not match ${path}`);
      return value;
    } catch (error) { if (isMissing(error)) return undefined; throw error; }
  }
  /** Sidecars are immutable once written, so parsed YAML is reused until the file version changes. */
  private async parsed(path: WorkspacePath): Promise<unknown> {
    const version = (await this.workspace.stat(path)).version;
    const cached = this.cache.get(path);
    if (version !== undefined && cached?.version === version) return structuredClone(cached.value);
    const value = decode(await this.workspace.readFile(path), path);
    if (version !== undefined) this.cache.set(path, { version, value }); else this.cache.delete(path);
    return structuredClone(value);
  }
  private async exists(path: WorkspacePath): Promise<boolean> {
    try { await this.workspace.stat(path); return true; } catch (error) { if (isMissing(error)) return false; throw error; }
  }
  private async list(path: WorkspacePath) {
    try { return await this.workspace.listFiles(path); } catch (error) { if (isMissing(error)) return []; throw error; }
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function safeId(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`Invalid comment ID: ${value}`);
  return value;
}
function threadDirectory(id: string): string { return `${ROOT}/${safeId(id)}`; }
function threadPath(id: string): WorkspacePath { return workspacePath(`${threadDirectory(id)}/thread.yaml`); }
function isMissing(error: unknown): boolean { return error instanceof MarkrootError && error.code === 'NOT_FOUND'; }
function encode(value: unknown): string {
  const document = new Document(value);
  visit(document, { Scalar(key, node) { if (key !== 'key' && typeof node.value === 'string' && node.value.includes('\n')) node.type = 'BLOCK_LITERAL'; } });
  const body = document.get('body', true);
  if (isScalar(body)) body.type = 'BLOCK_LITERAL';
  return document.toString({ lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN', blockQuote: 'literal' });
}
function decode(source: string, path: string): unknown {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`Cannot read ${path}: resolve its YAML or Git merge conflict first. ${document.errors[0]!.message}`);
  return document.toJS({ maxAliasCount: 0 });
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function author(value: unknown): value is AuthorIdentity { return object(value) && typeof value.actorId === 'string' && typeof value.displayName === 'string' && (value.email === undefined || typeof value.email === 'string'); }
function revision(value: unknown): value is CommentRevision { return object(value) && (value.commit === null || typeof value.commit === 'string') && typeof value.contentHash === 'string' && /^[0-9a-f]{64}$/.test(value.contentHash); }
function selector(value: unknown): value is CommentSelector {
  return object(value) && Number.isInteger(value.from) && Number.isInteger(value.to) && (value.from as number) >= 0 && (value.to as number) >= (value.from as number) && typeof value.exact === 'string' && typeof value.prefix === 'string' && typeof value.suffix === 'string' && typeof value.blockLevel === 'boolean';
}
function validateMessage(value: unknown): asserts value is CommentMessage {
  if (!object(value) || typeof value.id !== 'string' || !author(value.author) || typeof value.body !== 'string' || !value.body.trim() || typeof value.createdAt !== 'string') throw new Error('Invalid comment message YAML.');
  safeId(value.id);
}
function validateRecord(value: unknown): asserts value is ThreadRecord {
  if (!object(value) || value.version !== 1 || typeof value.id !== 'string' || typeof value.document !== 'string' || typeof value.createdAt !== 'string' || !selector(value.selector) || !['open', 'resolved'].includes(value.status as string) || typeof value.deleted !== 'boolean' || (value.sourceRevision !== null && !revision(value.sourceRevision))) throw new Error('Invalid comment thread YAML.');
  safeId(value.id);
  workspacePath(value.document);
  if (value.resolution !== null) validateResolution(value.resolution);
}
function validateEvent(value: unknown): asserts value is ThreadEvent {
  if (!object(value) || value.version !== 1 || typeof value.id !== 'string' || typeof value.at !== 'string' || !['resolve', 'reopen', 'reattach', 'delete'].includes(value.type as string)) throw new Error('Invalid comment event YAML.');
  safeId(value.id);
  if (value.seq !== undefined && (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1)) throw new Error('Invalid comment event sequence.');
  if (value.type === 'resolve') validateResolution(value.resolution);
  if (value.type === 'reattach' && (!selector(value.selector) || (value.sourceRevision !== null && !revision(value.sourceRevision)))) throw new Error('Invalid comment reattach event YAML.');
}
function validateResolution(item: unknown): void {
  if (!object(item) || !revision(item.revision) || !selector(item.selector) || !author(item.author) || typeof item.at !== 'string') throw new Error('Invalid comment resolution YAML.');
}
function newMessage(body: string, author: AuthorIdentity, createdAt: string): CommentMessage {
  if (!body.trim()) throw new Error('A comment body is required.');
  return { id: crypto.randomUUID(), author, createdAt, body: body.trim() };
}
