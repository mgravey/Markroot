import { editorTrackChanges } from './editor-track-changes.js';

interface RenderedTextRun {
  readonly node?: Text;
  readonly from: number;
  readonly to: number;
}

const ATOMIC_SELECTOR = [
  'pre', 'code', 'math', '.math-inline', '.math-display', '.citation', '.references',
  '.viewer-warnings', '.section-number', '.equation-number', '.figure-label', '.table-label',
  'img', '.image-missing', '.remote-resource-placeholder',
].join(',');

export function applyRenderedTrackChanges(currentRoot: HTMLElement, baseRoot: HTMLElement): void {
  const current = renderedText(currentRoot);
  const base = renderedText(baseRoot);
  const changes = editorTrackChanges(base.value, current.value);
  if (!changes.length) return;

  const insertions = changes.filter((change) => change.kind === 'insert');
  const deletions = new Map<Text, Array<{ at: number; value: string }>>();
  const textRuns = current.runs.filter((run): run is RenderedTextRun & { readonly node: Text } => Boolean(run.node));

  for (const change of changes) {
    if (change.kind !== 'delete') continue;
    const run = textRunAt(textRuns, change.at);
    if (!run) continue;
    const value = displayDeletedText(change.value);
    if (!value) continue;
    const events = deletions.get(run.node) ?? [];
    events.push({ at: Math.max(0, Math.min(run.node.length, change.at - run.from)), value });
    deletions.set(run.node, events);
  }

  for (const run of textRuns) {
    const ranges = insertions
      .map((change) => ({ from: Math.max(0, change.from - run.from), to: Math.min(run.node.length, change.to - run.from) }))
      .filter((range) => range.from < range.to);
    const events = deletions.get(run.node) ?? [];
    if (!ranges.length && !events.length) continue;
    decorateTextRun(run.node, ranges, events);
  }
}

export function displayDeletedText(value: string): string {
  return value.replaceAll('\uFFFC', '').replace(/\r?\n/g, ' ↵ ');
}

function renderedText(root: HTMLElement): { readonly value: string; readonly runs: readonly RenderedTextRun[] } {
  let value = '';
  const runs: RenderedTextRun[] = [];
  const ownerWindow = root.ownerDocument.defaultView;
  const append = (text: string, node?: Text) => {
    if (!text) return;
    const from = value.length;
    value += text;
    runs.push({ from, to: value.length, ...(node ? { node } : {}) });
  };
  const visit = (node: Node) => {
    if (node.nodeType === 3) { append(node.nodeValue ?? '', node as Text); return; }
    if (!ownerWindow || !(node instanceof ownerWindow.HTMLElement)) return;
    if (node.matches(ATOMIC_SELECTOR)) { append('\uFFFC'); return; }
    node.childNodes.forEach(visit);
  };
  root.childNodes.forEach((node) => { visit(node); append('\n'); });
  return { value, runs };
}

function textRunAt(runs: readonly (RenderedTextRun & { readonly node: Text })[], offset: number): (RenderedTextRun & { readonly node: Text }) | undefined {
  return runs.find((run) => offset >= run.from && offset < run.to)
    ?? runs.find((run) => run.from > offset)
    ?? runs.at(-1);
}

function decorateTextRun(node: Text, insertions: readonly { from: number; to: number }[], deletions: readonly { at: number; value: string }[]) {
  const ownerDocument = node.ownerDocument;
  const fragment = ownerDocument.createDocumentFragment();
  const points = new Set([0, node.length]);
  insertions.forEach(({ from, to }) => { points.add(from); points.add(to); });
  deletions.forEach(({ at }) => points.add(at));
  const ordered = [...points].sort((left, right) => left - right);

  for (let index = 0; index < ordered.length; index += 1) {
    const from = ordered[index]!;
    for (const deletion of deletions.filter((event) => event.at === from)) {
      const element = ownerDocument.createElement('del');
      element.className = 'render-track-delete';
      element.title = 'Deleted text';
      element.textContent = deletion.value;
      fragment.append(element);
    }
    const to = ordered[index + 1];
    if (to === undefined || from === to) continue;
    const text = node.data.slice(from, to);
    if (insertions.some((range) => from >= range.from && to <= range.to)) {
      const element = ownerDocument.createElement('ins');
      element.className = 'render-track-insert';
      element.title = 'Added text';
      element.textContent = text;
      fragment.append(element);
    } else fragment.append(text);
  }
  node.replaceWith(fragment);
}
