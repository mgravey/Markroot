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
    const files = Object.fromEntries((request.resources ?? []).map((resource) => [resource.path, resource.content]));
    try {
      const { convert } = await import('pandoc-wasm');
      if (request.format === 'html') {
        const result = await convert({ from: 'markdown+fenced_divs+tex_math_dollars', to: 'html5', standalone: true, 'embed-resources': true, citeproc: true }, source, files);
        return finish(request, new Blob([result.stdout], { type: 'text/html;charset=utf-8' }), result.warnings);
      }
      if (request.format === 'docx') {
        const output = `${basename(request.filename)}.docx`;
        const result = await convert({ from: 'markdown+fenced_divs+tex_math_dollars', to: 'docx', 'output-file': output, citeproc: true, ...(request.referenceDocx ? { 'reference-doc': request.referenceDocx } : {}) }, source, files);
        const blob = result.files[output];
        if (!(blob instanceof Blob)) throw new Error('Pandoc did not return a DOCX blob.');
        return finish(request, blob, result.warnings);
      }
      context?.onProgress?.({ phase: 'pandoc', completed: 1, total: 3, message: 'Converting Markdown to Typst' });
      const typstResult = await convert({ from: 'markdown+fenced_divs+tex_math_dollars', to: 'typst', standalone: true, citeproc: true }, source, files);
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
      await $typst.mapShadow('/main.typ', new TextEncoder().encode(typstResult.stdout));
      for (const resource of request.resources ?? []) {
        const bytes = typeof resource.content === 'string'
          ? new TextEncoder().encode(resource.content)
          : new Uint8Array(await resource.content.arrayBuffer());
        await $typst.mapShadow(`/${resource.path.replace(/^\/+/, '')}`, bytes);
      }
      const pdf = await $typst.pdf({ mainFilePath: '/main.typ' });
      if (!pdf) throw new Error('Typst did not return a PDF document.');
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
  return { format: request.format, blob, filename: `${basename(request.filename)}.${request.format}`, warnings: warnings.map(String) };
}
function basename(filename: string): string { return filename.replace(/\.(?:md|qmd|html|docx|pdf)$/i, ''); }
