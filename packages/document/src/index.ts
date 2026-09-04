import { MarkrootError, type SourceRange, type WorkspacePath } from '@markroot/core';

export type DocumentBlockKind = 'frontmatter' | 'heading' | 'paragraph' | 'list' | 'code' | 'div' | 'quote' | 'table' | 'raw';

export interface DocumentBlock extends SourceRange {
  readonly id: string;
  readonly kind: DocumentBlockKind;
  readonly text: string;
  readonly editable: boolean;
  readonly level?: number;
}

export interface DocumentDiagnostic extends SourceRange {
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
}

export interface DocumentEdit extends SourceRange {
  readonly insert: string;
  readonly origin: 'source' | 'visual' | 'comment' | 'review' | 'system';
  readonly baseRevision: number;
}

export interface DocumentSnapshot {
  readonly path: WorkspacePath;
  readonly source: string;
  readonly revision: number;
  readonly savedRevision: number;
  readonly dirty: boolean;
  readonly blocks: readonly DocumentBlock[];
  readonly diagnostics: readonly DocumentDiagnostic[];
}

export type DocumentSubscriber = (snapshot: DocumentSnapshot, edit?: DocumentEdit) => void;

export class DocumentSession {
  private source: string;
  private revision = 0;
  private savedRevision = 0;
  private diagnostics: readonly DocumentDiagnostic[] = [];
  private blocks: readonly DocumentBlock[];
  private readonly subscribers = new Set<DocumentSubscriber>();

  constructor(readonly path: WorkspacePath, source: string) {
    this.source = source;
    this.blocks = mapDocumentBlocks(source);
  }

  snapshot(): DocumentSnapshot {
    return Object.freeze({
      path: this.path,
      source: this.source,
      revision: this.revision,
      savedRevision: this.savedRevision,
      dirty: this.revision !== this.savedRevision,
      blocks: this.blocks,
      diagnostics: this.diagnostics,
    });
  }

  subscribe(subscriber: DocumentSubscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.snapshot());
    return () => this.subscribers.delete(subscriber);
  }

  apply(edit: DocumentEdit): DocumentSnapshot {
    if (edit.baseRevision !== this.revision) throw new MarkrootError('STALE_REVISION', `Document revision ${edit.baseRevision} is stale; current revision is ${this.revision}.`);
    if (edit.from < 0 || edit.to < edit.from || edit.to > this.source.length) throw new RangeError('Invalid document edit range.');
    this.source = `${this.source.slice(0, edit.from)}${edit.insert}${this.source.slice(edit.to)}`;
    this.revision += 1;
    this.blocks = mapDocumentBlocks(this.source);
    const snapshot = this.snapshot();
    for (const subscriber of this.subscribers) subscriber(snapshot, edit);
    return snapshot;
  }

  replace(source: string, origin: DocumentEdit['origin'] = 'source'): DocumentSnapshot {
    return this.apply({ from: 0, to: this.source.length, insert: source, origin, baseRevision: this.revision });
  }

  markSaved(expectedRevision = this.revision): DocumentSnapshot {
    if (expectedRevision !== this.revision) throw new MarkrootError('STALE_REVISION', 'Cannot mark a stale document revision as saved.');
    this.savedRevision = this.revision;
    const snapshot = this.snapshot();
    for (const subscriber of this.subscribers) subscriber(snapshot);
    return snapshot;
  }

  setDiagnostics(diagnostics: readonly DocumentDiagnostic[]): DocumentSnapshot {
    this.diagnostics = Object.freeze([...diagnostics]);
    const snapshot = this.snapshot();
    for (const subscriber of this.subscribers) subscriber(snapshot);
    return snapshot;
  }
}

export interface SearchOptions { readonly caseSensitive?: boolean; readonly regularExpression?: boolean }
export interface SearchMatch extends SourceRange { readonly blockId?: string; readonly text: string }

