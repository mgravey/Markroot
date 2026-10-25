import MarkdownIt from 'markdown-it';
import katex from 'katex';
import { stripCommentMarkup } from '@markroot/comments';
import { throwIfAborted, type OperationContext } from '@markroot/core';
import { closesCodeFence, mapDocumentBlocks, splitLines, type DocumentBlockKind, type DocumentSnapshot } from '@markroot/document';

export interface RenderDependency { readonly path: string; readonly content: string | Blob; /** Borrowed URL; the caller owns its lifetime. */ readonly objectUrl?: string }
export type RenderCitationName = { readonly family: string; readonly given?: string } | { readonly literal: string };
export interface RenderCitation { readonly key: string; readonly title?: string; readonly author?: string; readonly authors?: readonly RenderCitationName[]; readonly year?: string; readonly doi?: string }
/** `allowRemoteResources` must be `true` for remote http(s) images to keep their `src`; otherwise they become placeholders. */
export interface RenderRequest { readonly snapshot: DocumentSnapshot; readonly dependencies?: readonly RenderDependency[]; readonly citations?: readonly RenderCitation[]; readonly allowRemoteResources?: boolean }
export interface DocumentOutlineItem {
  readonly id: string;
  readonly blockId: string;
  readonly from: number;
  readonly kind: 'section' | 'figure' | 'table';
  readonly label: string;
  readonly level?: number;
  readonly number?: string;
}
export interface RenderArtifact {
  readonly revision: number;
  readonly html: string;
  readonly warnings: readonly string[];
  readonly anchors: readonly { id: string; from: number; to: number }[];
  readonly engine: string;
  readonly objectUrls?: readonly string[];
  readonly outline?: readonly DocumentOutlineItem[];
}

export interface DocumentEngine {
  readonly id: string;
  render(request: RenderRequest, context?: OperationContext): Promise<RenderArtifact>;
}

const markdown = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: false });
const REFERENCES_PLACEHOLDER = '<div data-markroot-references-placeholder="true"></div>';
const RENDER_CACHE_LIMIT = 4000;

type OutlineDraft = Omit<DocumentOutlineItem, 'blockId'>;
interface Counters { readonly figure: number; readonly table: number; readonly equation: number; readonly sections: readonly number[] }
/** A block rendered at source offset 0, plus every side effect needed to replay it against the document state. */
interface BlockRender {
  readonly html: string;
  readonly outline: readonly OutlineDraft[];
  readonly citations: readonly string[];
  readonly ids: readonly (readonly [base: string, id: string])[];
  readonly labels: readonly (readonly [id: string, label: string])[];
  readonly after: Counters;
}

interface ScholarlyState {
  figure: number;
  table: number;
  equation: number;
  sections: number[];
  readonly numberSections: boolean;
  readonly usedIds: Set<string>;
  citations: string[];
  outline: OutlineDraft[];
  ids: [string, string][];
  labels: [string, string][];
}

interface RenderContext { readonly citations: ReadonlyMap<string, RenderCitation>; readonly state: ScholarlyState; readonly nested?: boolean }

const citationGenerations = new WeakMap<readonly RenderCitation[], number>();
let nextCitationGeneration = 1;

export class BasicDocumentEngine implements DocumentEngine {
  readonly id = 'markroot-basic';
  private readonly cache = new Map<string, BlockRender>();

