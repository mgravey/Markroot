import type { OperationContext, WorkspacePath } from '@markroot/core';
import type { ProjectWorkspace } from '@markroot/workspace';

export interface CitationRecord {
  readonly key: string;
  readonly type: string;
  readonly title?: string;
  readonly author?: string;
  /** Parsed author list; brace-protected corporate names are kept whole as `literal`. */
  readonly authors?: readonly CitationName[];
  readonly year?: string;
  readonly doi?: string;
  readonly url?: string;
  readonly eprint?: string;
  readonly source: WorkspacePath;
  readonly raw: string;
}

export type CitationName = { readonly family: string; readonly given?: string } | { readonly literal: string };

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

const DISPLAY_FIELDS = new Set(['title', 'subtitle', 'author', 'editor', 'journal', 'journaltitle', 'booktitle', 'publisher', 'organization', 'institution', 'school', 'address', 'location', 'series', 'edition', 'note', 'abstract', 'keywords']);

export function parseBibTeX(source: string, path: WorkspacePath): readonly CitationRecord[] {
  const records: CitationRecord[] = [];
  const macros = new Map(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].map((month, index) => [month, String(index + 1)]));
  const start = /@\s*([A-Za-z]+)\s*([{(])/g;
  for (let match = start.exec(source); match; match = start.exec(source)) {
    const from = match.index;
    const type = match[1]!.toLowerCase();
    const open = match.index + match[0].length - 1;
    const to = entryEnd(source, open);
    start.lastIndex = to;
    if (type === 'comment' || type === 'preamble') continue;
    const raw = source.slice(from, to);
    const body = source.slice(open + 1, to > open + 1 && /[})]/.test(source[to - 1]!) ? to - 1 : to);
    if (type === 'string') {
      for (const [name, value] of parseBibFields(body, macros)) macros.set(name, value);
      continue;
    }
    const key = /^\s*([^,\s})]+)/.exec(body)?.[1];
    if (!key) continue;
    const comma = body.indexOf(',');
    const rawFields = comma < 0 ? new Map<string, string>() : parseBibFields(body.slice(comma + 1), macros);
    const fields = new Map([...rawFields].map(([name, value]) => [name, DISPLAY_FIELDS.has(name) ? decodeLatex(value) : trimOuterBraces(value)]));
    const title = fields.get('title');
    const author = fields.get('author');
    const authors = rawFields.has('author') ? parseNames(rawFields.get('author')!) : [];
    const year = citationYear(fields);
    const doi = normalizeDoi(fields.get('doi'));
    records.push({
      key,
      type,
      ...(title ? { title } : {}),
      ...(author ? { author } : {}),
      ...(authors.length ? { authors } : {}),
      ...(year ? { year } : {}),
      ...(doi ? { doi } : {}),
      ...(fields.get('url') ? { url: fields.get('url')! } : {}),
      ...(fields.get('eprint') ? { eprint: fields.get('eprint')! } : {}),
      source: path,
      raw,
    });
  }
  return records;
}

/** Remove protective outer grouping only; identifier punctuation and internal braces are literal. */
function trimOuterBraces(value: string): string {
  let result = value.trim();
  while (result.startsWith('{') && topLevelEnd(result) === result.length - 1) result = result.slice(1, -1).trim();
  return result;
}

/** Finds the end of an entry opened at `open`; quotes delimit values only at the entry's top brace level. */
function entryEnd(source: string, open: number): number {
  const close = source[open] === '(' ? ')' : '}';
  let depth = 0;
  let quote = false;
  for (let index = open + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') { if (depth > 0) depth -= 1; else if (close === '}') return index + 1; }
    else if (char === '"' && depth === 0 && source[index - 1] !== '\\') quote = !quote;
    else if (char === ')' && close === ')' && depth === 0 && !quote) return index + 1;
  }
  return source.length;
}

