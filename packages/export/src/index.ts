/// <reference path="./assets.d.ts" />
import { stripCommentMarkup } from '@markroot/comments';
import { MarkrootError, throwIfAborted, type OperationContext } from '@markroot/core';
import typstCompilerWasmUrl from '@myriaddreamin/typst-ts-web-compiler/wasm?url';
import sourceSerifUrl from './assets/SourceSerif4-Regular.ttf?url';
import justifiedReferenceDocxUrl from './assets/JustifiedReference.docx?url';

let typstConfigured = false;

export type ExportFormat = 'html' | 'docx' | 'pdf';
export interface ExportResource { readonly path: string; readonly content: string | Blob }
export interface ExportRequest {
  readonly format: ExportFormat;
  readonly source: string;
  readonly filename: string;
  readonly resources?: readonly ExportResource[];
  readonly referenceDocx?: string;
  readonly htmlTemplate?: string;
  readonly htmlCss?: readonly string[];
  readonly typstTemplate?: string;
  readonly justified?: boolean;
}
export interface ExportResult { readonly format: ExportFormat; readonly blob: Blob; readonly filename: string; readonly warnings: readonly string[] }
export interface ExportOptions {
  readonly referenceDocx?: string;
  readonly htmlTemplate?: string;
  readonly htmlCss: readonly string[];
  readonly typstTemplate?: string;
  readonly typstTemplatePartials: readonly string[];
}

interface PandocResult {
  readonly stdout: string;
  readonly stderr?: string;
  readonly warnings: readonly unknown[];
  readonly files: Readonly<Record<string, string | Blob>>;
}

interface PreparedPandocInput {
  readonly source: string;
  readonly files: Readonly<Record<string, string | Blob>>;
  readonly paths: ReadonlyMap<string, string>;
}

export interface Exporter {
  readonly formats: readonly ExportFormat[];
  export(request: ExportRequest, context?: OperationContext): Promise<ExportResult>;
}

export class BrowserDocumentExporter implements Exporter {
  readonly formats = ['html', 'docx', 'pdf'] as const;

