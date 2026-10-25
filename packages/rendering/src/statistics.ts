import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { closesCodeFence, documentBlockAt, mapDocumentBlocks, openingCodeFence, splitLines, type CodeFence, type DocumentSnapshot } from '@markroot/document';
import type { SourceRange } from '@markroot/core';
import type { RenderCitation } from './index.js';
import { citationTextLabel } from './citation-label.js';
import { maskMarkdownHtmlComments } from './markdown-comments.js';

export interface TextStatistics { readonly words: number; readonly characters: number; readonly charactersWithoutSpaces: number }
export interface SectionStatistics { readonly label: string; readonly from: number; readonly blockId: string; readonly words: number }
export interface DocumentStatistics {
  readonly textOnly: TextStatistics;
  readonly includingCitations: TextStatistics;
  readonly paragraphs: number;
  readonly sentences: number;
  readonly headings: number;
  readonly figures: number;
  readonly tables: number;
  readonly equations: number;
  readonly citations: number;
  readonly uniqueCitationKeys: readonly string[];
  readonly crossReferences: number;
  readonly footnotes: number;
  readonly sections: readonly SectionStatistics[];
}
export interface StatisticsOptions {
  readonly includeCaptions?: boolean;
  readonly citations?: readonly RenderCitation[];
  /** Offsets into the complete source keep excluded code/metadata excluded in selections too. */
  readonly selection?: SourceRange;
}
interface Piece { text: string; cited: string; wordText: string; citedWordText: string }
interface BlockStatistics {
  textOnly: TextStatistics; includingCitations: TextStatistics; paragraphs: number; sentences: number;
  headings: number; figures: number; tables: number; equations: number; citations: string[]; crossReferences: number; footnotes: string[];
  heading?: { label: string; offset: number };
}
const markdown = new MarkdownIt({ html: true, linkify: true, typographer: true });
// Math is opaque to Markdown emphasis, escapes, and citation scanning.
markdown.inline.ruler.before('escape', 'statistics_math', (state, silent) => {
  const rest = state.src.slice(state.pos);
  if (rest.startsWith('\\@')) {
    if (!silent) { const token = state.push('statistics_literal', '', 0); token.content = '@'; }
    state.pos += 2; return true;
  }
  const opener = rest.startsWith('$$') ? '$$' : rest.startsWith('\\(') ? '\\(' : rest.startsWith('\\[') ? '\\[' : rest.startsWith('$') && !/^\$\s/.test(rest) ? '$' : undefined;
  if (!opener) return false;
  const closer = opener === '\\(' ? '\\)' : opener === '\\[' ? '\\]' : opener;
  const end = state.src.indexOf(closer, state.pos + opener.length);
  if (end < 0 || state.src[end - 1] === '\\' || (opener === '$' && /\s/.test(state.src[end - 1]!))) return false;
  if (!silent) state.push('statistics_math', '', 0);
  state.pos = end + closer.length;
  return true;
});
markdown.block.ruler.before('fence', 'statistics_display_math', (state, start, end, silent) => {
  const first = state.src.slice(state.bMarks[start]! + state.tShift[start]!, state.eMarks[start]);
  const opener = first.startsWith('$$') ? '$$' : first.startsWith('\\[') ? '\\[' : undefined;
  if (!opener) return false;
  const closer = opener === '$$' ? '$$' : '\\]';
  let last = start;
  if (!first.slice(opener.length).includes(closer)) {
    for (last = start + 1; last < end; last++) if (state.src.slice(state.bMarks[last], state.eMarks[last]).includes(closer)) break;
    if (last === end) return false;
  }
  if (!silent) { const token = state.push('statistics_math', '', 0); token.map = [start, last + 1]; }
  state.line = last + 1;
  return true;
});

/** Segments natural language, merging hyphen/en-dash compounds; em dashes separate words. */
export function countWords(text: string, segmenter: Intl.Segmenter | null = defaultSegmenter): number {
  const compounds = text.replace(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:(?:--|[-‐‑–])[\p{L}\p{N}][\p{L}\p{M}\p{N}]*)+/gu, 'compound');
  return segmenter ? [...segmenter.segment(compounds)].filter((part) => part.isWordLike).length : (compounds.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0);
}
const defaultSegmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
const emptyText = (): TextStatistics => ({ words: 0, characters: 0, charactersWithoutSpaces: 0 });
const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();
const blank = (text: string) => text.replace(/[^\r\n]/g, ' ');

