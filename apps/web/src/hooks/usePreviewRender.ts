import { useEffect, useMemo, useRef, useState } from 'react';
import { DocumentSession, type DocumentSnapshot } from '@markroot/document';
import { BasicDocumentEngine, type RenderArtifact } from '@markroot/rendering';
import type { GuardedWorkspace } from '@markroot/workspace';
import type { CitationRecord } from '@markroot/citations';
import { collectPreviewResources, PreviewResourceCache } from '../document-resources.js';

interface Options {
  readonly previewSnapshot: DocumentSnapshot | undefined;
  readonly workspace: GuardedWorkspace | undefined;
  readonly citations: readonly CitationRecord[];
  readonly allowRemoteResources: boolean;
  /** Source rendered as the tracked-changes base; undefined when tracked changes are hidden. */
  readonly baseSource: string | undefined;
  readonly reportError: (error: unknown) => void;
}

/** Debounced preview rendering plus the tracked-changes base render. Owns the artifacts' object URLs. */
export function usePreviewRender({ previewSnapshot, workspace, citations, allowRemoteResources, baseSource, reportError }: Options) {
  const engine = useMemo(() => new BasicDocumentEngine(), []);
  const resources = useMemo(() => new PreviewResourceCache(), []);
  const [rendered, setRendered] = useState<RenderArtifact>();
  const [renderedBaseHtml, setRenderedBaseHtml] = useState<string>();
  const renderedRef = useRef<RenderArtifact | undefined>(undefined);
  renderedRef.current = rendered;

  useEffect(() => () => revokeArtifact(renderedRef.current), []);
  // Cached blobs belong to one folder.
  useEffect(() => () => resources.clear(), [workspace, resources]);

  useEffect(() => {
    if (!previewSnapshot || !/\.(?:md|qmd)$/i.test(previewSnapshot.path)) { setRendered((current) => { revokeArtifact(current); return undefined; }); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void collectPreviewResources(workspace, previewSnapshot, resources, controller.signal).then((dependencies) => engine.render({ snapshot: previewSnapshot, dependencies, citations, allowRemoteResources }, { signal: controller.signal }))
        .then((artifact) => {
          if (controller.signal.aborted) { revokeArtifact(artifact); return; }
          setRendered((current) => { revokeArtifact(current); return artifact; });
        })
        .catch((error) => { if (!controller.signal.aborted) reportError(error); });
    }, 120);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [previewSnapshot, engine, allowRemoteResources, workspace, citations]);

  useEffect(() => {
    if (!previewSnapshot || baseSource === undefined) { setRenderedBaseHtml(undefined); return; }
    const controller = new AbortController();
    const baseSnapshot = new DocumentSession(previewSnapshot.path, baseSource).snapshot();
    void engine.render({ snapshot: baseSnapshot, citations, allowRemoteResources }, { signal: controller.signal })
      .then((artifact) => { if (!controller.signal.aborted) setRenderedBaseHtml(artifact.html); })
      .catch((error) => { if (!controller.signal.aborted) reportError(error); });
    return () => controller.abort();
  }, [previewSnapshot?.path, baseSource, engine, citations, allowRemoteResources]);

  return { rendered, renderedBaseHtml };
}

function revokeArtifact(artifact: RenderArtifact | undefined): void { artifact?.objectUrls?.forEach((url) => URL.revokeObjectURL(url)); }
