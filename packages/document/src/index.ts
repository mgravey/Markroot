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

  /** Records `revision` as persisted. An older revision (edits arrived during the save) leaves the document dirty. */
  markSaved(revision = this.revision): DocumentSnapshot {
    if (!Number.isInteger(revision) || revision < 0 || revision > this.revision) throw new MarkrootError('STALE_REVISION', `Cannot mark unknown revision ${revision} as saved; current revision is ${this.revision}.`);
    this.savedRevision = revision;
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

/** Splits source into lines that keep their terminator; only CRLF, CR and LF end a line, so offsets stay exact. */
export function splitLines(source: string): readonly string[] {
  return source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? [];
}

export interface CodeFence { readonly marker: '`' | '~'; readonly length: number }

/** Parses an opening code fence (backtick info strings may not contain backticks, as in CommonMark). */
export function openingCodeFence(line: string): CodeFence | undefined {
  const match = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line.replace(/[\r\n]+$/, ''));
  if (!match || (match[1]![0] === '`' && match[2]!.includes('`'))) return undefined;
  return { marker: match[1]![0] as CodeFence['marker'], length: match[1]!.length };
}

/** A closing fence is bare and uses the opening character at least as many times. */
export function closesCodeFence(line: string, fence: CodeFence): boolean {
  const match = /^[ \t]*(`{3,}|~{3,})[ \t]*\r?\n?$/.exec(line);
  return Boolean(match && match[1]![0] === fence.marker && match[1]!.length >= fence.length);
}

/** Pandoc YAML metadata needs a closing `---`/`...` line and a non-blank line after the opener. Returns its line count. */
function frontmatterLineCount(lines: readonly string[]): number {
  if (trimLine(lines[0] ?? '') !== '---' || !trimLine(lines[1] ?? '')) return 0;
  for (let index = 1; index < lines.length; index += 1) if (/^(?:---|\.\.\.)$/.test(trimLine(lines[index]!))) return index + 1;
  return 0;
}

export function mapDocumentBlocks(source: string, options: { readonly frontmatter?: boolean } = {}): readonly DocumentBlock[] {
  const lines = splitLines(source);
  const blocks: DocumentBlock[] = [];
  const frontmatterLines = options.frontmatter === false ? 0 : frontmatterLineCount(lines);
  let offset = 0;
  let start = 0;
  let buffer: string[] = [];
  let mode: 'code' | 'div' | undefined;
  let fence: CodeFence | undefined;
  let innerFence: CodeFence | undefined;
  let depth = 0;

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
    const trimmed = trimLine(line);
    if (!buffer.length) start = offset;

    if (index < frontmatterLines) {
      buffer.push(line); offset += line.length;
      if (index === frontmatterLines - 1) flush('frontmatter');
      continue;
    }
    if (!mode) {
      const codeFence = openingCodeFence(line);
      if (codeFence) { flush(); mode = 'code'; fence = codeFence; start = offset; buffer.push(line); offset += line.length; continue; }
      if (/^:{3,}\s*\S/.test(trimmed)) { flush(); mode = 'div'; depth = 1; innerFence = undefined; start = offset; buffer.push(line); offset += line.length; continue; }
    } else {
      buffer.push(line); offset += line.length;
      if (mode === 'code') {
        if (closesCodeFence(line, fence!)) { flush('code'); mode = undefined; fence = undefined; }
      } else if (innerFence) {
        if (closesCodeFence(line, innerFence)) innerFence = undefined;
      } else if ((innerFence = openingCodeFence(line))) { /* fenced code inside a div is opaque to ::: fences */ }
      else if (/^:{3,}$/.test(trimmed)) { if (--depth === 0) { flush('div'); mode = undefined; } }
      else if (/^:{3,}\s*\S/.test(trimmed)) depth += 1;
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

/** Finds the block owning a source position, preferring the following block at boundaries and gaps. */
export function documentBlockAt(blocks: readonly DocumentBlock[], position: number): DocumentBlock | undefined {
  return blocks.find((block) => position >= block.from && position < block.to)
    ?? blocks.find((block) => block.from >= position)
    ?? blocks.at(-1);
}

/** Trims spaces, tabs and line terminators only; U+2028/U+2029 stay ordinary content. */
function trimLine(line: string): string { return line.replace(/^[ \t]+|[ \t\r\n]+$/g, ''); }

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
