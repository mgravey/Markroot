import MarkdownIt from 'markdown-it';
import katex from 'katex';
import { stripCommentMarkup } from '@markroot/comments';
import { MarkrootError, throwIfAborted, type OperationContext } from '@markroot/core';
import type { DocumentSnapshot } from '@markroot/document';

export interface RenderDependency { readonly path: string; readonly content: string | Blob }
export interface RenderCitation { readonly key: string; readonly title?: string; readonly author?: string; readonly year?: string }
export interface RenderRequest { readonly snapshot: DocumentSnapshot; readonly dependencies?: readonly RenderDependency[]; readonly citations?: readonly RenderCitation[]; readonly allowRemoteResources?: boolean }
export interface RenderArtifact {
  readonly revision: number;
  readonly html: string;
  readonly warnings: readonly string[];
  readonly anchors: readonly { id: string; from: number; to: number }[];
  readonly engine: string;
  readonly objectUrls?: readonly string[];
}

export interface DocumentEngine {
  readonly id: string;
  render(request: RenderRequest, context?: OperationContext): Promise<RenderArtifact>;
}

const markdown = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: false });

export class BasicDocumentEngine implements DocumentEngine {
  readonly id = 'markroot-basic';
  async render(request: RenderRequest, context?: OperationContext): Promise<RenderArtifact> {
    throwIfAborted(context);
    const clean = stripCommentMarkup(request.snapshot.source);
    const blocks = request.snapshot.blocks;
    const resources = createResourceUrls(request.dependencies ?? []);
    const citationMap = new Map((request.citations ?? []).map((citation) => [citation.key, citation]));
    const state: ScholarlyState = { figure: 0, equation: 0, citations: new Set(), crossrefs: buildCrossReferences(clean) };
    const html = blocks
      .filter((block) => block.kind !== 'frontmatter')
      .map((block) => `<section class="mr-block mr-${block.kind}" data-block-id="${block.id}" data-source-from="${block.from}" data-source-to="${block.to}">${renderBlock(block.kind, stripCommentMarkup(block.text), block.from, citationMap, resources.urls, state)}</section>`)
      .join('\n') + renderReferences(state.citations, citationMap);
    return {
      revision: request.snapshot.revision,
      html,
      warnings: [
        ...(request.snapshot.path.endsWith('.qmd') ? findExecutableWarnings(clean) : []),
        ...findMissingImageWarnings(clean, request.dependencies ?? []),
      ],
      anchors: blocks.map(({ id, from, to }) => ({ id, from, to })),
      engine: this.id,
      objectUrls: resources.objectUrls,
    };
  }
}

export class PandocDocumentEngine implements DocumentEngine {
  readonly id = 'pandoc-wasm';
  async render(request: RenderRequest, context?: OperationContext): Promise<RenderArtifact> {
    throwIfAborted(context);
    try {
      const { convert } = await import('pandoc-wasm');
      const files = Object.fromEntries((request.dependencies ?? []).map((file) => [file.path, file.content]));
      const clean = stripCommentMarkup(request.snapshot.source);
      const result = await convert({ from: 'markdown+fenced_divs+tex_math_dollars', to: 'html5', citeproc: true, standalone: false }, clean, files);
      throwIfAborted(context);
      return {
        revision: request.snapshot.revision,
        html: typeof result.stdout === 'string' ? result.stdout : '',
        warnings: [...result.warnings.map((warning: unknown) => typeof warning === 'string' ? warning : JSON.stringify(warning)), ...findExecutableWarnings(clean)],
        anchors: request.snapshot.blocks.map(({ id, from, to }) => ({ id, from, to })),
        engine: this.id,
      };
    } catch (cause) {
      throw new MarkrootError('RENDER_ERROR', 'Pandoc could not render this document.', undefined, { cause });
    }
  }
}

interface ScholarlyState { figure: number; equation: number; citations: Set<string>; crossrefs: ReadonlyMap<string, string> }