  async export(request: ExportRequest, context?: OperationContext): Promise<ExportResult> {
    throwIfAborted(context);
    const total = request.format === 'pdf' ? 3 : 2;
    context?.onProgress?.({ phase: 'prepare', completed: 0, total, message: 'Loading the local Pandoc engine' });
    const source = stripCommentMarkup(request.source);
    const prepared = preparePandocInput(source, request.resources ?? []);
    try {
      const { convert } = await import('pandoc-wasm');
      if (request.format === 'html') {
        context?.onProgress?.({ phase: 'pandoc', completed: 1, total, message: 'Creating HTML with Pandoc' });
        const template = mappedPath(request.htmlTemplate, prepared);
        const css = request.htmlCss?.map((path) => mappedPath(path, prepared)).filter((path): path is string => Boolean(path));
        const result = await convert({ from: 'markdown+fenced_divs+tex_math_dollars', to: 'html5', standalone: true, 'embed-resources': true, citeproc: true, ...(template ? { template } : {}), ...(css?.length ? { css } : {}) }, prepared.source, prepared.files) as PandocResult;
        const converted = requirePandocText(result, 'HTML');
        const html = request.justified !== undefined && !template && !css?.length ? withHtmlJustification(converted, request.justified) : converted;
        context?.onProgress?.({ phase: 'complete', completed: total, total, message: 'HTML conversion complete' });
        return finish(request, new Blob([html], { type: 'text/html;charset=utf-8' }), result.warnings);
      }
      if (request.format === 'docx') {
        context?.onProgress?.({ phase: 'pandoc', completed: 1, total, message: 'Creating DOCX with Pandoc' });
        const output = exportFilename(request.filename, 'docx');
        let referenceDocx = mappedPath(request.referenceDocx, prepared);
        let files = prepared.files;
        if (!referenceDocx && request.justified) {
          const response = await fetch(justifiedReferenceDocxUrl);
          if (!response.ok) throw new Error(`Bundled justified DOCX reference could not be loaded (${response.status}).`);
          referenceDocx = 'markroot-justified-reference.docx';
          files = { ...prepared.files, [referenceDocx]: await response.blob() };
        }
        const result = await convert({ from: 'markdown+fenced_divs+tex_math_dollars', to: 'docx', 'output-file': output, citeproc: true, ...(referenceDocx ? { 'reference-doc': referenceDocx } : {}) }, prepared.source, files) as PandocResult;
        const blob = await requirePandocBlob(result, output, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        context?.onProgress?.({ phase: 'complete', completed: total, total, message: 'DOCX conversion complete' });
        return finish(request, blob, result.warnings);
      }
      context?.onProgress?.({ phase: 'pandoc', completed: 1, total, message: 'Converting Markdown to Typst' });
      const typstTemplate = mappedPath(request.typstTemplate, prepared);
      const typstResult = await convert({ from: 'markdown+fenced_divs+tex_math_dollars', to: 'typst', standalone: true, citeproc: true, ...(typstTemplate ? { template: typstTemplate } : {}) }, prepared.source, prepared.files) as PandocResult;
      const convertedTypstSource = requirePandocText(typstResult, 'Typst');
      const typstSource = request.justified !== undefined && !typstTemplate ? `#set par(justify: ${request.justified})\n${convertedTypstSource}` : convertedTypstSource;
      throwIfAborted(context);
      context?.onProgress?.({ phase: 'typst', completed: 2, total, message: 'Compiling PDF locally' });
      const [{ $typst, MemoryAccessModel }, { TypstSnippet }] = await Promise.all([
        import('@myriaddreamin/typst.ts'),
        import('@myriaddreamin/typst.ts/contrib/snippet'),
      ]);
      if (!typstConfigured) {
        const fontResponse = await fetch(sourceSerifUrl);
        if (!fontResponse.ok) throw new Error(`Bundled PDF font could not be loaded (${fontResponse.status}).`);
        const font = new Uint8Array(await fontResponse.arrayBuffer());
        $typst.use(
          TypstSnippet.withAccessModel(new MemoryAccessModel()),
          TypstSnippet.preloadFontData(font),
        );
        $typst.setCompilerInitOptions({
          getModule: () => typstCompilerWasmUrl,
        });
        typstConfigured = true;
      }
      await $typst.resetShadow();
      await $typst.mapShadow('/main.typ', new TextEncoder().encode(typstSource));
      for (const [path, content] of Object.entries(prepared.files)) {
        const bytes = typeof content === 'string'
          ? new TextEncoder().encode(content)
          : new Uint8Array(await content.arrayBuffer());
        await $typst.mapShadow(`/${path}`, bytes);
      }
      const pdf = await $typst.pdf({ mainFilePath: '/main.typ' });
      if (!pdf?.byteLength) throw new Error('Typst did not return a PDF document.');
      throwIfAborted(context);
      const copied = new Uint8Array(pdf.byteLength);
      copied.set(pdf);
      context?.onProgress?.({ phase: 'complete', completed: total, total, message: 'PDF compilation complete' });
      return finish(request, new Blob([copied], { type: 'application/pdf' }), typstResult.warnings);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new MarkrootError('EXPORT_ERROR', `${request.format.toUpperCase()} export failed: ${detail}`, undefined, { cause });
    }
  }
}

function mappedPath(path: string | undefined, prepared: PreparedPandocInput): string | undefined {
  return path ? prepared.paths.get(path) ?? path : undefined;
}

function withHtmlJustification(html: string, justified: boolean): string {
  const style = `<style data-markroot-export>p { text-align: ${justified ? 'justify' : 'start'}; }</style>`;
  return /<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i, `${style}</head>`) : `${style}${html}`;
}

function finish(request: ExportRequest, blob: Blob, warnings: readonly unknown[]): ExportResult {
  return { format: request.format, blob, filename: exportFilename(request.filename, request.format), warnings: warnings.map(formatWarning) };
}

export function preparePandocInput(source: string, resources: readonly ExportResource[]): PreparedPandocInput {
  const files: Record<string, string | Blob> = {};
  const paths = new Map<string, string>();
  for (const resource of resources) {
    if (!resource.path || paths.has(resource.path)) continue;
    const filename = `markroot-resource-${paths.size + 1}${resourceExtension(resource)}`;
    paths.set(resource.path, filename);
    files[filename] = resource.content;
  }
  const replacements = [...paths.entries()].sort(([left], [right]) => right.length - left.length);
  const rewritten = replacements.reduce((value, [path, filename]) => value.replaceAll(path, filename), source);
  return { source: rewritten, files, paths };
}

export function exportFilename(filename: string, format: ExportFormat): string {
  const leaf = filename.replaceAll('\\', '/').split('/').at(-1) || 'document';
  const stem = leaf.replace(/\.(?:md|qmd|html|docx|pdf)$/i, '') || 'document';
  return `${stem}.${format}`;
}

