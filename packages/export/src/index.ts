/// <reference path="./assets.d.ts" />
import { stripCommentMarkup } from '@markroot/comments';
import { MarkrootError, throwIfAborted, type OperationContext } from '@markroot/core';
import typstCompilerWasmUrl from '@myriaddreamin/typst-ts-web-compiler/wasm?url';
import sourceSerifUrl from './assets/SourceSerif4-Regular.ttf?url';

let typstConfigured = false;

export type ExportFormat = 'html' | 'docx' | 'pdf';
export interface ExportResource { readonly path: string; readonly content: string | Blob }
export interface ExportRequest {
  readonly format: ExportFormat;
  readonly source: string;
  readonly filename: string;
  readonly resources?: readonly ExportResource[];
  readonly referenceDocx?: string;
}
export interface ExportResult { readonly format: ExportFormat; readonly blob: Blob; readonly filename: string; readonly warnings: readonly string[] }

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
    context?.onProgress?.({ phase: 'prepare', completed: 0, total: 3, message: 'Preparing local resources' });
    const source = stripCommentMarkup(request.source);
    const prepared = preparePandocInput(source, request.resources ?? []);
    try {
      const { convert } = await import('pandoc-wasm');
      if (request.format === 'html') {
        const result = await convert({ from: 'markdown+fenced_divs+tex_math_dollars', to: 'html5', standalone: true, 'embed-resources': true, citeproc: true }, prepared.source, prepared.files) as PandocResult;
        const html = requirePandocText(result, 'HTML');
        return finish(request, new Blob([html], { type: 'text/html;charset=utf-8' }), result.warnings);
      }
      if (request.format === 'docx') {
        const output = exportFilename(request.filename, 'docx');
        const referenceDocx = request.referenceDocx ? prepared.paths.get(request.referenceDocx) ?? request.referenceDocx : undefined;
        const result = await convert({ from: 'markdown+fenced_divs+tex_math_dollars', to: 'docx', 'output-file': output, citeproc: true, ...(referenceDocx ? { 'reference-doc': referenceDocx } : {}) }, prepared.source, prepared.files) as PandocResult;
        const blob = await requirePandocBlob(result, output, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        return finish(request, blob, result.warnings);
      }
      context?.onProgress?.({ phase: 'pandoc', completed: 1, total: 3, message: 'Converting Markdown to Typst' });
      const typstResult = await convert({ from: 'markdown+fenced_divs+tex_math_dollars', to: 'typst', standalone: true, citeproc: true }, prepared.source, prepared.files) as PandocResult;
      const typstSource = requirePandocText(typstResult, 'Typst');
      throwIfAborted(context);
      context?.onProgress?.({ phase: 'typst', completed: 2, total: 3, message: 'Compiling PDF locally' });
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
      return finish(request, new Blob([copied], { type: 'application/pdf' }), typstResult.warnings);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new MarkrootError('EXPORT_ERROR', `${request.format.toUpperCase()} export failed: ${detail}`, undefined, { cause });
    }
  }
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