/** Pure one-shot API. Reuse a calculator for incremental editor updates. */
export function documentStatistics(input: string | DocumentSnapshot, options: StatisticsOptions = {}): DocumentStatistics {
  return new DocumentStatisticsCalculator().calculate(input, options);
}

/** Bounded content-addressed block cache survives edits/offset changes; never stores document DOM. */
export class DocumentStatisticsCalculator {
  private readonly cache = new Map<string, BlockStatistics>();
  private citationSignature = '';
  private referenceSignature = '';
  private captionOption = true;

  calculate(input: string | DocumentSnapshot, options: StatisticsOptions = {}): DocumentStatistics {
    const source = typeof input === 'string' ? input : input.source;
    const originalBlocks = typeof input === 'string' ? mapDocumentBlocks(source) : input.blocks;
    const prepared = prepareSource(source);
    const citations = options.citations ?? [];
    const signature = JSON.stringify(citations.map((citation) => [citation.key, citationTextLabel(citation, citation.key, true), citationTextLabel(citation, citation.key, false)]));
    const references = Object.fromEntries([...prepared.matchAll(/^ {0,3}\[([^\]^]+)\]:\s*<?([^\s>]+)>?.*$/gm)].map((match) => [match[1]!.toUpperCase(), { href: match[2]!, title: '' }]));
    const referenceSignature = JSON.stringify(references);
    const includeCaptions = options.includeCaptions !== false;
    if (signature !== this.citationSignature || referenceSignature !== this.referenceSignature || includeCaptions !== this.captionOption) this.cache.clear();
    this.citationSignature = signature; this.referenceSignature = referenceSignature; this.captionOption = includeCaptions;
    const citationMap = new Map(citations.map((citation) => [citation.key, citation]));
    const selected = options.selection;
    const from = selected ? Math.max(0, Math.min(selected.from, source.length)) : 0;
    const to = selected ? Math.max(from, Math.min(selected.to, source.length)) : source.length;
    const content = prepared.slice(from, to);
    const result = { textOnly: emptyText(), includingCitations: emptyText(), paragraphs: 0, sentences: 0, headings: 0, figures: 0, tables: 0, equations: 0, citations: 0, uniqueCitationKeys: [] as string[], crossReferences: 0, footnotes: 0, sections: [] as SectionStatistics[] };
    const keys = new Set<string>(); const footnotes = new Set<string>();
    // Mapped blocks retain offsets; only changed block content is parsed/segmented again.
    for (const block of mapDocumentBlocks(content, { frontmatter: false })) {
      const cacheKey = `${block.kind}\u0000${block.text}`;
      let metrics = this.cache.get(cacheKey);
      if (!metrics) {
        metrics = analyzeBlock(block.text, citationMap, references, includeCaptions);
        this.cache.set(cacheKey, metrics);
        if (this.cache.size > 4000) this.cache.delete(this.cache.keys().next().value!);
      }
      if (metrics.heading) {
        const position = from + block.from + metrics.heading.offset;
        result.sections.push({ label: metrics.heading.label, from: position, blockId: documentBlockAt(originalBlocks, position)?.id ?? block.id, words: 0 });
      }
      addText(result, 'textOnly', metrics.textOnly); addText(result, 'includingCitations', metrics.includingCitations);
      for (const field of ['paragraphs', 'sentences', 'headings', 'figures', 'tables', 'equations', 'crossReferences'] as const) result[field] += metrics[field];
      result.citations += metrics.citations.length;
      metrics.citations.forEach((key) => keys.add(key)); metrics.footnotes.forEach((key) => footnotes.add(key));
      const section = result.sections.at(-1);
      if (section) result.sections[result.sections.length - 1] = { ...section, words: section.words + metrics.textOnly.words };
    }
    result.uniqueCitationKeys = [...keys]; result.footnotes = footnotes.size;
    return result;
  }
}

function addText(result: { textOnly: TextStatistics; includingCitations: TextStatistics }, field: 'textOnly' | 'includingCitations', next: TextStatistics) {
  const previous = result[field];
  result[field] = { words: previous.words + next.words, characters: previous.characters + next.characters + (previous.characters && next.characters ? 1 : 0), charactersWithoutSpaces: previous.charactersWithoutSpaces + next.charactersWithoutSpaces };
}

