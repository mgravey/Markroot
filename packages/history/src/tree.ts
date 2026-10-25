/** Offsets are UTF-16 code units, matching DocumentSession and CodeMirror. */
export interface HistoryEdit { readonly from: number; readonly to: number; readonly insert: string }
export type HistoryOrigin = 'source' | 'visual' | 'review' | 'external' | 'restore' | 'comment' | 'system' | (string & {});
export interface HistoryNode {
  id: string;
  parentId: string | null;
  children: string[];
  createdAt: number;
  updatedAt: number;
  origin: HistoryOrigin;
  label: string;
  changes: HistoryEdit[];
  inverse: HistoryEdit[];
  hash: string;
  checkpoint?: string;
  lastActiveChild?: string;
  starred?: boolean;
}
export interface HistoryJSON { version: 1; rootId: string; currentId: string; sequence: number; nodes: HistoryNode[] }
export interface HistoryOptions { groupDelay?: number; checkpointEvery?: number; checkpointBytes?: number; maxNodes?: number; maxBytes?: number }
const defaults = { groupDelay: 800, checkpointEvery: 40, checkpointBytes: 64 * 1024, maxNodes: 2000, maxBytes: 5 * 1024 * 1024 };
export const HISTORY_MAX_BYTES = defaults.maxBytes;

export function contentHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

/** One compact replacement; common prefix/suffix remain untouched, including CRLF. */
export function textEdit(before: string, after: string): HistoryEdit {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from += 1;
  let to = before.length;
  let end = after.length;
  while (to > from && end > from && before[to - 1] === after[end - 1]) { to -= 1; end -= 1; }
  return { from, to, insert: after.slice(from, end) };
}

export function applyHistoryEdits(text: string, edits: readonly HistoryEdit[]): string {
  for (const edit of edits) {
    if (!Number.isInteger(edit.from) || !Number.isInteger(edit.to) || edit.from < 0 || edit.to < edit.from || edit.to > text.length || typeof edit.insert !== 'string') throw new Error('Invalid history edit.');
    text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  }
  return text;
}

