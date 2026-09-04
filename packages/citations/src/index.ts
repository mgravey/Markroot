import type { OperationContext, WorkspacePath } from '@markroot/core';
import type { ProjectWorkspace } from '@markroot/workspace';

export interface CitationRecord {
  readonly key: string;
  readonly type: string;
  readonly title?: string;
  readonly author?: string;
  readonly year?: string;
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
    const fields = new Map<string, string>();
    for (const field of raw.matchAll(/(?:^|,)\s*([\w-]+)\s*=\s*(?:\{((?:[^{}]|\{[^{}]*\})*)\}|"([^"]*)")/gm)) {
      fields.set(field[1]!.toLowerCase(), (field[2] ?? field[3] ?? '').replace(/\s+/g, ' ').trim());
    }
    const title = fields.get('title');
    const author = fields.get('author');
    const year = fields.get('year');
    records.push({
      key: match[2]!,
      type: match[1]!.toLowerCase(),
      ...(title ? { title } : {}),
      ...(author ? { author } : {}),
      ...(year ? { year } : {}),
      source: path,
      raw,
    });
  }
  return records;
}
