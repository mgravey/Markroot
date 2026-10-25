import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Code2, GitFork, Pencil, RotateCcw, Star, Undo2, Redo2 } from 'lucide-react';
import type { UndoTree } from '@markroot/history';

interface Props {
  tree: UndoTree | undefined;
  ready: boolean;
  selectedId: string | undefined;
  compareId: string | undefined;
  onSelect(id: string): void;
  onCompare(id: string): void;
  onCheckout(id: string): void;
  onStar(id: string): void;
  onClose(): void;
  onUndo(): void;
  onRedo(): void;
}
export function HistoryPanel({ tree, ready, selectedId, compareId, onSelect, onCompare, onCheckout, onStar, onClose, onUndo, onRedo }: Props) {
  const [comparing, setComparing] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 30000); return () => clearInterval(timer); }, []);
  if (!tree) return <div className="panel-empty"><GitFork size={24}/><p>Open a document to keep its modification tree.</p></div>;
  const currentPath = new Set(tree.path());
  const rows: { id: string; depth: number }[] = [];
  const pending = [{ id: tree.rootId, depth: 1 }];
  while (pending.length) { const row = pending.pop()!; rows.push(row); for (const child of [...tree.get(row.id).children].reverse()) pending.push({ id: child, depth: row.depth + 1 }); }
  const branch = tree.branchPosition();
  const focus = (id: string) => host.current?.querySelector<HTMLButtonElement>(`[data-history-id="${id}"]`)?.focus();
  const handleKeys = (event: KeyboardEvent, id: string) => {
    const index = rows.findIndex((row) => row.id === id); const node = tree.get(id);
    let target: string | undefined;
    if (event.key === 'ArrowDown') target = rows[Math.min(rows.length - 1, index + 1)]?.id;
    else if (event.key === 'ArrowUp') target = rows[Math.max(0, index - 1)]?.id;
    else if (event.key === 'ArrowLeft') target = node.parentId ?? undefined;
    else if (event.key === 'ArrowRight') target = node.lastActiveChild ?? node.children[0];
    else if (event.key === 'Home') target = rows[0]?.id;
    else if (event.key === 'End') target = rows.at(-1)?.id;
    if (target) { event.preventDefault(); focus(target); }
  };
  const choose = (id: string) => { if (comparing && selectedId) { onCompare(id); setComparing(false); } else onSelect(id); };
  return <div className="inspector-body history-panel">
    <div className="history-toolbar"><strong>Branch {branch.index} of {branch.count}</strong><span className="spacer"/><button disabled={!ready} onClick={onUndo} aria-label="Undo document edit"><Undo2 size={15}/></button><button disabled={!ready} onClick={onRedo} aria-label="Redo document edit"><Redo2 size={15}/></button></div>
    <p className="microcopy">{ready ? `${tree.size} versions · browser-local only` : 'Restoring local history…'}</p>
    {selectedId && <div className="history-preview-controls">
      <strong>Read-only comparison</strong><p className="microcopy">{compareId ? `Comparing ${compareId} → ${selectedId}` : 'Selected version compared with your current text. Additions and deletions appear in Source and Rendered.'}</p>
      <button className="primary wide" disabled={!ready || selectedId === tree.currentId} onClick={() => onCheckout(selectedId)}>Switch to this version</button>
      <div className="history-toolbar"><button onClick={() => setComparing((value) => !value)} aria-pressed={comparing}>Compare with…</button><button onClick={() => onStar(selectedId)} aria-pressed={Boolean(tree.get(selectedId).starred)}><Star size={13}/>{tree.get(selectedId).starred ? 'Unstar' : 'Star'}</button></div>
      {comparing && <p className="microcopy" role="status">Choose a second version in the tree.</p>}
      <button className="wide" onClick={() => { setComparing(false); onClose(); }}>Close preview</button>
    </div>}
    <div ref={host} role="tree" aria-label="Document modification tree" className="history-tree">
      {rows.map(({ id, depth }) => {
        const node = tree.get(id); const peers = node.parentId ? tree.get(node.parentId).children : [id];
        const inserted = node.changes.reduce((sum, edit) => sum + edit.insert.length, 0); const deleted = node.changes.reduce((sum, edit) => sum + edit.to - edit.from, 0);
        const Icon = node.children.length > 1 ? GitFork : node.origin === 'source' ? Code2 : node.origin === 'visual' ? Pencil : RotateCcw;
        return <button key={id} role="treeitem" data-history-id={id} aria-expanded={node.children.length ? true : undefined} aria-level={depth} aria-posinset={peers.indexOf(id) + 1} aria-setsize={peers.length} aria-current={id === tree.currentId ? 'true' : undefined} aria-selected={selectedId === id} tabIndex={id === (selectedId ?? tree.currentId) ? 0 : -1} className={`history-node${currentPath.has(id) ? ' on-path' : ''}${id === tree.currentId ? ' current' : ''}${selectedId === id ? ' selected' : ''}`} style={{ paddingInlineStart: `${8 + Math.min(depth - 1, 12) * 10}px` }} onKeyDown={(event) => handleKeys(event, id)} onClick={() => choose(id)} title={`${node.label} · ${new Date(node.createdAt).toLocaleString()} · ${id}`}>
          <Icon size={13}/><span className="history-node-label">{node.label}<small>{relativeTime(clock, node.createdAt)} · {node.origin}</small></span>{node.starred && <Star size={11} fill="currentColor"/>}<span className="history-counts"><span>+{inserted}</span><span>−{deleted}</span></span>
        </button>;
      })}
    </div>
  </div>;
}
function relativeTime(now: number, time: number): string { const seconds = Math.max(0, Math.floor((now - time) / 1000)); return seconds < 60 ? 'just now' : seconds < 3600 ? `${Math.floor(seconds / 60)} min ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)} h ago` : `${Math.floor(seconds / 86400)} d ago`; }
