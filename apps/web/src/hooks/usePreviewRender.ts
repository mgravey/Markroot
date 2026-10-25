import { useEffect, useMemo, useState } from 'react';
import { DocumentSession, type DocumentSnapshot } from '@markroot/document';
import { BasicDocumentEngine, type RenderArtifact } from '@markroot/rendering';
import type { GuardedWorkspace } from '@markroot/workspace';
import type { CitationRecord } from '@markroot/citations';
import { collectPreviewResources, PreviewResourceCache, PreviewUrlCache } from '../document-resources.js';

interface Options {
  readonly previewSnapshot: DocumentSnapshot | undefined;
  readonly workspace: GuardedWorkspace | undefined;
  readonly workspacePaths?: readonly string[];
  readonly citations: readonly CitationRecord[];
  readonly allowRemoteResources: boolean;
  /** Source rendered as the tracked-changes base; undefined when tracked changes are hidden. */
  readonly baseSource: string | undefined;
  readonly reportError: (error: unknown) => void;
}

/** Debounced preview rendering plus the tracked-changes base render. Owns the artifacts' object URLs. */
export function usePreviewRender({ previewSnapshot, workspace, workspacePaths, citations, allowRemoteResources, baseSource, reportError }: Options) {
  const engine = useMemo(() => new BasicDocumentEngine(), []);
  const resources = useMemo(() => new PreviewResourceCache(), []);
  const urls = useMemo(() => new PreviewUrlCache(), []);
  const [result, setResult] = useState<{ artifact: RenderArtifact; snapshot: DocumentSnapshot; release(): void }>();
  const [renderedBaseHtml, setRenderedBaseHtml] = useState<string>();
  const previewPath = previewSnapshot?.path;
  // Passive cleanup runs after React has replaced the old HTML in both viewer windows.
  useEffect(() => () => result?.release(), [result]);
  // Cached blobs belong to one folder.
  useEffect(() => () => resources.clear(), [workspace, resources]);

  useEffect(() => {
    if (!previewSnapshot || !/\.(?:md|qmd)$/i.test(previewSnapshot.path)) { setResult(undefined); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        const dependencies = await collectPreviewResources(workspace, previewSnapshot, resources, controller.signal, workspacePaths);
        if (controller.signal.aborted) return;
        const lease = urls.acquire(dependencies);
        try {
          const artifact = await engine.render({ snapshot: previewSnapshot, workspacePaths: workspacePaths ?? [], dependencies: lease.dependencies, citations, allowRemoteResources }, { signal: controller.signal });
          if (controller.signal.aborted) { lease.release(); return; }
          setResult({ artifact, snapshot: previewSnapshot, release: lease.release });
        } catch (error) { lease.release(); throw error; }
      })().catch((error: unknown) => { if (!controller.signal.aborted) reportError(error); });
    }, 120);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [previewSnapshot, engine, allowRemoteResources, workspace, workspacePaths, citations, resources, urls, reportError]);

  useEffect(() => {
    if (!previewPath || baseSource === undefined) { setRenderedBaseHtml(undefined); return; }
    const controller = new AbortController();
    const baseSnapshot = new DocumentSession(previewPath, baseSource).snapshot();
    void engine.render({ snapshot: baseSnapshot, workspacePaths: workspacePaths ?? [], citations, allowRemoteResources }, { signal: controller.signal })
      .then((artifact) => { if (!controller.signal.aborted) setRenderedBaseHtml(artifact.html); })
      .catch((error) => { if (!controller.signal.aborted) reportError(error); });
    return () => controller.abort();
  }, [previewPath, baseSource, engine, workspacePaths, citations, allowRemoteResources, reportError]);

  return { rendered: result?.artifact, renderedSnapshot: result?.snapshot, renderedBaseHtml };
}

