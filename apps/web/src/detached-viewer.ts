export function prepareDetachedViewerDocument(sourceDocument: Document, targetDocument: Document, path: string | undefined, dark: boolean): HTMLElement {
  const base = targetDocument.createElement('base');
  base.href = sourceDocument.baseURI;
  const charset = targetDocument.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  const viewport = targetDocument.createElement('meta');
  viewport.name = 'viewport';
  viewport.content = 'width=device-width, initial-scale=1';
  const title = targetDocument.createElement('title');
  title.textContent = detachedViewerTitle(path);
  const windowStyle = targetDocument.createElement('style');
  windowStyle.textContent = 'html,body,#markroot-detached-root{width:100%;height:100%;margin:0;overflow:hidden}';
  const sharedStyles = [...sourceDocument.querySelectorAll('link[rel="stylesheet"], style')].map((node) => targetDocument.importNode(node, true));
  targetDocument.head.replaceChildren(base, charset, viewport, title, ...sharedStyles, windowStyle);
  const root = targetDocument.createElement('div');
  root.id = 'markroot-detached-root';
  targetDocument.body.replaceChildren(root);
  targetDocument.documentElement.dataset.theme = dark ? 'dark' : 'light';
  return root;
}

export function detachedViewerTitle(path?: string): string {
  return path ? `${path} — Markroot Viewer` : 'Markroot Viewer';
}
