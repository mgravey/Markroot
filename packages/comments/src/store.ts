import { Document, isScalar, parseDocument, visit } from 'yaml';
import { MarkrootError, workspacePath, type AuthorIdentity, type SourceRange, type WorkspacePath } from '@markroot/core';
import type { GuardedWorkspace } from '@markroot/workspace';
import { createSelector, type CommentMessage, type CommentResolution, type CommentRevision, type CommentSelector, type CommentThread } from './index.js';

const ROOT = workspacePath('.markroot/comments');
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

/** Git is the transport. Each reply is an independent immutable file. */
export class CommentStore {
  constructor(private readonly workspace: GuardedWorkspace) {}

  async load(document: WorkspacePath): Promise<readonly CommentThread[]> {
    const entries = await this.list(ROOT);
    const threads: CommentThread[] = [];
    for (const entry of entries) {
      if (entry.kind !== 'directory') continue;
      const id = entry.path.split('/').at(-1)!;
      const record = await this.record(id);
      // A directory without thread.yaml can be an interrupted write; retain its messages.
      if (!record || record.value.document !== document || record.value.deleted) continue;
      const messages: CommentMessage[] = [];
      for (const messageEntry of await this.list(workspacePath(`${entry.path}/messages`))) {
        if (messageEntry.kind !== 'file' || !messageEntry.path.endsWith('.yaml')) continue;
        const value = decode(await this.workspace.readFile(messageEntry.path), messageEntry.path);
        validateMessage(value);
        if (messageEntry.path.split('/').at(-1) !== `${value.id}.yaml`) throw new Error(`Comment message ID does not match ${messageEntry.path}`);
        messages.push(value);
      }
      messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const item = record.value;
      threads.push({ id, selector: item.selector, status: item.status, createdAt: item.createdAt, messages,
        updatedAt: [...messages.map((message) => message.createdAt), item.createdAt, item.resolution?.at ?? ''].sort().at(-1)!,
        ...(item.sourceRevision ? { sourceRevision: item.sourceRevision } : {}),
        ...(item.resolution ? { resolution: item.resolution } : {}),
      });
    }
    return threads.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /** Include tombstones when preparing a document commit. */
  async paths(document: WorkspacePath): Promise<readonly WorkspacePath[]> {
    const paths: WorkspacePath[] = [];
    for (const entry of await this.list(ROOT)) {
      if (entry.kind !== 'directory') continue;
      const id = entry.path.split('/').at(-1)!;
      const record = await this.record(id);
      if (!record || record.value.document !== document) continue;
      paths.push(threadPath(id));
      for (const message of await this.list(workspacePath(`${entry.path}/messages`))) {
        if (message.kind === 'file' && message.path.endsWith('.yaml')) paths.push(message.path);
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
    await this.requireRecord(document, id);
    await this.writeMessage(id, newMessage(body, author, new Date().toISOString()));
  }

  async setStatus(document: WorkspacePath, id: string, status: 'open' | 'resolved', resolution?: CommentResolution): Promise<void> {
    if (status === 'resolved' && !resolution) throw new Error('A resolution must identify the reviewed passage and revision.');
    await this.update(document, id, (record) => ({ ...record, status, resolution: status === 'resolved' ? resolution! : null }));
  }

  async reattach(document: WorkspacePath, id: string, source: string, range: SourceRange, revision: CommentRevision): Promise<void> {
    await this.update(document, id, (record) => ({ ...record, selector: createSelector(source, range, record.selector.blockLevel), sourceRevision: revision, status: 'open', resolution: null }));
  }

  async delete(document: WorkspacePath, id: string): Promise<void> {
    // Keep a tombstone so a concurrent reply cannot resurrect the thread after merging.
    await this.update(document, id, (record) => ({ ...record, deleted: true }));
  }

  /** Idempotent, sidecars-first migration. Never overwrite newer replies or resolutions. */
  async importLegacy(document: WorkspacePath, threads: readonly CommentThread[], revision: CommentRevision): Promise<void> {
    for (const thread of threads) {
      const existing = await this.record(thread.id);
      if (existing && existing.value.document !== document) throw new Error(`Comment ${thread.id} already belongs to another document.`);
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
  private async update(document: WorkspacePath, id: string, mutate: (value: ThreadRecord) => ThreadRecord): Promise<void> {
    const record = await this.requireRecord(document, id);
    await this.workspace.writeFileGuarded(threadPath(id), encode(mutate(record.value)), record.version);
  }
  private async requireRecord(document: WorkspacePath, id: string) {
    const record = await this.record(id);
    if (!record || record.value.document !== document || record.value.deleted) throw new Error(`Comment thread not found: ${id}`);
    return record;
  }
  private async record(id: string) {
    const path = threadPath(id);
    try {
      const stat = await this.workspace.stat(path);
      const value = decode(await this.workspace.readFile(path), path);
      validateRecord(value);
      if (value.id !== id) throw new Error(`Comment thread ID does not match ${path}`);
      return { value, version: stat.version };
    } catch (error) { if (isMissing(error)) return undefined; throw error; }
  }
  private async exists(path: WorkspacePath): Promise<boolean> {
    try { await this.workspace.stat(path); return true; } catch (error) { if (isMissing(error)) return false; throw error; }
  }
  private async list(path: WorkspacePath) {
    try { return await this.workspace.listFiles(path); } catch (error) { if (isMissing(error)) return []; throw error; }
  }
}

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
  if (value.resolution !== null) {
    const item = value.resolution;
    if (!object(item) || !revision(item.revision) || !selector(item.selector) || !author(item.author) || typeof item.at !== 'string') throw new Error('Invalid comment resolution YAML.');
  }
}
function newMessage(body: string, author: AuthorIdentity, createdAt: string): CommentMessage {
  if (!body.trim()) throw new Error('A comment body is required.');
  return { id: crypto.randomUUID(), author, createdAt, body: body.trim() };
}
