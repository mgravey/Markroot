import { parseDocument, visit } from 'yaml';
import { relativeWorkspaceReference, resolveWorkspaceReference, workspacePath, type WorkspacePath } from '@markroot/core';
import { closesCodeFence, mapDocumentBlocks, openingCodeFence, splitLines, type DocumentBlock, type DocumentSnapshot } from '@markroot/document';

/** Shared by the preview renderer and app resource collector; paths never escape the selected workspace. */
export interface DocumentResourceReference { readonly reference: string; readonly path: WorkspacePath }
type Options = Readonly<Record<string, unknown>>;
export interface QuartoDocument {
  readonly path: WorkspacePath;
  readonly defaults: Options;
  readonly rootDir: string;
  readonly workspacePaths: readonly string[];
  readonly captions: ReadonlyMap<string, string>;
  readonly numberSections: boolean;
}
export interface StaticChunk {
  readonly language: string;
  readonly code: string;
  readonly options: Options;
  readonly label?: string;
  readonly caption?: string;
  readonly computedCaption: boolean;
  readonly image?: DocumentResourceReference;
}
const IMAGE_EXTENSIONS = ['png', 'svg', 'jpg', 'jpeg', 'gif', 'webp', 'pdf'];
export const IMAGE_REFERENCE = /!\[(?:[^\[\]]|\[[^\]]*\])*\]\((<[^>]+>|[^\s)>]+)(?:\s+["'][^"']*["'])?\)/g;
const R_STRING = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g;

function object(value: unknown): Options { return value && typeof value === 'object' && !Array.isArray(value) ? value as Options : {}; }
function yaml(source: string): Options {
  try {
    const document = parseDocument(source, { customTags: [{ tag: '!expr', resolve: (expression: string) => ({ expression }) }] });
    visit(document, { Scalar(_key, node) {
      if (node.tag === '!expr' && (node.type === 'QUOTE_DOUBLE' || node.type === 'QUOTE_SINGLE')) node.value = { literal: object(node.value).expression };
    } });
    return document.errors.length ? {} : object(document.toJS({ maxAliasCount: 50 }));
  } catch { return {}; }
}
function normalized(options: Options): Options {
  return Object.fromEntries(Object.entries(options).map(([key, value]) => [key.replaceAll('.', '-'), value]));
}
function optionValue(value: string): unknown {
  const trimmed = value.trim();
  if (/^(?:TRUE|T)$/i.test(trimmed)) return true;
  if (/^(?:FALSE|F)$/i.test(trimmed)) return false;
  if (/^["']/.test(trimmed)) return decodeRString(trimmed);
  return trimmed;
}

/** Header arguments are split outside quoted strings and nested calls; no expression is evaluated. */
function headerOptions(source: string): Options {
  const parts: string[] = [];
  let quote = '', depth = 0, start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) { if (char === '\\') index += 1; else if (char === quote) quote = ''; }
    else if (char === '"' || char === "'") quote = char;
    else if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === ',' && depth === 0) { parts.push(source.slice(start, index)); start = index + 1; }
  }
  parts.push(source.slice(start));
  const result: Record<string, unknown> = {};
  for (const part of parts) {
    const arg = /^\s*([\w.-]+)\s*=\s*([\s\S]*)$/.exec(part);
    if (arg) {
      const key = arg[1]!.replaceAll('.', '-');
      result[key] = key === 'fig-cap' && !/^[\"']/.test(arg[2]!.trim()) ? { expression: arg[2]!.trim() } : optionValue(arg[2]!);
    }
    else if (part.trim() && !result.label) result.label = optionValue(part);
  }
  return result;
}

