import createDOMPurify, { type DOMPurify as Purifier, type WindowLike } from 'dompurify';

const FORBID_TAGS = ['script', 'style', 'iframe', 'object', 'embed'];
const FORBID_ATTR = ['style'];
/** Attributes that make the browser fetch a URL as soon as the element exists in a document with a browsing context. */
const RESOURCE_ATTRIBUTES = new Set(['src', 'srcset', 'imagesrcset', 'poster', 'background', 'data', 'lowsrc', 'dynsrc', 'ping', 'href', 'xlink:href']);
const SRCSET_ATTRIBUTES = new Set(['srcset', 'imagesrcset']);
/** SVG presentation attributes whose url(...) references may point at external documents. */
const URL_REFERENCE_ATTRIBUTES = new Set(['fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start', 'marker-mid', 'marker-end', 'cursor']);
/** On these elements href is a navigation the user chooses to follow, not a resource load. */
const NAVIGATION_ELEMENTS = new Set(['a', 'area']);
export const REMOTE_BLOCKED_ATTRIBUTE = 'data-remote-resource-blocked';

interface PreviewPurifier {
  readonly purifier: Purifier;
  state?: { readonly base: string; readonly blocked: Set<Element> } | undefined;
}

const purifiers = new WeakMap<object, PreviewPurifier>();

/** A dedicated DOMPurify instance per window keeps the remote-resource hooks out of the shared global instance. */
function previewPurifier(targetWindow: WindowLike): PreviewPurifier {
  const existing = purifiers.get(targetWindow);
  if (existing) return existing;
  const entry: PreviewPurifier = { purifier: createDOMPurify(targetWindow) };
  entry.purifier.addHook('uponSanitizeAttribute', (node, data) => {
    const state = entry.state;
    if (!state || !data.keepAttr || !remoteAttribute(node.localName ?? node.nodeName.toLowerCase(), data.attrName, data.attrValue, state.base)) return;
    data.keepAttr = false;
    state.blocked.add(node);
  });
  entry.purifier.addHook('afterSanitizeAttributes', (node) => {
    if (entry.state?.blocked.has(node)) node.setAttribute(REMOTE_BLOCKED_ATTRIBUTE, 'true');
  });
  purifiers.set(targetWindow, entry);
  return entry;
}

/** Sanitizes viewer HTML; unless remote resources are allowed, strips every attribute that would load an off-origin URL. */
export function sanitizePreviewHtml(html: string, options: { readonly allowRemoteResources: boolean; readonly baseUrl: string; readonly window?: WindowLike | undefined }): string {
  const entry = previewPurifier(options.window ?? window);
  entry.state = options.allowRemoteResources ? undefined : { base: options.baseUrl, blocked: new Set() };
  try { return entry.purifier.sanitize(html, { FORBID_TAGS, FORBID_ATTR }); }
  finally { entry.state = undefined; }
}

/** Replaces images left without a source by the sanitizer with the same placeholder the rendering engine emits. */
export function replaceBlockedImages(root: ParentNode & Node): void {
  const ownerDocument = root.ownerDocument ?? (root as Document);
  for (const image of root.querySelectorAll<HTMLImageElement>(`img[${REMOTE_BLOCKED_ATTRIBUTE}]`)) {
    if (image.getAttribute('src')) continue;
    const placeholder = ownerDocument.createElement('span');
    placeholder.className = 'remote-resource-placeholder';
    placeholder.setAttribute(REMOTE_BLOCKED_ATTRIBUTE, 'true');
    const alt = image.getAttribute('alt');
    placeholder.textContent = alt ? `Remote image blocked: ${alt}` : 'Remote image blocked';
    image.replaceWith(placeholder);
  }
}

export function remoteAttribute(element: string, attribute: string, value: string, base: string): boolean {
  const name = attribute.toLowerCase();
  if (URL_REFERENCE_ATTRIBUTES.has(name) && [...value.matchAll(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi)].some((match) => isRemoteUrl(match[2] ?? '', base))) return true;
  if (!RESOURCE_ATTRIBUTES.has(name)) return false;
  if ((name === 'href' || name === 'xlink:href') && NAVIGATION_ELEMENTS.has(element.toLowerCase())) return false;
  if (SRCSET_ATTRIBUTES.has(name)) return value.split(',').some((candidate) => isRemoteUrl(candidate.trim().split(/\s+/)[0] ?? '', base));
  if (name === 'ping') return value.split(/\s+/).some((url) => isRemoteUrl(url, base));
  return isRemoteUrl(value, base);
}

/** True when the URL would be fetched from another origin; relative, fragment, data: and blob: URLs stay local. */
export function isRemoteUrl(value: string, base: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('#')) return false;
  let url: URL;
  let baseUrl: URL;
  try { baseUrl = new URL(base); url = new URL(trimmed, baseUrl); }
  catch { return true; }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return false;
  return url.origin === 'null' || url.origin !== baseUrl.origin;
}