function renderBlock(kind: string, source: string, blockFrom: number, citations: ReadonlyMap<string, RenderCitation>, resources: ReadonlyMap<string, string>, state: ScholarlyState): string {
  if (kind === 'div') {
    const layout = /^:::\s*\{[^}]*layout-ncol\s*=\s*([2-4])[^}]*\}\s*\n([\s\S]*?)\n:::\s*$/m.exec(source.trim());
    if (layout) return `<div class="figure-layout layout-cols-${layout[1]}">${renderScholarlyMarkdown(layout[2]!, blockFrom + source.indexOf(layout[2]!), citations, resources, state)}</div>`;
    const match = /^:::\s*\{?\.?callout-([\w-]+)[^\n]*\}?\s*\n([\s\S]*?)\n:::\s*$/m.exec(source.trim());
    if (match) return `<aside class="callout callout-${escapeAttribute(match[1]!)}">${renderScholarlyMarkdown(match[2]!, blockFrom + source.indexOf(match[2]!), citations, resources, state)}</aside>`;
  }
  return renderScholarlyMarkdown(source, blockFrom, citations, resources, state);
}

function renderScholarlyMarkdown(source: string, blockFrom: number, citations: ReadonlyMap<string, RenderCitation>, resources: ReadonlyMap<string, string>, state: ScholarlyState): string {
  const replacements: string[] = [];
  const token = (html: string): string => {
    const key = `MRROOTTOKEN${replacements.length}END`;
    replacements.push(html);
    return key;
  };
  const pattern = /!\[((?:[^\[\]]|\[[^\]]*\])*)\]\((<[^>]+>|[^\s)>]+)(?:\s+["']([^"']*)["'])?\)\s*(?:\{([^}]*)\})?|\$\$([\s\S]+?)\$\$\s*(?:\{#([\w:.-]+)\})?|(?<!\\)\$(?!\$)([^$\n]+?)(?<!\\)\$|\[([^\]]*@[A-Za-z0-9_:.+-]+[^\]]*)\]|(^|[\s(])@([A-Za-z0-9_:.+-]*[A-Za-z0-9_:+-])/gm;
  let prepared = '';
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    prepared += source.slice(cursor, match.index);
    const offset = blockFrom + match.index;
    if (match[1] !== undefined) {
      if (!match[1] && !match[4]) prepared += match[0];
      else {
        state.figure += 1;
        const attributes = parsePandocAttributes(match[4]);
        const caption = renderCaptionInline(match[1], offset + 2, citations, state);
        const title = match[3] ? `title="${escapeHtml(match[3])}"` : '';
        const alignment = figureAlignment(attributes.values.get('fig-align'));
        const captionLocation = attributes.values.get('fig-cap-location') === 'top' ? 'top' : 'bottom';
        const figureClass = alignment ? ` class="figure-align-${alignment}"` : '';
        const imageAttributes = [
          `src="${escapeHtml(unwrapReference(match[2]!))}"`,
          `alt="${escapeHtml(attributes.values.get('fig-alt') ?? stripInlineMarkup(match[1]))}"`,
          title,
          safeCssLength(attributes.values.get('width')) ? `data-figure-width="${escapeHtml(attributes.values.get('width')!)}"` : '',
          safeCssLength(attributes.values.get('height')) ? `data-figure-height="${escapeHtml(attributes.values.get('height')!)}"` : '',
        ].filter(Boolean).join(' ');
        const image = `<img ${imageAttributes}>`;
        const figureCaption = `<figcaption><span class="figure-label">Figure ${state.figure}.</span>${caption ? ` ${caption}` : ''}</figcaption>`;
        const content = captionLocation === 'top' ? `${figureCaption}${image}` : `${image}${figureCaption}`;
        prepared += token(`<figure${attributes.id ? ` id="${escapeAttribute(attributes.id)}"` : ''}${figureClass} data-source-offset="${offset}" data-caption-location="${captionLocation}">${content}</figure>`);
      }
    } else if (match[5] !== undefined) {
      state.equation += 1;
      prepared += token(`<span class="math-display"${match[6] ? ` id="${escapeAttribute(match[6])}"` : ''} data-source-offset="${offset}">${renderMath(match[5].trim(), true)}<span class="equation-number">(${state.equation})</span></span>`);
    } else if (match[7] !== undefined) {
      prepared += token(`<span class="math-inline" data-source-offset="${offset}">${renderMath(match[7], false)}</span>`);
    } else if (match[8] !== undefined) {
      const keys = [...match[8].matchAll(/@([A-Za-z0-9_:.+-]+)/g)].map((item) => item[1]!);
      keys.forEach((key) => state.citations.add(key));
      const labels = keys.map((key) => citationLabel(citations.get(key), key, false));
      const title = keys.map((key) => citations.get(key)?.title).filter(Boolean).join('; ');
      prepared += token(`<span class="citation" data-source-offset="${offset}"${title ? ` title="${escapeHtml(title)}"` : ''}>(${labels.map((label, index) => `<a href="#ref-${escapeAttribute(keys[index]!)}">${label}</a>`).join('; ')})</span>`);
    } else {
      const prefix = match[9] ?? '';
      const key = match[10]!;
      const citation = citations.get(key);
      const crossref = state.crossrefs.get(key);
      if (!citation && crossref) prepared += `${prefix}${token(`<a class="crossref" href="#${escapeAttribute(key)}" data-source-offset="${offset + prefix.length}">${escapeHtml(crossref)}</a>`)}`;
      else if (!citation) prepared += match[0];
      else {
        state.citations.add(key);
        prepared += `${prefix}${token(`<span class="citation citation-text" data-source-offset="${offset + prefix.length}" title="${escapeHtml(citation.title ?? key)}"><a href="#ref-${escapeAttribute(key)}">${citationLabel(citation, key, true)}</a></span>`)}`;
      }
    }
    cursor = match.index + match[0].length;
  }
  prepared += source.slice(cursor);
  let html = markdown.render(prepared);
  replacements.forEach((replacement, index) => { html = html.replaceAll(`MRROOTTOKEN${index}END`, replacement); });
  html = html
    .replace(/<p>\s*(<figure[\s\S]*?<\/figure>)\s*<\/p>/g, '$1')
    .replace(/<p>\s*(<span class="math-display"[\s\S]*?<\/span>)\s*<\/p>/g, '$1');
  html = renderHeadingIdentifiers(replaceResourceUrls(html, resources));
  return renderFigures(html, state);
}