  async render(request: RenderRequest, context?: OperationContext): Promise<RenderArtifact> {
    throwIfAborted(context);
    const renderSource = maskMarkdownHtmlComments(stripCommentMarkup(request.snapshot.source));
    const blocks = request.snapshot.blocks;
    const citationList = request.citations ?? [];
    const citationMap = new Map(citationList.map((citation) => [citation.key, citation]));
    if (!citationGenerations.has(citationList)) citationGenerations.set(citationList, nextCitationGeneration++);
    const citationGeneration = citationGenerations.get(citationList)!;
    const frontmatter = blocks.find((block) => block.kind === 'frontmatter');
    const state: ScholarlyState = {
      figure: 0, table: 0, equation: 0, sections: [0, 0, 0, 0, 0, 0],
      numberSections: frontMatterBoolean(frontmatter?.text ?? '', 'number-sections') !== false,
      usedIds: new Set(), citations: [], outline: [], ids: [], labels: [],
    };
    const citations = new Set<string>();
    const outline: DocumentOutlineItem[] = [];
    const labels = new Map<string, string>();
    const sections: string[] = [];
    let lastYield = Date.now();
    for (const block of blocks) {
      if (block.kind === 'frontmatter') continue;
      if (Date.now() - lastYield > 12) { await new Promise((resolve) => setTimeout(resolve, 0)); lastYield = Date.now(); }
      throwIfAborted(context);
      const blockSource = stripCommentMarkup(block.text);
      const renderable = block.kind === 'code' ? blockSource : maskMarkdownHtmlComments(blockSource);
      const rendered = this.renderCached(block.kind, renderable, citationGeneration, citationMap, state);
      rendered.citations.forEach((key) => citations.add(key));
      rendered.outline.forEach((item) => outline.push({ ...item, blockId: block.id, from: item.from + block.from }));
      rendered.labels.forEach(([id, label]) => { if (!labels.has(id)) labels.set(id, label); });
      sections.push(`<section class="mr-block mr-${block.kind}" data-block-id="${block.id}" data-source-from="${block.from}" data-source-to="${block.to}">${shiftSourceOffsets(rendered.html, block.from)}</section>`);
    }
    const bodyHtml = resolveCrossReferences(sections.join('\n'), labels);
    const explicitReferences = bodyHtml.includes(REFERENCES_PLACEHOLDER);
    const references = renderReferences(citations, citationMap, explicitReferences);
    let placed = false;
    const html = explicitReferences
      ? bodyHtml.replaceAll(REFERENCES_PLACEHOLDER, () => placed ? '' : (placed = true, references))
      : bodyHtml + references;
    const resources = createResourceUrls(request.dependencies ?? []);
    return {
      revision: request.snapshot.revision,
      html: replaceResourceUrls(html, resources.urls, request.allowRemoteResources === true),
      warnings: [
        ...(request.snapshot.path.endsWith('.qmd') ? findExecutableWarnings(renderSource) : []),
        ...findMissingImageWarnings(renderSource, request.dependencies ?? []),
      ],
      anchors: blocks.map(({ id, from, to }) => ({ id, from, to })),
      engine: this.id,
      objectUrls: resources.objectUrls,
      outline,
    };
  }

  /** Renders one block, reusing a cached result when its text and the numbering state it observes are unchanged. */
  private renderCached(kind: DocumentBlockKind, source: string, citationGeneration: number, citations: ReadonlyMap<string, RenderCitation>, state: ScholarlyState): BlockRender {
    const key = `${kind}\u0000${state.numberSections ? 1 : 0}:${state.figure}:${state.table}:${state.equation}:${state.sections.join('.')}:${citationGeneration}\u0000${source}`;
    let entry = this.cache.get(key);
    if (entry && identifiersStillResolve(entry.ids, state.usedIds)) {
      this.cache.delete(key);
      entry.ids.forEach(([, id]) => state.usedIds.add(id));
    } else {
      Object.assign(state, { citations: [], outline: [], ids: [], labels: [] });
      const html = renderBlock(kind, source, 0, { citations, state });
      entry = { html, outline: state.outline, citations: state.citations, ids: state.ids, labels: state.labels, after: { figure: state.figure, table: state.table, equation: state.equation, sections: [...state.sections] } };
    }
    this.cache.set(key, entry);
    if (this.cache.size > RENDER_CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
    Object.assign(state, { figure: entry.after.figure, table: entry.after.table, equation: entry.after.equation, sections: [...entry.after.sections] });
    return entry;
  }
}

function identifiersStillResolve(ids: BlockRender['ids'], used: ReadonlySet<string>): boolean {
  const trial = new Set<string>();
  return ids.every(([base, id]) => {
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate) || trial.has(candidate)) candidate = `${base}-${suffix++}`;
    trial.add(candidate);
    return candidate === id;
  });
}

function shiftSourceOffsets(html: string, from: number): string {
  return from ? html.replace(/ data-source-offset="(\d+)"/g, (_whole, offset: string) => ` data-source-offset="${Number(offset) + from}"`) : html;
}

/** Cross-references are resolved after all blocks render, from the numbers the renderer actually assigned. */
function resolveCrossReferences(html: string, labels: ReadonlyMap<string, string>): string {
  return html.replace(/<a class="crossref" data-xref="([^"]*)" data-source-offset="(\d+)"><\/a>/g, (_whole, encoded: string, offset: string) => {
    const key = decodeURIComponent(encoded);
    const label = labels.get(key);
    return label ? `<a class="crossref" href="#${escapeAttribute(key)}" data-source-offset="${offset}">${escapeHtml(label)}</a>` : escapeHtml(`@${key}`);
  });
}

