import type { OperationContext, WorkspacePath } from '@markroot/core';
import type { ProjectWorkspace } from '@markroot/workspace';

export interface CitationRecord {
  readonly key: string;
  readonly type: string;
  readonly title?: string;
  readonly author?: string;
  readonly year?: string;
  readonly doi?: string;
  readonly source: WorkspacePath;
  readonly raw: string;
}

export interface CitationRequest { readonly kind: 'doi' | 'arxiv' | 'key'; readonly value: string }
export interface CitationResolution { readonly request: CitationRequest; readonly bibtex?: string; readonly warning?: string }

export interface CitationResolver {
  readonly id: string;
  resolve(request: CitationRequest, context?: OperationContext): Promise<CitationResolution>;
}

export interface CitationProvider {
  index(paths: readonly WorkspacePath[], context?: OperationContext): Promise<readonly CitationRecord[]>;
  search(query: string): readonly CitationRecord[];
  resolve(request: CitationRequest, context?: OperationContext): Promise<CitationResolution>;
}

export class LocalCitationProvider implements CitationProvider {
  private records: readonly CitationRecord[] = [];
  constructor(private readonly workspace: ProjectWorkspace, private readonly resolvers: readonly CitationResolver[] = []) {}

  async index(paths: readonly WorkspacePath[], context?: OperationContext): Promise<readonly CitationRecord[]> {
    const records: CitationRecord[] = [];
    for (const path of paths) records.push(...parseBibTeX(await this.workspace.readFile(path, context), path));
    this.records = Object.freeze(records.sort((a, b) => a.key.localeCompare(b.key)));
    return this.records;
  }

  search(query: string): readonly CitationRecord[] {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return this.records.slice(0, 50);
    return this.records.filter((record) => [record.key, record.title, record.author, record.year].some((value) => value?.toLocaleLowerCase().includes(normalized))).slice(0, 50);
  }

  async resolve(request: CitationRequest, context?: OperationContext): Promise<CitationResolution> {
    if (request.kind === 'key') {
      const found = this.records.find((record) => record.key === request.value);
      return found ? { request, bibtex: found.raw } : { request, warning: `Citation key not found: ${request.value}` };
    }
    for (const resolver of this.resolvers) {
      const result = await resolver.resolve(request, context);
      if (result.bibtex) return result;
    }
    return { request, warning: `No local resolver is configured for @${request.kind}:${request.value}.` };
  }
}

export function parseBibTeX(source: string, path: WorkspacePath): readonly CitationRecord[] {
  const records: CitationRecord[] = [];
  const start = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g;
  for (const match of source.matchAll(start)) {
    const from = match.index;
    let depth = 0;
    let quote = false;
    let to = source.length;
    for (let index = source.indexOf('{', from); index < source.length; index += 1) {
      const char = source[index];
      if (char === '"' && source[index - 1] !== '\\') quote = !quote;
      if (quote) continue;
      if (char === '{') depth += 1;
      if (char === '}' && --depth === 0) { to = index + 1; break; }
    }
    const raw = source.slice(from, to);
    const fields = parseBibFields(raw);
    const title = fields.get('title');
    const author = fields.get('author');
    const year = citationYear(fields);
    const doi = normalizeDoi(fields.get('doi'));
    records.push({
      key: match[2]!,
      type: match[1]!.toLowerCase(),
      ...(title ? { title } : {}),
      ...(author ? { author } : {}),
      ...(year ? { year } : {}),
      ...(doi ? { doi } : {}),
      source: path,
      raw,
    });
  }
  return records;
}

export function normalizeDoi(value?: string): string | undefined {
  const doi = value?.trim()
    .replace(/^doi:\s*/i, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .trim();
  return doi && /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi : undefined;
}

function parseBibFields(raw: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  let cursor = raw.indexOf(',') + 1;
  while (cursor > 0 && cursor < raw.length) {
    while (cursor < raw.length && /[\s,]/.test(raw[cursor]!)) cursor += 1;
    const keyMatch = /^[\w-]+/.exec(raw.slice(cursor));
    if (!keyMatch) break;
    const key = keyMatch[0].toLowerCase();
    cursor += keyMatch[0].length;
    while (/\s/.test(raw[cursor] ?? '')) cursor += 1;
    if (raw[cursor] !== '=') break;
    cursor += 1;
    while (/\s/.test(raw[cursor] ?? '')) cursor += 1;
    const parsed = parseBibValue(raw, cursor);
    if (!parsed) break;
    fields.set(key, parsed.value.replace(/\s+/g, ' ').trim());
    cursor = parsed.to;
  }
  return fields;
}

function parseBibValue(raw: string, from: number): { readonly value: string; readonly to: number } | undefined {
  const opener = raw[from];
  if (opener === '{') {
    let depth = 1;
    for (let index = from + 1; index < raw.length; index += 1) {
      if (raw[index] === '{') depth += 1;
      else if (raw[index] === '}' && --depth === 0) return { value: raw.slice(from + 1, index), to: index + 1 };
    }
    return undefined;
  }
  if (opener === '"') {
    for (let index = from + 1; index < raw.length; index += 1) {
      if (raw[index] === '"' && raw[index - 1] !== '\\') return { value: raw.slice(from + 1, index), to: index + 1 };
    }
    return undefined;
  }
  let to = from;
  while (to < raw.length && raw[to] !== ',' && raw[to] !== '}') to += 1;
  const value = raw.slice(from, to).trim();
  return value ? { value, to } : undefined;
}

function citationYear(fields: ReadonlyMap<string, string>): string | undefined {
  for (const key of ['year', 'date', 'issued', 'eventdate', 'urldate']) {
    const value = fields.get(key);
    const year = value?.match(/(?:^|\D)((?:1[5-9]|20|21)\d{2})(?:\D|$)/)?.[1];
    if (year) return year;
  }
  return undefined;
}