/** Mask excluded material, keeping source offsets and line endings for section navigation. */
function prepareSource(source: string): string {
  let masked = maskMarkdownHtmlComments(source);
  const frontmatter = mapDocumentBlocks(masked)[0];
  if (frontmatter?.kind === 'frontmatter') masked = blank(masked.slice(0, frontmatter.to)) + masked.slice(frontmatter.to);
  let fence: CodeFence | undefined;
  let htmlTag: string | undefined; let htmlDepth = 0;
  masked = splitLines(masked).map((line) => {
    if (fence) { if (closesCodeFence(line, fence)) fence = undefined; return blank(line); }
    const html = /^ {0,3}<(script|pre|style|textarea|div|table|figure|section|article|aside|header|footer|main|nav|ul|ol|li|p|h[1-6]|blockquote|details|summary|form|iframe|svg|math)\b/i.exec(line)
      ?? /^ {0,3}<([A-Za-z][\w:-]*)\b[^>]*>\s*$/.exec(line);
    if (!htmlTag && html) { htmlTag = html[1]!.toLowerCase(); htmlDepth = 0; }
    if (htmlTag) {
      htmlDepth += [...line.matchAll(new RegExp(`<${htmlTag}\\b[^>]*>`, 'gi'))].filter((match) => !match[0].endsWith('/>')).length;
      htmlDepth -= [...line.matchAll(new RegExp(`</${htmlTag}\\s*>`, 'gi'))].length;
      if (htmlDepth <= 0 || /^(?:hr|img|br|input|meta|link)$/.test(htmlTag)) htmlTag = undefined;
      return blank(line);
    }
    fence = openingCodeFence(line);
    return fence ? blank(line) : line;
  }).join('');
  // Raw TeX is not prose. Equation environments count as one display equation.
  masked = masked.replace(/^ {0,3}\\begin\{([^}]+)\}[\s\S]*?\\end\{\1\}/gm, (whole: string, environment: string) => /^(?:equation|align|gather|multline)\*?$/.test(environment) ? `$$${blank(whole).slice(2, -2)}$$` : blank(whole));
  const divs: boolean[] = []; let bibliography = false;
  const lines = splitLines(masked);
  // A final References/Bibliography section extends through nested headings, ending at a peer heading.
  const headings = lines.flatMap((line, index) => {
    const match = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    const underline = lines[index + 1] && /^ {0,3}(=+|-+)\s*$/.exec(lines[index + 1]!);
    const level = match ? match[1]!.length : underline && line.trim() ? (underline[1]![0] === '=' ? 1 : 2) : 0;
    return level ? [{ index, level, label: (match?.[2] ?? line).replace(/\s*\{[^}]*\}\s*$/, '').replace(/[*_`]/g, '').trim() }] : [];
  });
  const finalReference = [...headings].reverse().find((heading) => /^(?:references|bibliography)$/i.test(heading.label) && !headings.some((later) => later.index > heading.index && later.level <= heading.level));
  return lines.map((line, index) => {
    const opening = /^\s*:{3,}\s*(\S.*)/.exec(line);
    const closing = /^\s*:{3,}\s*$/.test(line);
    if (opening) divs.push(/(?:^|[\s{])#refs(?=[\s}]|$)/.test(opening[1]!) || divs.includes(true));
    if (finalReference?.index === index) bibliography = true;
    const excluded = bibliography || divs.includes(true);
    if (closing) divs.pop();
    if (excluded || opening || closing) return blank(line);
    // Standalone attribute blocks, raw-format fences and callout labels aren't prose.
    if (/^\s*\{[^}]*\}\s*$/.test(line)) return blank(line);
    return line;
  }).join('');
}

function analyzeBlock(source: string, citations: ReadonlyMap<string, RenderCitation>, references: Record<string, { href: string; title: string }>, includeCaptions: boolean): BlockStatistics {
  const result: BlockStatistics = { textOnly: emptyText(), includingCitations: emptyText(), paragraphs: 0, sentences: 0, headings: 0, figures: 0, tables: 0, equations: 0, citations: [], crossReferences: 0, footnotes: [] };
  const pieces: Piece[] = [];
  const prepared = source.replace(/^\s*\[\^([^\]]+)\]:\s*/gm, (_whole, key: string) => { result.footnotes.push(key); return ''; });
  const tokens = markdown.parse(prepared, { references });
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === 'heading_open') result.headings++;
    if (token.type === 'table_open') result.tables++;
    if (token.type === 'statistics_math') result.equations++;
    if (token.type !== 'inline') continue;
    const previous = tokens[index - 1];
    const caption = /^\s*(?:Table\s*:|:\s+)\s*/i.test(token.content);
    const piece = inlineText(token.children ?? [], result, citations, includeCaptions);
    if (caption && !includeCaptions) continue;
    if (caption) for (const field of ['text', 'cited', 'wordText', 'citedWordText'] as const) piece[field] = piece[field].replace(/^\s*(?:Table\s*:|:\s+)\s*/i, '');
    const prose = normalize(piece.text);
    if (previous?.type === 'paragraph_open' && prose) result.paragraphs++;
    if (previous?.type === 'paragraph_open' && prose) result.sentences += prose.match(/[^.!?。！？]+(?:[.!?。！？]+|$)/gu)?.filter((part) => /[\p{L}\p{N}]/u.test(part)).length ?? 0;
    if (previous?.type === 'heading_open' && previous.tag === 'h1') result.heading = { label: normalize(piece.cited), offset: splitLines(source).slice(0, previous.map?.[0] ?? 0).join('').length };
    pieces.push(piece);
  }
  for (const variant of ['textOnly', 'includingCitations'] as const) {
    const text = normalize(pieces.map((piece) => variant === 'textOnly' ? piece.text : piece.cited).filter(Boolean).join(' '));
    result[variant] = { words: countWords(pieces.map((piece) => variant === 'textOnly' ? piece.wordText : piece.citedWordText).join(' ')), characters: [...text].length, charactersWithoutSpaces: [...text.replace(/\s/gu, '')].length };
  }
  return result;
}

function inlineText(tokens: readonly Token[], result: BlockStatistics, citations: ReadonlyMap<string, RenderCitation>, includeCaptions: boolean): Piece {
  const piece: Piece = { text: '', cited: '', wordText: '', citedWordText: '' };
  const append = (text: string, cited = text, wordText = text, citedWordText = cited) => { piece.text += text; piece.cited += cited; piece.wordText += wordText; piece.citedWordText += citedWordText; };
  for (const token of tokens) {
    if (token.type === 'statistics_math') { result.equations++; append(' '); }
    else if (token.type === 'statistics_literal') append(token.content);
    else if (token.type === 'code_inline') { append(token.content, token.content, ' inlinecode ', ' inlinecode '); }
    else if (token.type === 'softbreak' || token.type === 'hardbreak') append(' ');
    else if (token.type === 'image') {
      result.figures++;
      if (includeCaptions) { const alt = inlineText(token.children ?? [], result, citations, includeCaptions); append(alt.text, alt.cited, alt.wordText, alt.citedWordText); }
    } else if (token.type === 'text') {
      const text = token.content.replace(/\{(?:[#.=][^{}]*|[\w-]+\s*=[^{}]*)\}/g, '').replace(/\b(?:https?|ftp):\/\/[^\s<>]+/gi, '').replace(/\[\^([^\]]+)\]/g, (_whole, key: string) => { result.footnotes.push(key); return ''; });
      let plain = ''; let cited = ''; let offset = 0;
      const expression = /\[([^\[\]]*?(?<![\p{L}\p{N}_\\])@[\p{L}\p{N}_][^\[\]]*)\]|(?<![\p{L}\p{N}_\\@])(-?@([\p{L}\p{N}_][\p{L}\p{N}_:.#%&+?~\/-]*[\p{L}\p{N}_]|[\p{L}\p{N}_]))/gu;
      for (const match of text.matchAll(expression)) {
        plain += text.slice(offset, match.index); cited += text.slice(offset, match.index);
        const keys = match[1] ? [...match[1].matchAll(/@([\p{L}\p{N}_](?:[\p{L}\p{N}_:.#%&+?~\/-]*[\p{L}\p{N}_])?)/gu)].map((key) => key[1]!) : [match[3]!];
        const labels = keys.map((key) => {
          if (/^(?:fig|tbl|eq|sec|lst)-/.test(key)) { result.crossReferences++; return ''; }
          result.citations.push(key);
          return citationTextLabel(citations.get(key), key, !match[1]);
        }).filter(Boolean);
        plain += ' '; cited += labels.length ? (match[1] ? `(${labels.join('; ')})` : labels.join('; ')) : ' ';
        offset = match.index + match[0].length;
      }
      append(plain + text.slice(offset), cited + text.slice(offset));
    }
  }
  return piece;
}