function renderCaptionInline(source: string, sourceFrom: number, citations: ReadonlyMap<string, RenderCitation>, state: ScholarlyState): string {
  const replacements: string[] = [];
  const prepared = source.replace(/\[([^\]]*@[A-Za-z0-9_:.+-]+[^\]]*)\]|(?<!\\)\$(?!\$)([^$\n]+?)(?<!\\)\$/g, (whole, citationBody: string | undefined, mathBody: string | undefined, offset: number) => {
    const key = `MRROOTCAPTION${replacements.length}END`;
    if (mathBody !== undefined) replacements.push(`<span class="math-inline" data-source-offset="${sourceFrom + offset}">${renderMath(mathBody, false)}</span>`);
    else {
      const keys = [...citationBody!.matchAll(/@([A-Za-z0-9_:.+-]+)/g)].map((item) => item[1]!);
      keys.forEach((citationKey) => state.citations.add(citationKey));
      replacements.push(`<span class="citation" data-source-offset="${sourceFrom + offset}">(${keys.map((citationKey) => `<a href="#ref-${escapeAttribute(citationKey)}">${citationLabel(citations.get(citationKey), citationKey, false)}</a>`).join('; ')})</span>`);
    }
    return key;
  });
  let html = markdown.renderInline(prepared);
  replacements.forEach((replacement, index) => { html = html.replaceAll(`MRROOTCAPTION${index}END`, replacement); });
  return html;
}

function renderMath(expression: string, displayMode: boolean): string {
  return katex.renderToString(expression, { displayMode, output: 'mathml', throwOnError: false, strict: 'ignore' });
}

function renderFigures(html: string, state: ScholarlyState): string {
  return html.replace(/<p>\s*(<img\s+[^>]*alt="([^"]*)"[^>]*>)\s*(?:\{#([\w:.-]+)[^}]*\})?\s*<\/p>/g, (whole, image: string, caption: string, id: string | undefined) => {
    if (!caption && !id) return whole;
    state.figure += 1;
    return `<figure${id ? ` id="${escapeAttribute(id)}"` : ''}>${image}<figcaption><span class="figure-label">Figure ${state.figure}.</span> ${caption}</figcaption></figure>`;
  });
}