export function searchDocument(snapshot: DocumentSnapshot, query: string, options: SearchOptions = {}): readonly SearchMatch[] {
  if (!query) return [];
  let expression: RegExp;
  try {
    expression = new RegExp(options.regularExpression ? query : escapeRegExp(query), `gu${options.caseSensitive ? '' : 'i'}`);
  } catch { return []; }
  const matches: SearchMatch[] = [];
  for (const match of snapshot.source.matchAll(expression)) {
    const from = match.index;
    const text = match[0];
    if (!text) { expression.lastIndex += 1; continue; }
    const block = snapshot.blocks.find((candidate) => from >= candidate.from && from < candidate.to);
    matches.push({ from, to: from + text.length, text, ...(block ? { blockId: block.id } : {}) });
  }
  return matches;
}

export function mapDocumentBlocks(source: string): readonly DocumentBlock[] {
  const lines = source.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) ?? [];
  const blocks: DocumentBlock[] = [];
  let offset = 0;
  let start = 0;
  let buffer: string[] = [];
  let mode: 'frontmatter' | 'code' | 'div' | undefined;
  let fence = '';

  const flush = (forcedKind?: DocumentBlockKind) => {
    if (!buffer.length) return;
    const text = buffer.join('');
    const trimmed = text.trimStart();
    const kind = forcedKind ?? classify(trimmed);
    const heading = /^\s*(#{1,6})\s+/.exec(text);
    blocks.push(Object.freeze({
      id: blockId(kind, text, blocks.length),
      kind,
      text,
      from: start,
      to: start + text.length,
      editable: !['frontmatter', 'raw'].includes(kind),
      ...(heading ? { level: heading[1]!.length } : {}),
    }));
    buffer = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (!buffer.length) start = offset;

    if (!mode && index === 0 && trimmed === '---') { mode = 'frontmatter'; buffer.push(line); offset += line.length; continue; }
    if (mode === 'frontmatter') {
      buffer.push(line); offset += line.length;
      if (index > 0 && (trimmed === '---' || trimmed === '...')) { flush('frontmatter'); mode = undefined; }
      continue;
    }
    if (!mode) {
      const codeMatch = /^(`{3,}|~{3,})/.exec(trimmed);
      if (codeMatch) { flush(); mode = 'code'; fence = codeMatch[1]!; start = offset; buffer.push(line); offset += line.length; continue; }
      if (/^:{3,}/.test(trimmed)) { flush(); mode = 'div'; fence = trimmed.match(/^:+/)![0]; start = offset; buffer.push(line); offset += line.length; continue; }
    } else {
      buffer.push(line); offset += line.length;
      if ((mode === 'code' && trimmed.startsWith(fence)) || (mode === 'div' && trimmed === fence)) { flush(mode); mode = undefined; fence = ''; }
      continue;
    }
    if (!trimmed) { flush(); offset += line.length; continue; }
    if (/^#{1,6}\s/.test(trimmed) && buffer.length) flush();
    if (!buffer.length) start = offset;
    buffer.push(line);
    offset += line.length;
    if (/^#{1,6}\s/.test(trimmed)) flush('heading');
  }
  flush(mode);
  return Object.freeze(blocks);
}

function classify(trimmed: string): DocumentBlockKind {
  if (/^#{1,6}\s/.test(trimmed)) return 'heading';
  if (/^(?:[-*+] |\d+[.)] )/.test(trimmed)) return 'list';
  if (/^>/.test(trimmed)) return 'quote';
  if (/^\|.+\|/.test(trimmed)) return 'table';
  if (/^<(?!!--)/.test(trimmed)) return 'raw';
  return 'paragraph';
}

function blockId(kind: DocumentBlockKind, text: string, ordinal: number): string {
  let hash = 2166136261;
  const key = `${kind}\u0000${text.trim().slice(0, 256)}`;
  for (let i = 0; i < key.length; i += 1) { hash ^= key.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `b-${(hash >>> 0).toString(36)}-${ordinal}`;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