export function parseExportOptions(source: string): ExportOptions {
  const metadata = yamlFrontmatterValues(source);
  return {
    ...optionalValue('referenceDocx', metadata.get('format.docx.reference-doc')?.[0] ?? metadata.get('reference-doc')?.[0]),
    ...optionalValue('htmlTemplate', metadata.get('format.html.template')?.[0]),
    htmlCss: metadata.get('format.html.css') ?? [],
    ...optionalValue('typstTemplate', metadata.get('format.typst.template')?.[0]),
    typstTemplatePartials: metadata.get('format.typst.template-partials') ?? [],
  };
}

function optionalValue<Key extends string>(key: Key, value: string | undefined): { readonly [Name in Key]?: string } {
  return value ? { [key]: value } as { readonly [Name in Key]?: string } : {};
}

function yamlFrontmatterValues(source: string): ReadonlyMap<string, readonly string[]> {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  if (lines[0]?.trim() !== '---') return new Map();
  const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line.trim()));
  if (end < 0) return new Map();
  const values = new Map<string, string[]>();
  const stack: Array<{ readonly indent: number; readonly key: string }> = [];
  let listPath: string | undefined;
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const list = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (list && listPath) { addYamlValue(values, listPath, yamlScalar(list[1]!)); continue; }
    const entry = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!entry) continue;
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    const key = entry[1]!;
    const path = [...stack.map((item) => item.key), key].join('.');
    const raw = entry[2]!;
    listPath = undefined;
    if (!raw) { stack.push({ indent, key }); listPath = path; continue; }
    const flow = /^\[(.*)\]$/.exec(raw);
    if (flow) {
      for (const value of flow[1]!.split(',')) addYamlValue(values, path, yamlScalar(value));
    } else addYamlValue(values, path, yamlScalar(raw));
  }
  return values;
}

function addYamlValue(values: Map<string, string[]>, path: string, value: string): void {
  if (!value) return;
  const existing = values.get(path) ?? [];
  existing.push(value);
  values.set(path, existing);
}

function yamlScalar(value: string): string {
  const trimmed = value.trim();
  const unquoted = trimmed.match(/^(["'])([\s\S]*)\1$/)?.[2] ?? trimmed.replace(/\s+#.*$/, '');
  return unquoted.trim();
}

function resourceExtension(resource: ExportResource): string {
  const path = resource.path.split(/[?#]/, 1)[0] ?? '';
  const pathExtension = /\.[a-z0-9]{1,10}$/i.exec(path)?.[0]?.toLowerCase() ?? '';
  if (pathExtension && !(pathExtension === '.pdf' && resource.content instanceof Blob && resource.content.type.toLowerCase() === 'image/png')) {
    return pathExtension;
  }
  if (resource.content instanceof Blob) {
    const byType = ({
      'application/pdf': '.pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/xml': '.xml',
      'image/avif': '.avif',
      'image/gif': '.gif',
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/svg+xml': '.svg',
      'image/webp': '.webp',
      'text/css': '.css',
      'text/plain': '.txt',
    } as Record<string, string>)[resource.content.type.toLowerCase()];
    if (byType) return byType;
  }
  return pathExtension;
}

function requirePandocText(result: PandocResult, label: string): string {
  if (result.stdout.trim()) return result.stdout;
  throw new Error(pandocFailure(result, `Pandoc did not return ${label} content.`));
}

async function requirePandocBlob(result: PandocResult, filename: string, type: string): Promise<Blob> {
  const output = result.files[filename];
  if (output instanceof Blob && output.size > 0) return output.slice(0, output.size, type);
  if (output && typeof output !== 'string' && typeof output.arrayBuffer === 'function') {
    const bytes = await output.arrayBuffer();
    if (bytes.byteLength > 0) return new Blob([bytes], { type });
  }
  throw new Error(pandocFailure(result, `Pandoc did not return ${filename}.`));
}

function pandocFailure(result: PandocResult, fallback: string): string {
  const stderr = result.stderr?.trim();
  if (stderr) return `${fallback} ${stderr}`;
  const warning = result.warnings.map(formatWarning).find(Boolean);
  return warning ? `${fallback} ${warning}` : fallback;
}

function formatWarning(warning: unknown): string {
  if (typeof warning === 'object' && warning !== null && 'pretty' in warning && typeof warning.pretty === 'string') return warning.pretty.trim();
  return String(warning);
}