function createResourceUrls(dependencies: readonly RenderDependency[]): { urls: ReadonlyMap<string, string>; objectUrls: readonly string[] } {
  const urls = new Map<string, string>();
  const objectUrls: string[] = [];
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return { urls, objectUrls };
  for (const dependency of dependencies) {
    const blob = dependency.content instanceof Blob ? dependency.content : new Blob([dependency.content]);
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    const path = dependency.path.replace(/^\.\//, '');
    urls.set(path, url);
    urls.set(encodeURI(path), url);
  }
  return { urls, objectUrls };
}

function replaceResourceUrls(html: string, resources: ReadonlyMap<string, string>): string {
  return html.replace(/<img\b([^>]*?)\bsrc="([^"]+)"([^>]*)>/g, (whole, before: string, path: string, after: string) => {
    const local = resources.get(path.replace(/^\.\//, ''));
    if (local) return `<img${before}src="${local}" data-image-source="${escapeHtml(path)}"${after}>`;
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(path)) return whole;
    const alt = /\balt="([^"]*)"/.exec(whole)?.[1] ?? '';
    return `<span class="image-missing" role="img" aria-label="Image unavailable: ${escapeHtml(alt || path)}"><strong>Image unavailable</strong><code>${escapeHtml(path)}</code></span>`;
  });
}

function renderReferences(keys: ReadonlySet<string>, citations: ReadonlyMap<string, RenderCitation>): string {
  const entries = [...keys].map((key) => citations.get(key)).filter((citation): citation is RenderCitation => Boolean(citation));
  if (!entries.length) return '';
  return `<section class="references" aria-label="References"><h2>References</h2><ol>${entries.map((citation) => `<li id="ref-${escapeAttribute(citation.key)}">${escapeHtml(referenceLabel(citation))}</li>`).join('')}</ol></section>`;
}

function buildCrossReferences(source: string): ReadonlyMap<string, string> {
  const references = new Map<string, string>();
  let figure = 0;
  for (const match of source.matchAll(/!\[((?:[^\[\]]|\[[^\]]*\])*)\]\((?:<[^>]+>|[^\s)>]+)(?:\s+["'][^"']*["'])?\)\s*(?:\{([^}]*)\})?/g)) {
    figure += 1;
    const id = parsePandocAttributes(match[2]).id;
    if (id?.startsWith('fig-')) references.set(id, `Figure ${figure}`);
  }
  let equation = 0;
  for (const match of source.matchAll(/\$\$[\s\S]+?\$\$\s*(?:\{#(eq-[\w:.-]+)\})?/g)) {
    equation += 1;
    if (match[1]) references.set(match[1], `Equation ${equation}`);
  }
  for (const match of source.matchAll(/^#{1,6}\s+.+?\s*\{#(sec-[\w:.-]+)\}\s*$/gm)) references.set(match[1]!, 'Section');
  return references;
}

function renderHeadingIdentifiers(html: string): string {
  return html.replace(/<(h[1-6])>([\s\S]*?)\s*\{#([\w:.-]+)\}<\/h[1-6]>/g, (_whole, tag: string, content: string, id: string) => `<${tag} id="${escapeAttribute(id)}">${content}</${tag}>`);
}

function citationLabel(citation: RenderCitation | undefined, key: string, textual: boolean): string {
  if (!citation) return escapeHtml(key);
  const author = shortAuthor(citation.author) || key;
  const year = citation.year || 'n.d.';
  return textual ? `${escapeHtml(author)} (${escapeHtml(year)})` : `${escapeHtml(author)}, ${escapeHtml(year)}`;
}

function referenceLabel(citation: RenderCitation): string {
  return [citation.author, citation.year ? `(${citation.year}).` : undefined, citation.title].filter(Boolean).join(' ');
}

function shortAuthor(author?: string): string {
  if (!author) return '';
  const authors = author.split(/\s+and\s+/i).map((entry) => entry.trim()).filter(Boolean);
  const surname = (entry: string) => entry.includes(',') ? entry.split(',')[0]!.trim() : entry.split(/\s+/).at(-1)!;
  if (authors.length > 2) return `${surname(authors[0]!)} et al.`;
  return authors.map(surname).join(' & ');
}

function stripInlineMarkup(value: string): string { return value.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim(); }
function unwrapReference(value: string): string { return value.replace(/^<([\s\S]*)>$/, '$1'); }

interface PandocAttributes { readonly id?: string; readonly classes: readonly string[]; readonly values: ReadonlyMap<string, string> }

function parsePandocAttributes(source?: string): PandocAttributes {
  let id: string | undefined;
  const classes: string[] = [];
  const values = new Map<string, string>();
  if (source) {
    const pattern = /(?:^|\s)(#[\w:.-]+|\.[\w:-]+|([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))/g;
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

function escapeAttribute(value: string): string { return value.replace(/[^a-z0-9_-]/gi, ''); }
function escapeHtml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