/**
 * Replaces Markdown HTML comments with whitespace while preserving length and
 * line endings. Literal comment syntax inside inline or fenced code is kept.
 */
export function maskMarkdownHtmlComments(source: string): string {
  const lines = splitLines(source);
  let fence: { marker: '`' | '~'; length: number } | undefined;
  let inlineTicks = 0;
  let inComment = false;
  let output = '';

  for (const line of lines) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!inComment && inlineTicks === 0 && fence) {
      output += line;
      if (closesCodeFence(line, fence)) fence = undefined;
      continue;
    }
    if (!inComment && inlineTicks === 0 && fenceMatch?.[1]) {
      fence = { marker: fenceMatch[1][0] as '`' | '~', length: fenceMatch[1].length };
      output += line;
      continue;
    }

    for (let index = 0; index < line.length;) {
      if (inComment) {
        if (line.startsWith('-->', index)) {
          output += '   ';
          index += 3;
          inComment = false;
        } else {
          const character = line[index]!;
          output += character === '\n' || character === '\r' ? character : ' ';
          index += 1;
        }
        continue;
      }
      if (line[index] === '`') {
        let end = index + 1;
        while (line[end] === '`') end += 1;
        const run = end - index;
        if (inlineTicks === 0) inlineTicks = run;
        else if (run === inlineTicks) inlineTicks = 0;
        output += line.slice(index, end);
        index = end;
        continue;
      }
      if (inlineTicks === 0 && line.startsWith('<!--', index)) {
        output += '    ';
        index += 4;
        inComment = true;
        continue;
      }
      output += line[index]!;
      index += 1;
    }
  }
  return output;
}

const CODE_OR_LINK = String.raw`(?<!\x60)(?<ticks>\x60+)(?!\x60)[\s\S]*?(?<!\x60)\k<ticks>(?!\x60)|<[A-Za-z][A-Za-z0-9+.\-]{1,31}:[^\s<>]*>|\]\((?:<[^>\n]*>|[^\s()<>]*(?:\([^\s()<>]*\)[^\s()<>]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)|^ {0,3}\[[^\]\n]+\]:[ \t]*\S+|\b(?:https?|ftp):\/\/[^\s<>]+`;
const CITATION_KEY = String.raw`[\p{L}\p{N}_](?:[\p{L}\p{N}_:.#%&+?~\/\-]*[\p{L}\p{N}_])?`;
const IMAGE = String.raw`!\[(?<alt>(?:[^\[\]]|\[[^\]]*\])*)\]\((?<src><[^>]+>|[^\s)>]+)(?:\s+["'](?<title>[^"']*)["'])?\)\s*(?:\{(?<attrs>[^}]*)\})?`;
const DISPLAY_MATH = String.raw`\$\$(?<display>[\s\S]+?)\$\$(?:\s*\{#(?<eqid>[\p{L}\p{N}_:.\-]+)\})?`;
/** Pandoc tex_math_dollars: no space after the opening or before the closing `$`, and no digit right after it. */
const INLINE_MATH = String.raw`(?<![\\$])\$(?![\s$])(?<math>[^$\n]*?[^\s\\$])\$(?!\d)`;
/** A bracketed citation needs a word-initial `@key`; `[..](url)` and `[..][ref]` are links, not citations. */
const BRACKET_CITATION = String.raw`\[(?<cites>[^\[\]]*?(?<![\p{L}\p{N}_])@${CITATION_KEY}[^\[\]]*)\](?![(\[])`;
const TEXT_CITATION = String.raw`(?<![\p{L}\p{N}_\\@])@(?<key>${CITATION_KEY})`;
/** Code spans, autolinks and link destinations come first so they are copied verbatim instead of being scanned. */
const SCHOLARLY_PATTERN = new RegExp(`${CODE_OR_LINK}|${IMAGE}|${DISPLAY_MATH}|${INLINE_MATH}|${BRACKET_CITATION}|${TEXT_CITATION}`, 'gmu');
const CAPTION_PATTERN = new RegExp(`${CODE_OR_LINK}|${INLINE_MATH}|${BRACKET_CITATION}`, 'gmu');
const CITATION_KEYS = new RegExp(String.raw`(?<![\p{L}\p{N}_])@(${CITATION_KEY})`, 'gu');
const CROSSREF_PREFIX = /^(?:fig|tbl|eq|sec)-/;

interface Token { readonly html: string; readonly raw: string }

/**
 * Substitutes placeholder tokens in text content only. Inside tags (attribute values)
 * and code elements a token is restored as its escaped source text.
 */