// Include JSON escaping and spare space for keys, numbers and separators.
function stringBytes(text: string): number {
  let bytes = 4 + text.length * 2;
  for (const match of text.matchAll(/["\\\u0000-\u001f\ud800-\udfff]/g)) bytes += match[0] === '"' || match[0] === '\\' ? 2 : 10;
  return bytes;
}
function editBytes(edits: readonly HistoryEdit[]): number { return edits.reduce((bytes, edit) => bytes + 128 + stringBytes(edit.insert), 0); }

export class UndoTree {
  private nodes = new Map<string, HistoryNode>();
  private sequence = 0;
  private bytes = 256;
  private nodeBytes = new Map<string, number>();
  private currentText: string;
  private textId: string | undefined;
  private groupable = false;
  private previousEdit: HistoryEdit | undefined;
  private options: typeof defaults;
  readonly rootId: string;
  currentId: string;

  constructor(text: string, options: HistoryOptions = {}, time = Date.now()) {
    this.options = { ...defaults, ...options };
    this.rootId = 'h0'; this.currentId = this.rootId; this.currentText = text; this.textId = this.currentId;
    this.nodes.set(this.rootId, { id: this.rootId, parentId: null, children: [], createdAt: time, updatedAt: time, origin: 'restore', label: 'Opened document', changes: [], inverse: [], hash: contentHash(text), checkpoint: text });
    this.measure(this.nodes.get(this.rootId)!);
  }
  get current(): Readonly<HistoryNode> { return this.get(this.currentId); }
  get size(): number { return this.nodes.size; }
  get allNodes(): readonly Readonly<HistoryNode>[] { return [...this.nodes.values()]; }
  get text(): string { if (this.textId !== this.currentId) { this.currentText = this.textAt(this.currentId); this.textId = this.currentId; } return this.currentText; }
  private measure(node: HistoryNode): void {
    const bytes = 512 + [node.id, node.parentId ?? '', node.origin, node.label, node.hash, node.checkpoint ?? '', node.lastActiveChild ?? '', ...node.children].reduce((sum, text) => sum + stringBytes(text), 0) + editBytes(node.changes) + editBytes(node.inverse);
    this.bytes += bytes - (this.nodeBytes.get(node.id) ?? 0); this.nodeBytes.set(node.id, bytes);
  }
  private remove(id: string): void { this.bytes -= this.nodeBytes.get(id)!; this.nodeBytes.delete(id); this.nodes.delete(id); }
  private checkpoint(node: HistoryNode, text?: string): void {
    if (node.checkpoint !== undefined) return;
    let distance = 1; let bytes = editBytes(node.changes) + editBytes(node.inverse);
    for (let ancestor = this.nodes.get(node.parentId!)!; ancestor.checkpoint === undefined && ancestor.parentId; ancestor = this.nodes.get(ancestor.parentId)!) { distance += 1; bytes += editBytes(ancestor.changes) + editBytes(ancestor.inverse); }
    if (distance >= this.options.checkpointEvery || bytes >= this.options.checkpointBytes) node.checkpoint = text ?? this.textAt(node.id);
  }
  get(id: string): Readonly<HistoryNode> { const node = this.nodes.get(id); if (!node) throw new Error('Unknown history version.'); return node; }
  path(id = this.currentId): string[] {
    const path: string[] = [];
    for (let node: Readonly<HistoryNode> | undefined = this.get(id); node; node = node.parentId ? this.get(node.parentId) : undefined) path.push(node.id);
    return path.reverse();
  }
  textAt(id: string): string {
    const chain: Readonly<HistoryNode>[] = [];
    let node = this.get(id);
    while (node.checkpoint === undefined) { chain.push(node); if (!node.parentId) throw new Error('Missing history checkpoint.'); node = this.get(node.parentId); }
    let text = node.checkpoint;
    for (const step of chain.reverse()) text = applyHistoryEdits(text, step.changes);
    return text;
  }
  record(edit: HistoryEdit | readonly HistoryEdit[], metadata: { origin: HistoryOrigin; time?: number; label?: string }): string {
    const before = this.text;
    const after = applyHistoryEdits(before, Array.isArray(edit) ? edit : [edit as HistoryEdit]);
    if (before === after) return this.currentId;
    const change = textEdit(before, after);
    const time = metadata.time ?? Date.now();
    const node = this.nodes.get(this.currentId)!;
    const previous = this.previousEdit;
    const adjacent = previous && change.from <= previous.from + previous.insert.length && change.to >= previous.from;
    const merge = this.groupable && previous && adjacent && !node.starred && !node.children.length && node.parentId !== null && node.origin === metadata.origin && ['source', 'visual'].includes(node.origin) && time >= node.updatedAt && time - node.updatedAt <= this.options.groupDelay;
    if (merge) {
      const parentText = applyHistoryEdits(before, node.inverse);
      node.changes = [textEdit(parentText, after)]; node.inverse = [textEdit(after, parentText)];
      node.hash = contentHash(after); node.updatedAt = time;
      if (node.checkpoint !== undefined) node.checkpoint = after; else this.checkpoint(node, after);
    } else {
      const id = `h${++this.sequence}`;
      const next: HistoryNode = { id, parentId: node.id, children: [], createdAt: time, updatedAt: time, origin: metadata.origin, label: metadata.label ?? `${metadata.origin} edit`, changes: [change], inverse: [textEdit(after, before)], hash: contentHash(after) };
      node.children.push(id); node.lastActiveChild = id; this.nodes.set(id, next); this.currentId = id;
      if (metadata.origin === 'external') next.checkpoint = after; else this.checkpoint(next, after);
      this.measure(next);
    }
    this.measure(node); this.currentText = after; this.textId = this.currentId;
    this.groupable = true; this.previousEdit = change; this.prune();
    return this.currentId;
  }
  undo(): HistoryEdit[] { return this.current.parentId ? this.checkout(this.current.parentId) : []; }
  redo(): HistoryEdit[] { const node = this.current; const child = node.lastActiveChild ?? node.children.at(-1); return child ? this.checkout(child) : []; }
  siblings(): readonly Readonly<HistoryNode>[] { return this.current.parentId ? this.get(this.current.parentId).children.map((id) => this.get(id)) : [this.current]; }
  nextBranch(): HistoryEdit[] { return this.branch(1); }
  prevBranch(): HistoryEdit[] { return this.branch(-1); }
  /** Branch at the nearest fork on the current path; useful while typing beyond a fork. */
  branchPosition(): { index: number; count: number } {
    const id = this.forkChild(); const node = this.get(id); const siblings = node.parentId ? this.get(node.parentId).children : [id];
    return { index: siblings.indexOf(id) + 1, count: siblings.length };
  }
  private forkChild(): string { return this.path().slice(1).reverse().find((id) => this.get(this.get(id).parentId!).children.length > 1) ?? this.currentId; }
  private branch(offset: number): HistoryEdit[] {
    const id = this.forkChild(); const parent = this.get(id).parentId;
    if (!parent) return [];
    const children = this.get(parent).children;
    if (children.length < 2) return [];
    let target = this.get(children[(children.indexOf(id) + offset + children.length) % children.length]!);
    while (target.lastActiveChild) target = this.get(target.lastActiveChild);
    return this.checkout(target.id);
  }
  /** Sequential edits through the common ancestor, suitable for replay without diffing. */
  checkout(id: string): HistoryEdit[] {
    const targetPath = this.path(id); const currentPath = this.path();
    let common = 0;
    while (common < targetPath.length && currentPath[common] === targetPath[common]) common += 1;
    const edits: HistoryEdit[] = [];
    for (const step of currentPath.slice(common).reverse()) { const node = this.get(step); edits.push(...node.inverse); const parent = this.nodes.get(node.parentId!)!; parent.lastActiveChild = step; this.measure(parent); }
    for (const step of targetPath.slice(common)) { const node = this.get(step); edits.push(...node.changes); const parent = this.nodes.get(node.parentId!)!; parent.lastActiveChild = step; this.measure(parent); }
    this.currentId = id; this.textId = undefined; this.groupable = false; this.previousEdit = undefined;
    return edits;
  }
  attachExternal(text: string): string {
    const hash = contentHash(text);
    // Verify text as well: a cheap hash is an index hint, never proof of equality.
    const match = [this.nodes.get(this.currentId)!, ...[...this.nodes.values()].reverse()].find((node) => node.hash === hash && this.textAt(node.id) === text);
    if (match) this.checkout(match.id);
    else { this.groupable = false; this.record(textEdit(this.text, text), { origin: 'external', label: 'Changed outside Markroot' }); this.groupable = false; }
    return this.currentId;
  }
  star(id: string, value = !this.get(id).starred): void { const node = this.nodes.get(id)!; node.starred = value; this.measure(node); this.groupable = false; }
  toJSON(): HistoryJSON { return { version: 1, rootId: this.rootId, currentId: this.currentId, sequence: this.sequence, nodes: structuredClone([...this.nodes.values()]) }; }
  static fromJSON(value: unknown, options: HistoryOptions = {}): UndoTree {
    if (!value || typeof value !== 'object') throw new Error('Invalid history.');
    const data = value as HistoryJSON;
    if (data.version !== 1 || !Array.isArray(data.nodes) || !data.nodes.length || data.nodes.length > 10000 || JSON.stringify(value).length * 2 > (options.maxBytes ?? defaults.maxBytes) * 2) throw new Error('Unsupported or oversized history.');
    if (data.rootId !== 'h0' || !Number.isSafeInteger(data.sequence) || data.sequence < 0) throw new Error('Invalid history root.');
    const tree = new UndoTree('', options); tree.nodes.clear(); tree.nodeBytes.clear(); tree.bytes = 256; tree.textId = undefined; tree.sequence = data.sequence;
    for (const node of structuredClone(data.nodes)) {
      if (!node || typeof node.id !== 'string' || !/^h\d+$/.test(node.id) || Number(node.id.slice(1)) > data.sequence || tree.nodes.has(node.id) || !Array.isArray(node.children) || !Array.isArray(node.changes) || !Array.isArray(node.inverse) || typeof node.label !== 'string' || typeof node.origin !== 'string' || !Number.isFinite(node.createdAt) || !Number.isFinite(node.updatedAt) || (node.checkpoint !== undefined && typeof node.checkpoint !== 'string')) throw new Error('Invalid history node.');
      tree.nodes.set(node.id, node); tree.measure(node);
    }
    if (tree.get(tree.rootId).parentId !== null || tree.get(tree.rootId).checkpoint === undefined) throw new Error('Missing history root.');
    const visited = new Set<string>(); const pending = [tree.rootId];
    while (pending.length) {
      const node = tree.get(pending.pop()!);
      if (visited.has(node.id)) throw new Error('Cyclic history.');
      visited.add(node.id);
      if (node.lastActiveChild && !node.children.includes(node.lastActiveChild)) throw new Error('Invalid active branch.');
      for (const child of node.children) { if (tree.get(child).parentId !== node.id) throw new Error('Invalid history parent.'); pending.push(child); }
      const text = node.parentId ? applyHistoryEdits(tree.textAt(node.parentId), node.changes) : node.checkpoint!;
      if (contentHash(text) !== node.hash || (node.checkpoint !== undefined && node.checkpoint !== text) || (node.parentId && applyHistoryEdits(text, node.inverse) !== tree.textAt(node.parentId))) throw new Error('Corrupt history text.');
    }
    if (visited.size !== tree.size || !visited.has(data.currentId)) throw new Error('Detached history node.');
    tree.currentId = data.currentId; tree.prune(); return tree;
  }
  private compact(node: HistoryNode, cached?: { id: string; text: string }): { id: string; text: string } {
    const child = this.nodes.get(node.children[0]!)!; const parent = this.nodes.get(node.parentId!)!;
    const childText = child.checkpoint ?? applyHistoryEdits(cached?.id === node.id ? cached.text : this.textAt(node.id), child.changes);
    child.parentId = parent.id; child.changes = [...node.changes, ...child.changes]; child.inverse = [...child.inverse, ...node.inverse];
    const bytes = editBytes(child.changes) + editBytes(child.inverse);
    if (bytes > childText.length * 4 + 256) {
      const parentText = this.textAt(parent.id); const changes = [textEdit(parentText, childText)]; const inverse = [textEdit(childText, parentText)];
      if (editBytes(changes) + editBytes(inverse) < bytes) { child.changes = changes; child.inverse = inverse; }
    }
    parent.children = parent.children.map((id) => id === node.id ? child.id : id);
    if (parent.lastActiveChild === node.id) parent.lastActiveChild = child.id;
    this.remove(node.id); this.measure(parent);
    const pending = [child];
    while (pending.length) {
      const next = pending.pop()!;
      this.checkpoint(next, next === child ? childText : undefined); this.measure(next);
      if (next.checkpoint === undefined) for (const id of next.children) pending.push(this.nodes.get(id)!);
    }
    return { id: child.id, text: childText };
  }
  /** Leaf pruning protects ancestry; linear compaction retains exact current and starred versions. */
  prune(): void {
    const over = () => this.size > this.options.maxNodes || this.bytes > this.options.maxBytes;
    if (!over()) return;
    let compacted: { id: string; text: string } | undefined;
    const protectedIds = new Set(this.path());
    for (const node of this.nodes.values()) if (node.starred) for (const id of this.path(node.id)) protectedIds.add(id);
    for (const node of [...this.nodes.values()]) {
      if (!over()) break;
      if (protectedIds.has(node.id) || !node.parentId || node.children.length !== 1) continue;
      compacted = this.compact(node, compacted);
    }
    const oldest = [...this.nodes.values()].sort((a, b) => a.createdAt - b.createdAt);
    while (over()) {
      const leaf = oldest.find((node) => this.nodes.has(node.id) && !protectedIds.has(node.id) && !node.children.length);
      if (!leaf) {
        // Fold the oldest unstarred step, retaining root, forks and current.
        const step = oldest.find((node) => this.nodes.has(node.id) && node.id !== this.currentId && node.parentId && !node.starred && node.children.length === 1);
        if (!step) break; // Pinned/forked data can exceed the soft cap.
        compacted = this.compact(step, compacted); continue;
      }
      const parent = this.nodes.get(leaf.parentId!)!; parent.children = parent.children.filter((id) => id !== leaf.id);
      if (parent.lastActiveChild === leaf.id) { delete parent.lastActiveChild; if (parent.children.length) parent.lastActiveChild = parent.children.at(-1)!; }
      this.remove(leaf.id); this.measure(parent);
    }
  }
}
