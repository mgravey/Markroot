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
  const mirrored = new Map<Element, Element>([...sourceDocument.querySelectorAll(SHARED_STYLE_SELECTOR)].map((node) => [node, targetDocument.importNode(node, true)]));
  targetDocument.head.replaceChildren(base, charset, viewport, title, ...mirrored.values(), windowStyle);
  const root = targetDocument.createElement('div');
  root.id = 'markroot-detached-root';
  targetDocument.body.replaceChildren(root);
  targetDocument.documentElement.dataset.theme = dark ? 'dark' : 'light';
  linkDetachedViewer(sourceDocument, targetDocument, mirrored, windowStyle);
  return root;
}

const SHARED_STYLE_SELECTOR = 'link[rel="stylesheet"], style';

/**
 * Keeps the popup tied to its opener: it closes when the main window unloads, and mirrors styles the opener adds
 * later (lazy chunks, Vite HMR). Both bindings are released as soon as the popup itself goes away.
 */
function linkDetachedViewer(sourceDocument: Document, targetDocument: Document, mirrored: Map<Element, Element>, anchor: Element): void {
  const sourceWindow = sourceDocument.defaultView;
  const targetWindow = targetDocument.defaultView;
  if (!sourceWindow || !targetWindow) return;
  const sync = () => {
    const current = new Set(sourceDocument.querySelectorAll(SHARED_STYLE_SELECTOR));
    for (const [node, copy] of mirrored) if (!current.has(node)) { copy.remove(); mirrored.delete(node); }
    for (const node of current) {
      const copy = mirrored.get(node);
      if (copy && copy.outerHTML === node.outerHTML) continue;
      const next = targetDocument.importNode(node, true);
      if (copy) copy.replaceWith(next);
      else anchor.before(next);
      mirrored.set(node, next);
    }
  };
  const observer = new sourceWindow.MutationObserver(sync);
  observer.observe(sourceDocument.head, { childList: true, subtree: true, characterData: true, attributes: true });
  const closeViewer = () => targetWindow.close();
  const release = () => {
    observer.disconnect();
    sourceWindow.removeEventListener('pagehide', closeViewer);
    targetWindow.removeEventListener('pagehide', release);
  };
  sourceWindow.addEventListener('pagehide', closeViewer);
  targetWindow.addEventListener('pagehide', release);
}

export function detachedViewerTitle(path?: string): string {
  return path ? `${path} — Markroot Viewer` : 'Markroot Viewer';
}