function restoreTokens(html: string, tokens: readonly Token[]): string {
  const raw = (value: string) => value.replace(/\ue000(\d+)\ue001/g, (marker, index: string) => tokens[Number(index)] ? escapeHtml(tokens[Number(index)]!.raw) : marker);
  return html.replace(/<(code|pre)\b[^>]*>[\s\S]*?<\/\1>|<[^>]*>|\ue000(\d+)\ue001/g, (whole, _tag: string | undefined, index: string | undefined) => index !== undefined ? tokens[Number(index)]?.html ?? whole : raw(whole));
}

function renderBlock(kind: string, source: string, from: number, context: RenderContext): string {
  if (kind === 'code') return markdown.render(source);
  if (kind === 'heading' && !context.nested) return renderHeading(source, from, context);
  if (kind === 'table') return renderTableBlock(source, from, context);
  if (kind === 'div') return renderDiv(source, from, context);
  return renderScholarlyMarkdown(source, from, context);
}

/** Renders a fenced div's body as nested blocks so code, tables and inner divs keep their own rules. */
function renderDiv(source: string, from: number, context: RenderContext): string {
  if (isReferencesPlaceholder(source)) return REFERENCES_PLACEHOLDER;
  const lines = splitLines(source);
  const opening = lines[0] ?? '';
  const closed = lines.length > 1 && /^[ \t]*:{3,}[ \t]*\r?\n?$/.test(lines.at(-1)!);
  const body = lines.slice(1, closed ? -1 : undefined).join('');
  const header = /^[ \t]*:{3,}[ \t]*(?:\{([^}]*)\}|([^\s{}:]+))?/.exec(opening);
  const attributes = parsePandocAttributes(header?.[1] ?? (header?.[2] ? `.${header[2]}` : undefined));
  const content = mapDocumentBlocks(body, { frontmatter: false })
    .map((block) => renderBlock(block.kind, block.text, from + opening.length + block.from, { ...context, nested: true }))
    .join('');
  const columns = attributes.values.get('layout-ncol');
  if (columns && /^[2-4]$/.test(columns)) return `<div class="figure-layout layout-cols-${columns}">${content}</div>`;
  const callout = attributes.classes.find((name) => name.startsWith('callout-'));
  if (callout) return `<aside class="callout ${escapeAttribute(callout)}">${content}</aside>`;
  const id = attributes.id ? ` id="${escapeAttribute(uniqueIdentifier(attributes.id, context.state))}"` : '';
  const classes = attributes.classes.length ? ` class="${escapeAttribute(attributes.classes.join(' '))}"` : '';
  return `<div${id}${classes}>${content}</div>`;
}