export function staticChunk(source: string, document: QuartoDocument): StaticChunk | undefined {
  const lines = splitLines(source);
  const header = /^[ \t]*(?:`{3,}|~{3,})\{([\w+-]+)([\s\S]*?)\}\s*$/.exec((lines[0] ?? '').trimEnd());
  if (!header) return undefined;
  const fence = openingCodeFence(lines[0]!)!;
  const body = lines.slice(1, closesCodeFence(lines.at(-1) ?? '', fence) ? -1 : undefined);
  const optionLines: string[] = [];
  let count = 0;
  for (const line of body) {
    const comment = /^\s*(?:#|\/\/|--|;|%)\| ?([^\r\n]*)/.exec(line);
    if (comment) { optionLines.push(comment[1]!); count += 1; }
    else if (!line.trim()) { optionLines.push(''); count += 1; }
    else break;
  }
  const options = { ...document.defaults, ...headerOptions(header[2]!), ...normalized(yaml(optionLines.join('\n'))) };
  const label = typeof options.label === 'string' ? options.label : undefined;
  const code = body.slice(count).join('');
  const rawCaption = options['fig-cap'];
  const expression = object(rawCaption).expression;
  const literal = object(rawCaption).literal;
  const caption = typeof expression === 'string'
    ? literalExpression(expression, document.captions)
    : typeof literal === 'string' ? literal : typeof rawCaption === 'string' ? rawCaption : undefined;
  const image = label?.startsWith('fig-') ? resolveChunkImage(code, document) : undefined;
  return { language: header[1]!.toLowerCase(), code, options, computedCaption: typeof expression === 'string' && caption === undefined, ...(label ? { label } : {}), ...(caption !== undefined ? { caption } : {}), ...(image ? { image } : {}) };
}

export function prepareQuartoDocument(snapshot: DocumentSnapshot, workspacePaths: readonly string[]): QuartoDocument {
  const frontmatter = snapshot.blocks.find((block) => block.kind === 'frontmatter')?.text ?? '';
  const metadata = yaml(splitLines(frontmatter).slice(1, -1).join(''));
  const knitr = object(metadata.knitr);
  const defaults = { ...normalized(object(knitr.opts_chunk)), ...normalized(object(metadata.execute)) };
  const root = object(knitr.opts_knit)['root.dir'];
  const rootDir = typeof root === 'string' ? root : '.';
  const captions = new Map<string, string>();
  const formatNumbering = Object.values(object(metadata.format)).map((format) => object(format)['number-sections']).find((value) => typeof value === 'boolean');
  const base = { path: snapshot.path, defaults, rootDir, workspacePaths, captions, numberSections: (metadata['number-sections'] ?? formatNumbering) !== false };
  for (const block of codeBlocks(snapshot.blocks)) {
    const chunk = staticChunk(block.text, base);
    if (chunk?.language !== 'r') continue;
    // Strings/comments are opaque so an assignment-looking substring in either cannot become a caption.
    const assignments = new RegExp(`#[^\\r\\n]*|${R_STRING.source}|(?:^|[;\\r\\n])\\s*([A-Za-z.][\\w.]*)\\s*(?:<-|=(?!=))\\s*(?:(sprintf)\\s*\\(\\s*)?(${R_STRING.source})`, 'g');
    for (const match of chunk.code.matchAll(assignments)) {
      if (!match[1]) continue;
      if (!match[2] && !/^[ \t]*(?:[;#\r\n]|$)/.test(chunk.code.slice(match.index + match[0].length))) continue;
      const value = decodeRString(match[3]!);
      captions.set(match[1], match[2] ? value.replace(/%%|%(?:\d+\$)?[-+ #0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[a-zA-Z]/g, (specifier) => specifier === '%%' ? '%' : '…') : value);
    }
  }
  return base;
}

/** Cache the resolved chunk inputs, not the entire workspace listing on every block. */
export function chunkCacheKey(source: string, document: QuartoDocument): string {
  const chunk = staticChunk(source, document);
  return JSON.stringify(chunk ?? [...codeBlocks(mapDocumentBlocks(source, { frontmatter: false }))].map((block) => staticChunk(block.text, document)));
}

function divBlocks(source: string): readonly DocumentBlock[] {
  const lines = splitLines(source);
  const closed = lines.length > 1 && /^[ \t]*:{3,}[ \t]*\r?\n?$/.test(lines.at(-1)!);
  return mapDocumentBlocks(lines.slice(1, closed ? -1 : undefined).join(''), { frontmatter: false });
}
function* codeBlocks(blocks: readonly DocumentBlock[]): Generator<DocumentBlock> {
  for (const block of blocks) {
    if (block.kind === 'code') yield block;
    else if (block.kind === 'div') yield* codeBlocks(divBlocks(block.text));
  }
}
function literalExpression(expression: string, captions: ReadonlyMap<string, string>): string | undefined {
  const trimmed = expression.trim();
  if (/^[A-Za-z.][\w.]*$/.test(trimmed)) return captions.get(trimmed);
  const literal = new RegExp(`^(?:${R_STRING.source})$`).exec(trimmed);
  return literal ? decodeRString(trimmed) : undefined;
}
/** Only R string escapes are decoded, never arbitrary R syntax or functions. */
function decodeRString(literal: string): string {
  return literal.slice(1, -1).replace(/\\(?:u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|U([\da-fA-F]{8})|x([\da-fA-F]{2})|([\s\S]))/g, (_whole, brace: string | undefined, unicode: string | undefined, long: string | undefined, hex: string | undefined, char: string | undefined) => {
    const code = brace ?? unicode ?? long ?? hex;
    if (code) { const point = Number.parseInt(code, 16); return point <= 0x10ffff ? String.fromCodePoint(point) : '�'; }
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', a: '\x07' } as Record<string, string>)[char!] ?? char!;
  });
}

function codeStrings(code: string): readonly string[] {
  // Strip comments outside strings; strings in comments must never select a figure.
  return [...code.matchAll(new RegExp(`${R_STRING.source}|#[^\\r\\n]*|//[^\\r\\n]*`, 'g'))].filter((match) => /^["']/.test(match[0])).map((match) => decodeRString(match[0]));
}
function resolveChunkImage(code: string, document: QuartoDocument): DocumentResourceReference | undefined {
  const strings = codeStrings(code);
  const literals = [...strings];
  // Recognize only file.path with literal arguments. Dynamic calls remain unresolved.
  for (const match of code.matchAll(new RegExp(`${R_STRING.source}|#[^\\r\\n]*|//[^\\r\\n]*|\\bfile\\.path\\s*\\(([^()]*)\\)`, 'g'))) {
    if (match[1] === undefined) continue;
    const args = match[1];
    if (new RegExp(`^\\s*(?:${R_STRING.source})(?:\\s*,\\s*(?:${R_STRING.source}))*\\s*$`).test(args)) literals.unshift(codeStrings(args).join('/'));
  }
  const paths: WorkspacePath[] = [];
  for (const path of document.workspacePaths) {
    if (!/\.(?:png|svg|jpe?g|gif|webp|pdf)$/i.test(path)) continue;
    try { paths.push(workspacePath(path)); } catch { /* ignore invalid workspace entries */ }
  }
  for (const literal of literals) {
    if (!literal || /^(?:[a-z][\w+.-]*:|\/|#)/i.test(literal)) continue;
    const variants = /\.[^/]+$/.test(literal) ? [literal] : IMAGE_EXTENSIONS.map((extension) => `${literal}.${extension}`);
    for (const base of ['.', document.rootDir, '/']) {
      for (const variant of variants) {
        try {
          const path = base === '/' ? resolveWorkspaceReference(document.path, `/${variant}`) : resolveWorkspaceReference(document.path, `${base}/${variant}`);
          if (paths.includes(path)) return { path, reference: relativeWorkspaceReference(document.path, path) };
        } catch { /* escaping the selected workspace is never allowed */ }
      }
    }
    const stem = literal.split('/').at(-1)!.replace(/\.[^.]+$/, '');
    let matches = paths.filter((path) => path.split('/').at(-1)!.replace(/\.[^.]+$/, '') === stem);
    if (matches.some((path) => /(?:^|\/)(?:figures|fig|images)\//i.test(path))) matches = matches.filter((path) => /(?:^|\/)(?:figures|fig|images)\//i.test(path));
    if (matches.length) {
      const distance = (path: WorkspacePath) => relativeWorkspaceReference(document.path, path).split('/').length;
      const nearest = Math.min(...matches.map(distance));
      matches = matches.filter((path) => distance(path) === nearest);
      // Prefer the same deterministic extension order for multiple formats of one image.
      const stems = new Set(matches.map((path) => path.replace(/\.[^.]+$/, '')));
      if (stems.size === 1) {
        matches.sort((a, b) => IMAGE_EXTENSIONS.indexOf(a.split('.').at(-1)!.toLowerCase()) - IMAGE_EXTENSIONS.indexOf(b.split('.').at(-1)!.toLowerCase()));
        const path = matches[0]!;
        return { path, reference: relativeWorkspaceReference(document.path, path) };
      }
    }
  }
  return undefined;
}
export function documentResourceReferences(snapshot: DocumentSnapshot, workspacePaths: readonly string[] = []): readonly DocumentResourceReference[] {
  const document = prepareQuartoDocument(snapshot, workspacePaths);
  const references = new Map<string, DocumentResourceReference>();
  const visit = (blocks: readonly DocumentBlock[]) => {
    for (const block of blocks) {
      if (block.kind === 'frontmatter') continue;
      if (block.kind === 'div') { visit(divBlocks(block.text)); continue; }
      if (block.kind === 'code') {
        const chunk = staticChunk(block.text, document);
        if (chunk?.options.include !== false && chunk?.options.eval !== false && chunk?.options.output !== false && chunk?.options.results !== 'hide' && chunk?.image) references.set(chunk.image.reference, chunk.image);
        continue;
      }
      for (const match of block.text.matchAll(IMAGE_REFERENCE)) {
        const reference = match[1]!.replace(/^<([\s\S]*)>$/, '$1');
        if (/^(?:[a-z][\w+.-]*:|#|\/\/)/i.test(reference)) continue;
        try { references.set(reference, { reference, path: resolveWorkspaceReference(snapshot.path, reference) }); } catch { /* invalid local path */ }
      }
    }
  };
  visit(snapshot.blocks);
  return [...references.values()];
}