export function normalizeDoi(value?: string): string | undefined {
  const doi = value?.trim()
    .replace(/^doi:\s*/i, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .trim();
  return doi && /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi : undefined;
}

function parseBibFields(body: string, macros: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  let cursor = 0;
  while (cursor < body.length) {
    while (cursor < body.length && /[\s,]/.test(body[cursor]!)) cursor += 1;
    const keyMatch = /^[^\s=,{}()"#]+/.exec(body.slice(cursor));
    if (!keyMatch) break;
    const key = keyMatch[0].toLowerCase();
    cursor += keyMatch[0].length;
    while (/\s/.test(body[cursor] ?? '')) cursor += 1;
    if (body[cursor] !== '=') break;
    cursor += 1;
    let value = '';
    for (;;) {
      while (/\s/.test(body[cursor] ?? '')) cursor += 1;
      const parsed = parseBibValue(body, cursor, macros);
      if (!parsed) break;
      value += parsed.value;
      cursor = parsed.to;
      while (/\s/.test(body[cursor] ?? '')) cursor += 1;
      if (body[cursor] !== '#') break;
      cursor += 1;
    }
    fields.set(key, value.trim());
  }
  return fields;
}

function parseBibValue(raw: string, from: number, macros: ReadonlyMap<string, string>): { readonly value: string; readonly to: number } | undefined {
  const opener = raw[from];
  if (opener === '{' || opener === '"') {
    let depth = 0;
    for (let index = from + 1; index < raw.length; index += 1) {
      const char = raw[index];
      if (char === '{') depth += 1;
      else if (char === '}') { if (depth === 0) return opener === '{' ? { value: raw.slice(from + 1, index), to: index + 1 } : undefined; depth -= 1; }
      else if (char === '"' && opener === '"' && depth === 0 && raw[index - 1] !== '\\') return { value: raw.slice(from + 1, index), to: index + 1 };
    }
    return undefined;
  }
  const word = /^[^\s,#{}()"=]+/.exec(raw.slice(from))?.[0];
  if (!word) return undefined;
  return { value: /^\d+$/.test(word) ? word : macros.get(word.toLowerCase()) ?? word, to: from + word.length };
}

const COMBINING_ACCENTS: Readonly<Record<string, string>> = {
  '"': '\u0308', "'": '\u0301', '`': '\u0300', '^': '\u0302', '~': '\u0303', '=': '\u0304', '.': '\u0307',
  u: '\u0306', v: '\u030c', H: '\u030b', c: '\u0327', k: '\u0328', r: '\u030a', b: '\u0331', d: '\u0323', t: '\u0361',
};
const LATEX_LETTERS: Readonly<Record<string, string>> = { ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ' };

/** Decodes common LaTeX accents and symbols, then strips protective braces. */
export function decodeLatex(value: string): string {
  const base = (letter: string) => letter === '\\i' ? 'i' : letter === '\\j' ? 'j' : letter;
  return value
    .replace(/\\(["'`^~=.])\s*(?:\{\s*(\\[ij]|[A-Za-z])\s*\}|(\\[ij](?![A-Za-z])|[A-Za-z]))/g, (_whole, accent: string, braced?: string, bare?: string) => `${base(braced ?? bare!)}${COMBINING_ACCENTS[accent]}`.normalize('NFC'))
    .replace(/\\([uvHckrbdt])(?:\s*\{\s*(\\[ij]|[A-Za-z])\s*\}|\s+(\\[ij](?![A-Za-z])|[A-Za-z]))/g, (_whole, accent: string, braced?: string, bare?: string) => `${base(braced ?? bare!)}${COMBINING_ACCENTS[accent]}`.normalize('NFC'))
    .replace(/\\(ss|ae|AE|oe|OE|aa|AA|o|O|l|L|i|j)(?![A-Za-z])(?:\{\}|\s)?/g, (_whole, name: string) => LATEX_LETTERS[name]!)
    .replace(/\\[A-Za-z]+\*?\s*/g, '')
    .replace(/\\([&%$#_{}])/g, (_whole, symbol: string) => `\u0000${symbol === '{' ? 'L' : symbol === '}' ? 'R' : symbol}`)
    .replace(/(?<!\\)[{}]/g, '')
    .replace(/\u0000([LR]|.)/g, (_whole, symbol: string) => symbol === 'L' ? '{' : symbol === 'R' ? '}' : symbol)
    .replace(/---/g, '\u2014').replace(/--/g, '\u2013').replace(/(?<!\\)~/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Splits a BibTeX name list on top-level `and`; a name wholly wrapped in braces is a literal (corporate) name. */
function parseNames(raw: string): readonly CitationName[] {
  const names: string[] = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === '{') depth += 1;
    else if (raw[index] === '}') depth -= 1;
    else if (depth === 0) {
      const separator = /^\s+and\s+/i.exec(raw.slice(index));
      if (separator) { names.push(raw.slice(from, index)); index += separator[0].length - 1; from = index + 1; }
    }
  }
  names.push(raw.slice(from));
  return names.map((name) => name.trim()).filter(Boolean).map((name): CitationName => {
    if (/^\{[^]*\}$/.test(name) && topLevelEnd(name) === name.length - 1) return { literal: decodeLatex(name) };
    const comma = topLevelIndex(name, ',');
    if (comma >= 0) {
      const given = decodeLatex(name.slice(comma + 1));
      return { family: decodeLatex(name.slice(0, comma)), ...(given ? { given } : {}) };
    }
    const words = topLevelWords(name);
    const given = decodeLatex(words.slice(0, -1).join(' '));
    return { family: decodeLatex(words.at(-1) ?? name), ...(given ? { given } : {}) };
  });
}

function topLevelEnd(value: string): number {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '{') depth += 1;
    else if (value[index] === '}' && --depth === 0) return index;
  }
  return -1;
}

function topLevelIndex(value: string, needle: string): number {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '{') depth += 1;
    else if (value[index] === '}') depth -= 1;
    else if (depth === 0 && value[index] === needle) return index;
  }
  return -1;
}

function topLevelWords(value: string): string[] {
  const words: string[] = [];
  let depth = 0;
  let word = '';
  for (const char of value) {
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    if (depth === 0 && /\s/.test(char)) { if (word) words.push(word); word = ''; } else word += char;
  }
  if (word) words.push(word);
  return words;
}

function citationYear(fields: ReadonlyMap<string, string>): string | undefined {
  for (const key of ['year', 'date', 'issued', 'eventdate', 'urldate']) {
    const value = fields.get(key);
    const year = value?.match(/(?:^|\D)((?:1[5-9]|20|21)\d{2})(?:\D|$)/)?.[1];
    if (year) return year;
  }
  return undefined;
}