function renderScholarlyMarkdown(source: string, blockFrom: number, context: RenderContext): string {
  const { citations, state } = context;
  const tokens: Token[] = [];
  const token = (html: string, raw: string): string => `\ue000${tokens.push({ html, raw }) - 1}\ue001`;
  let prepared = '';
  let cursor = 0;
  for (const match of source.matchAll(SCHOLARLY_PATTERN)) {
    prepared += source.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const groups = match.groups!;
    const offset = blockFrom + match.index;
    if (groups.alt !== undefined) {
      if (!groups.alt && !groups.attrs) { prepared += match[0]; continue; }
      state.figure += 1;
      const attributes = parsePandocAttributes(groups.attrs);
      const figureId = uniqueIdentifier(attributes.id ?? `mr-figure-${state.figure}`, state);
      if (attributes.id && CROSSREF_PREFIX.test(attributes.id)) state.labels.push([figureId, `Figure ${state.figure}`]);
      const figureLabel = stripInlineMarkup(groups.alt) || `Figure ${state.figure}`;
      state.outline.push({ id: figureId, from: offset, kind: 'figure', label: figureLabel, number: String(state.figure) });
      const caption = renderCaptionInline(groups.alt, offset + 2, context);
      const title = groups.title ? `title="${escapeHtml(groups.title)}"` : '';
      const alignment = figureAlignment(attributes.values.get('fig-align'));
      const captionLocation = attributes.values.get('fig-cap-location') === 'top' ? 'top' : 'bottom';
      const figureClass = alignment ? ` class="figure-align-${alignment}"` : '';
      const imageAttributes = [
        `src="${escapeHtml(unwrapReference(groups.src!))}"`,
        `alt="${escapeHtml(attributes.values.get('fig-alt') ?? stripInlineMarkup(groups.alt))}"`,
        title,
        safeCssLength(attributes.values.get('width')) ? `data-figure-width="${escapeHtml(attributes.values.get('width')!)}"` : '',
        safeCssLength(attributes.values.get('height')) ? `data-figure-height="${escapeHtml(attributes.values.get('height')!)}"` : '',
      ].filter(Boolean).join(' ');
      const image = `<img ${imageAttributes}>`;
      const figureCaption = `<figcaption><span class="figure-label">Figure ${state.figure}.</span>${caption ? ` ${caption}` : ''}</figcaption>`;
      const content = captionLocation === 'top' ? `${figureCaption}${image}` : `${image}${figureCaption}`;
      prepared += token(`<figure id="${escapeAttribute(figureId)}"${figureClass} data-source-offset="${offset}" data-caption-location="${captionLocation}">${content}</figure>`, match[0]);
    } else if (groups.display !== undefined) {
      state.equation += 1;
      const id = groups.eqid ? uniqueIdentifier(groups.eqid, state) : undefined;
      if (id && CROSSREF_PREFIX.test(groups.eqid!)) state.labels.push([id, `Equation ${state.equation}`]);
      prepared += token(`<span class="math-display"${id ? ` id="${escapeAttribute(id)}"` : ''} data-source-offset="${offset}">${renderMath(groups.display.trim(), true)}<span class="equation-number">(${state.equation})</span></span>`, match[0]);
    } else if (groups.math !== undefined) {
      prepared += token(`<span class="math-inline" data-source-offset="${offset}">${renderMath(groups.math, false)}</span>`, match[0]);
    } else if (groups.cites !== undefined) {
      prepared += token(renderBracketCitation(groups.cites, offset, context, true), match[0]);
    } else if (groups.key !== undefined) {
      const key = groups.key;
      const citation = citations.get(key);
      if (citation) {
        state.citations.push(key);
        prepared += token(`<span class="citation citation-text" data-source-offset="${offset}" title="${escapeHtml(citation.title ?? key)}">${citationAnchor(citation, key, citationLabel(citation, key, true))}</span>`, match[0]);
      } else if (CROSSREF_PREFIX.test(key)) prepared += token(`<a class="crossref" data-xref="${encodeURIComponent(key)}" data-source-offset="${offset}"></a>`, match[0]);
      else prepared += match[0];
    } else prepared += match[0];
  }
  prepared += source.slice(cursor);
  let html = restoreTokens(markdown.render(prepared), tokens);
  html = html
    .replace(/<p>\s*(<figure[\s\S]*?<\/figure>)\s*<\/p>/g, '$1')
    .replace(/<p>\s*(<span class="math-display"[\s\S]*?<\/span>)\s*<\/p>/g, '$1');
  return renderFigures(renderHeadingIdentifiers(html), blockFrom, state);
}

function renderBracketCitation(body: string, offset: number, context: RenderContext, withTitle: boolean): string {
  const { citations, state } = context;
  const keys = [...body.matchAll(CITATION_KEYS)].map((item) => item[1]!);
  state.citations.push(...keys);
  const labels = keys.map((key) => citationAnchor(citations.get(key), key, citationLabel(citations.get(key), key, false)));
  const title = withTitle ? keys.map((key) => citations.get(key)?.title).filter(Boolean).join('; ') : '';
  return `<span class="citation" data-source-offset="${offset}"${title ? ` title="${escapeHtml(title)}"` : ''}>(${labels.join('; ')})</span>`;
}

function renderCaptionInline(source: string, sourceFrom: number, context: RenderContext): string {
  const tokens: Token[] = [];
  const prepared = source.replace(CAPTION_PATTERN, (whole: string, ...args: unknown[]) => {
    const groups = args.at(-1) as Record<string, string | undefined>;
    const offset = args.at(-3) as number;
    const html = groups.math !== undefined
      ? `<span class="math-inline" data-source-offset="${sourceFrom + offset}">${renderMath(groups.math, false)}</span>`
      : groups.cites !== undefined ? renderBracketCitation(groups.cites, sourceFrom + offset, context, false) : undefined;
    return html === undefined ? whole : `\ue000${tokens.push({ html, raw: whole }) - 1}\ue001`;
  });
  return restoreTokens(markdown.renderInline(prepared), tokens);
}

function renderMath(expression: string, displayMode: boolean): string {
  return katex.renderToString(expression, { displayMode, output: 'mathml', throwOnError: false, strict: 'ignore' });
}

