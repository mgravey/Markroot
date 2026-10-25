import { resolveWorkspaceReference, throwIfAborted, type OperationContext, type WorkspacePath } from '@markroot/core';
import type { DocumentSnapshot } from '@markroot/document';
import type { ExportFormat, ExportResource, parseExportOptions } from '@markroot/export';
import type { GuardedWorkspace } from '@markroot/workspace';
import { isPdfFigurePath, renderPdfFigurePreview } from './pdf-preview.js';

/** Markdown image references: `![alt](path "title")` with an optional `<…>`-wrapped path. Global; use with matchAll. */
export const IMAGE_REFERENCE = /!\[(?:[^\[\]]|\[[^\]]*\])*\]\((<[^>]+>|[^\s)>]+)(?:\s+["'][^"']*["'])?\)/g;
const NON_LOCAL_REFERENCE = /^(?:https?:|data:|blob:|#)/i;

/**
 * Remembers preview blobs by path and file version so debounced re-renders neither re-read images
 * nor re-rasterize PDF figures. Entries not used by the latest collection are dropped. The cache
 * holds Blobs, not object URLs: the render engine mints (and the app revokes) URLs per artifact.
 */
export class PreviewResourceCache {
  private entries = new Map<string, { readonly version: string; readonly content: Promise<Blob> }>();
  private used = new Set<string>();

  get(path: WorkspacePath, version: string, load: () => Promise<Blob>): Promise<Blob> {
    this.used.add(path);
    const cached = this.entries.get(path);
    if (cached?.version === version) return cached.content;
    const content = load();
    this.entries.set(path, { version, content });
    // Failed loads are retried by the next render instead of being cached.
    content.catch(() => { if (this.entries.get(path)?.content === content) this.entries.delete(path); });
    return content;
  }

  /** Starts a collection pass; `finish` evicts every path the pass did not request. */
  begin(): void { this.used = new Set(); }
  finish(): void { for (const path of [...this.entries.keys()]) if (!this.used.has(path)) this.entries.delete(path); }
  clear(): void { this.entries.clear(); this.used.clear(); }
  get size(): number { return this.entries.size; }
}

/** Leases keep shared URLs alive until every rendered artifact using them has left the DOM. */
export class PreviewUrlCache {
  private entries = new Map<Blob, { url: string; references: number }>();

  acquire(resources: readonly ExportResource[]) {
    const held: Blob[] = [];
    const dependencies = resources.map((resource) => {
      const blob = resource.content instanceof Blob ? resource.content : new Blob([resource.content]);
      let entry = this.entries.get(blob);
      if (!entry) { entry = { url: URL.createObjectURL(blob), references: 0 }; this.entries.set(blob, entry); }
      entry.references += 1;
      held.push(blob);
      return { ...resource, objectUrl: entry.url };
    });
    let released = false;
    return { dependencies, release: () => {
      if (released) return;
      released = true;
      for (const blob of held) {
        const entry = this.entries.get(blob)!;
        if (--entry.references === 0) { URL.revokeObjectURL(entry.url); this.entries.delete(blob); }
      }
    } };
  }
}

export async function collectPreviewResources(workspace: GuardedWorkspace | undefined, snapshot: DocumentSnapshot, cache: PreviewResourceCache, signal?: AbortSignal): Promise<readonly ExportResource[]> {
  if (!workspace) return [];
  const resources: ExportResource[] = [];
  const seen = new Set<string>();
  const context = signal ? { signal } : undefined;
  throwIfAborted(context);
  cache.begin();
  for (const match of snapshot.source.matchAll(IMAGE_REFERENCE)) {
    throwIfAborted(context);
    const reference = unwrapReference(match[1]!);
    if (NON_LOCAL_REFERENCE.test(reference) || seen.has(reference)) continue;
    seen.add(reference);
    try {
      const path = resolveWorkspaceReference(snapshot.path, reference);
      const stat = await workspace.stat(path, context);
      throwIfAborted(context);
      if (stat.kind !== 'file') continue;
      const version = stat.version ?? `${stat.modifiedAt ?? 'unknown'}:${stat.size}`;
      // Cached work can outlive the render that started it. Only the consumer's wait is abortable.
      const content = await abortable(cache.get(path, version, async () => {
        const bytes = await workspace.readBytes(path);
        const localFile = new Blob([bytes.slice()], { type: mediaTypeForPath(path) });
        if (!isPdfFigurePath(path)) return localFile;
        try { return await renderPdfFigurePreview(localFile, `${path}:${version}`); }
        catch { return localFile; /* the viewer presents its normal image-unavailable fallback */ }
      }), signal);
      throwIfAborted(context);
      resources.push({ path: reference, content });
    } catch (error) {
      // A cancelled render must stop here; other failures keep the unresolved path and renderer warnings.
      if (signal?.aborted) throw signal.reason ?? error;
    }
  }
  if (!signal?.aborted) cache.finish();
  return resources;
}

export async function collectDocumentResources(workspace: GuardedWorkspace, snapshot: DocumentSnapshot, format: ExportFormat, exportOptions: ReturnType<typeof parseExportOptions>, context?: OperationContext): Promise<readonly ExportResource[]> {
  const sourceReferences = new Set<string>();
  for (const match of snapshot.source.matchAll(IMAGE_REFERENCE)) sourceReferences.add(unwrapReference(match[1]!));
  for (const match of snapshot.source.matchAll(/\b(?:bibliography|csl|reference-doc)\s*:\s*["']?([^\s"']+)/gi)) sourceReferences.add(unwrapReference(match[1]!));
  for (const reference of [exportOptions.referenceDocx, exportOptions.htmlTemplate, exportOptions.typstTemplate, ...exportOptions.htmlCss, ...exportOptions.typstTemplatePartials]) {
    if (reference) sourceReferences.add(reference);
  }
  const localReferences = [...sourceReferences].filter((reference) => !NON_LOCAL_REFERENCE.test(reference));
  const resources: ExportResource[] = [];
  const added = new Set<string>();
  const add = async (reference: string, path: WorkspacePath) => {
    if (added.has(reference)) return;
    throwIfAborted(context);
    const stat = await workspace.stat(path, context);
    if (stat.kind !== 'file') return;
    const bytes = await workspace.readBytes(path, context);
    const localFile = new Blob([bytes.slice()], { type: mediaTypeForPath(path) });
    const content = format !== 'pdf' && isPdfFigurePath(path)
      ? await abortable(renderPdfFigurePreview(localFile, `export:${path}:${stat.version ?? `${stat.modifiedAt ?? 'unknown'}:${stat.size}`}`), context?.signal)
      : localFile;
    throwIfAborted(context);
    resources.push({ path: reference, content });
    added.add(reference);
  };
  if (!localReferences.length) context?.onProgress?.({ phase: 'resources', completed: 0, total: 0, message: 'No local resources to collect' });
  for (const [index, reference] of localReferences.entries()) {
    context?.onProgress?.({ phase: 'resources', completed: index, total: localReferences.length, message: `Reading resource ${index + 1} of ${localReferences.length}: ${reference}` });
    try {
      await add(reference, resolveWorkspaceReference(snapshot.path, reference));
    } catch { throwIfAborted(context); /* unresolved dependencies are reported by Pandoc */ }
  }
  return resources;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted({ signal });
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Export cancelled.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

function unwrapReference(reference: string): string { return reference.trim().replace(/^<([\s\S]*)>$/, '$1'); }
export function mediaTypeForPath(path: string): string {
  const extension = path.split('.').at(-1)?.toLowerCase();
  return ({ avif: 'image/avif', gif: 'image/gif', jpeg: 'image/jpeg', jpg: 'image/jpeg', pdf: 'application/pdf', png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp', bib: 'text/plain', bibtex: 'text/plain', csl: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml' } as Record<string, string>)[extension ?? ''] ?? 'application/octet-stream';
}