function renderHeading(source: string, blockFrom: number, context: RenderContext): string {
  const { state } = context;
  const match = /^\s*(#{1,6})\s+([\s\S]*?)\s*$/.exec(source);
  if (!match) return renderScholarlyMarkdown(source, blockFrom, context);
  const level = match[1]!.length;
  const attributeMatch = /\s+\{([^{}]*)\}\s*$/.exec(match[2]!);
  const attributes = parsePandocAttributes(attributeMatch?.[1]);
  const headingSource = attributeMatch ? match[2]!.slice(0, attributeMatch.index).trimEnd() : match[2]!.trimEnd();
  const label = stripInlineMarkup(headingSource);
  const id = uniqueIdentifier(attributes.id ?? (slugify(label) || 'mr-section'), state);
  const unnumbered = attributes.classes.includes('unnumbered');
  let number: string | undefined;
  if (state.numberSections && !unnumbered) {
    state.sections[level - 1] = (state.sections[level - 1] ?? 0) + 1;
    for (let index = level; index < state.sections.length; index += 1) state.sections[index] = 0;
    number = state.sections.slice(0, level).filter((value) => value > 0).join('.');
  }
  if (attributes.id && CROSSREF_PREFIX.test(attributes.id)) state.labels.push([id, number ? `Section ${number}` : 'Section']);
  state.outline.push({ id, from: blockFrom, kind: 'section', label, level, ...(number ? { number } : {}) });
  const classes = unnumbered ? ' class="unnumbered"' : '';
  const numberHtml = number ? `<span class="section-number">${number}</span> ` : '';
  return `<h${level} id="${escapeAttribute(id)}"${classes} data-source-offset="${blockFrom}">${numberHtml}${renderCaptionInline(headingSource, blockFrom + source.indexOf(headingSource), context)}</h${level}>`;
}

function renderTableBlock(source: string, blockFrom: number, context: RenderContext): string {
  const { state } = context;
  const lines = source.trimEnd().split(/\r\n|\r|\n/);
  const last = lines.at(-1) ?? '';
  const captionMatch = /^\s*(?::|Table:)\s*(.*?)(?:\s+\{([^{}]*)\})?\s*$/i.exec(last);
  const tableSource = captionMatch ? lines.slice(0, -1).join('\n') : source;
  let tableHtml = markdown.render(tableSource);
  if (!/<table\b/i.test(tableHtml)) return renderScholarlyMarkdown(source, blockFrom, context);
  state.table += 1;
  const attributes = parsePandocAttributes(captionMatch?.[2]);
  const tableId = uniqueIdentifier(attributes.id ?? `mr-table-${state.table}`, state);
  if (attributes.id && CROSSREF_PREFIX.test(attributes.id)) state.labels.push([tableId, `Table ${state.table}`]);
  const captionSource = captionMatch?.[1]?.trim() ?? '';
  const fallbackLabel = tableHeaderLabel(lines[0] ?? '') || `Table ${state.table}`;
  const label = stripInlineMarkup(captionSource) || fallbackLabel;
  state.outline.push({ id: tableId, from: blockFrom, kind: 'table', label, number: String(state.table) });
  const caption = captionSource ? ` ${renderCaptionInline(captionSource, blockFrom + source.lastIndexOf(captionSource), context)}` : '';
  tableHtml = tableHtml.trim();
  return `<figure class="table-figure" id="${escapeAttribute(tableId)}" data-source-offset="${blockFrom}"><figcaption><span class="table-label">Table ${state.table}.</span>${caption}</figcaption><div class="table-scroll">${tableHtml}</div></figure>`;
}

function renderFigures(html: string, blockFrom: number, state: ScholarlyState): string {
  return html.replace(/<p>\s*(<img\s+[^>]*alt="([^"]*)"[^>]*>)\s*(?:\{#([\p{L}\p{N}_:.\-]+)[^}]*\})?\s*<\/p>/gu, (whole, image: string, caption: string, id: string | undefined) => {
    if (!caption && !id) return whole;
    state.figure += 1;
    const figureId = uniqueIdentifier(id ?? `mr-figure-${state.figure}`, state);
    if (id && CROSSREF_PREFIX.test(id)) state.labels.push([figureId, `Figure ${state.figure}`]);
    state.outline.push({ id: figureId, from: blockFrom, kind: 'figure', label: stripInlineMarkup(caption) || `Figure ${state.figure}`, number: String(state.figure) });
    return `<figure id="${escapeAttribute(figureId)}" data-source-offset="${blockFrom}">${image}<figcaption><span class="figure-label">Figure ${state.figure}.</span> ${caption}</figcaption></figure>`;
  });
}

function createResourceUrls(dependencies: readonly RenderDependency[]): { urls: ReadonlyMap<string, string>; objectUrls: readonly string[] } {
  const urls = new Map<string, string>();
  const objectUrls: string[] = [];
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return { urls, objectUrls };
  for (const dependency of dependencies) {
    const blob = dependency.content instanceof Blob ? dependency.content : new Blob([dependency.content]);
    const url = dependency.objectUrl ?? URL.createObjectURL(blob);
    objectUrls.push(url);
    const path = dependency.path.replace(/^\.\//, '');
    urls.set(path, url);
    urls.set(encodeURI(path), url);
  }
  return { urls, objectUrls };
}

/** Maps local images to object URLs, flags missing ones and, unless allowed, blocks remote images without fetching them. */
function replaceResourceUrls(html: string, resources: ReadonlyMap<string, string>, allowRemoteResources: boolean): string {
  return html.replace(/<img\b([^>]*?)\bsrc="([^"]+)"([^>]*)>/g, (whole, before: string, path: string, after: string) => {
    const local = resources.get(path.replace(/^\.\//, ''));
    if (local) return `<img${before}src="${local}" data-image-source="${escapeHtml(path)}"${after}>`;
    const alt = /\balt="([^"]*)"/.exec(whole)?.[1] ?? '';
    if (/^(?:https?:)?\/\//i.test(path)) {
      return allowRemoteResources ? whole : `<span class="remote-resource-placeholder" role="img" data-remote-resource-blocked="true" aria-label="${alt ? `Remote image blocked: ${alt}` : 'Remote image blocked'}">${alt ? `Remote image blocked: ${alt}` : 'Remote image blocked'}</span>`;
    }
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(path)) return whole;
    return `<span class="image-missing" role="img" aria-label="Image unavailable: ${escapeHtml(alt || path)}"><strong>Image unavailable</strong><code>${escapeHtml(path)}</code></span>`;
  });
}

function renderReferences(keys: ReadonlySet<string>, citations: ReadonlyMap<string, RenderCitation>, explicitPlacement = false): string {
  const entries = [...keys].map((key) => citations.get(key)).filter((citation): citation is RenderCitation => Boolean(citation));
  if (!entries.length) return '';
  const list = `<ol>${entries.map((citation) => {
    const url = doiUrl(citation.doi);
    return `<li id="ref-${escapeAttribute(citation.key)}">${escapeHtml(referenceLabel(citation))}${url ? ` <a class="doi-link" href="${escapeHtml(url)}">https://doi.org/${escapeHtml(citation.doi!)}</a>` : ''}</li>`;
  }).join('')}</ol>`;
  return explicitPlacement
    ? `<div class="references references-explicit" id="refs" aria-label="References">${list}</div>`
    : `<section class="references" aria-label="References"><h2>References</h2>${list}</section>`;
}

function isReferencesPlaceholder(source: string): boolean {
  const lines = source.trim().split(/\r\n|\r|\n/);
  const opening = /^:{3,}\s*\{([^}]*)\}\s*$/.exec(lines[0] ?? '');
  const closing = /^:{3,}\s*$/.test(lines.at(-1) ?? '');
  return Boolean(opening && closing && lines.length >= 2 && parsePandocAttributes(opening[1]).id === 'refs' && !lines.slice(1, -1).join('\n').trim());
}

function renderHeadingIdentifiers(html: string): string {
  return html.replace(/<(h[1-6])>([\s\S]*?)\s*\{#([\p{L}\p{N}_:.\-]+)\}<\/h[1-6]>/gu, (_whole, tag: string, content: string, id: string) => `<${tag} id="${escapeAttribute(id)}">${content}</${tag}>`);
}

function citationLabel(citation: RenderCitation | undefined, key: string, textual: boolean): string {
  if (!citation) return escapeHtml(key);
  const author = shortAuthor(citation) || key;
  const year = citation.year || 'n.d.';
  return textual ? `${escapeHtml(author)} (${escapeHtml(year)})` : `${escapeHtml(author)}, ${escapeHtml(year)}`;
}

function citationAnchor(citation: RenderCitation | undefined, key: string, label: string): string {
  const url = doiUrl(citation?.doi);
  const doiAttributes = url ? ` data-doi-url="${escapeHtml(url)}" title="Ctrl/Cmd-click to open DOI in a new tab"` : '';
  return `<a href="#ref-${escapeAttribute(key)}"${doiAttributes}>${label}</a>`;
}

export function doiUrl(doi?: string): string | undefined {
  const normalized = doi?.trim().replace(/^doi:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  if (!normalized || !/^10\.\d{4,9}\/\S+$/i.test(normalized)) return undefined;
  const url = new URL('https://doi.org/');
  url.pathname = `/${normalized}`;
  return url.href;
}

function referenceLabel(citation: RenderCitation): string {
  return [citation.author, citation.year ? `(${citation.year}).` : undefined, citation.title].filter(Boolean).join(' ');
}

/** Structured names (corporate `literal` names stay whole) take precedence over splitting the display string. */
function shortAuthor(citation: RenderCitation): string {
  const surname = (entry: string) => entry.includes(',') ? entry.split(',')[0]!.trim() : entry.split(/\s+/).at(-1)!;
  const names = citation.authors?.length
    ? citation.authors.map((name) => 'literal' in name ? name.literal : name.family)
    : (citation.author ?? '').split(/\s+and\s+/i).map((entry) => entry.trim()).filter(Boolean).map(surname);
  if (names.length > 2) return `${names[0]} et al.`;
  return names.join(' & ');
}

function stripInlineMarkup(value: string): string { return value.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim(); }
function unwrapReference(value: string): string { return value.replace(/^<([\s\S]*)>$/, '$1'); }

interface PandocAttributes { readonly id?: string; readonly classes: readonly string[]; readonly values: ReadonlyMap<string, string> }

function parsePandocAttributes(source?: string): PandocAttributes {
  let id: string | undefined;
  const classes: string[] = [];
  const values = new Map<string, string>();
  if (source) {
    const pattern = /(?:^|\s)(#[\p{L}\p{N}_:.\-]+|\.[\p{L}\p{N}_:\-]+|([\p{L}\p{N}_:\-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))/gu;
    for (const match of source.matchAll(pattern)) {
      const token = match[1]!;
      if (token.startsWith('#')) id = token.slice(1);
      else if (token.startsWith('.')) classes.push(token.slice(1));
      else if (match[2]) values.set(match[2], match[3] ?? match[4] ?? match[5] ?? '');
    }
  }
  return { ...(id ? { id } : {}), classes, values };
}

function figureAlignment(value?: string): 'left' | 'center' | 'right' | undefined {
  return value === 'left' || value === 'center' || value === 'right' ? value : undefined;
}

function safeCssLength(value?: string): boolean { return Boolean(value && /^(?:auto|\d+(?:\.\d+)?(?:%|px|em|rem|vw|vh)?)$/i.test(value)); }

/** Claims a document-unique id (escaped only when written) and records the claim for render-cache replay. */
function uniqueIdentifier(preferred: string, state: ScholarlyState): string {
  const base = preferred.replace(/\s+/g, '-') || 'markroot-item';
  let candidate = base;
  let suffix = 2;
  while (state.usedIds.has(candidate)) candidate = `${base}-${suffix++}`;
  state.usedIds.add(candidate);
  state.ids.push([base, candidate]);
  return candidate;
}

function slugify(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
}

function tableHeaderLabel(line: string): string {
  return line.split('|').map((cell) => stripInlineMarkup(cell)).filter(Boolean).slice(0, 3).join(' / ');
}

function frontMatterBoolean(source: string, key: string): boolean | undefined {
  const frontMatter = /^---\s*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(source)?.[1];
  if (!frontMatter) return undefined;
  const value = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(true|false)\\s*$`, 'im').exec(frontMatter)?.[1];
  return value ? value.toLowerCase() === 'true' : undefined;
}

function findMissingImageWarnings(source: string, dependencies: readonly RenderDependency[]): readonly string[] {
  const available = new Set(dependencies.map((dependency) => dependency.path.replace(/^\.\//, '')));
  const missing = new Set<string>();
  for (const match of source.matchAll(/!\[(?:[^\[\]]|\[[^\]]*\])*\]\((<[^>]+>|[^\s)>]+)(?:\s+["'][^"']*["'])?\)/g)) {
    const reference = unwrapReference(match[1]!);
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(reference) || available.has(reference.replace(/^\.\//, ''))) continue;
    missing.add(reference);
  }
  return [...missing].map((reference) => `Local image not found: ${reference}`);
}

function findExecutableWarnings(source: string): readonly string[] {
  return /```\{(?:python|r|julia|ojs|bash|sh|node|javascript)\b/i.test(source)
    ? ['Code cells are shown as source and are never executed in Markroot.']
    : [];
}

function escapeAttribute(value: string): string { return escapeHtml(value).replaceAll("'", '&#39;'); }
function escapeHtml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
