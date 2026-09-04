import { useMemo, useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronRight, Copy, File, FileCode2, Folder, FolderOpen, Image as ImageIcon } from 'lucide-react';
import type { WorkspacePath } from '@markroot/core';
import type { GitFileStatus } from '@markroot/git';
import type { WorkspaceEntry } from '@markroot/workspace';

interface Props {
  entries: readonly WorkspaceEntry[];
  activePath?: WorkspacePath | undefined;
  gitStatus: readonly GitFileStatus[];
  onOpen(path: WorkspacePath): void;
  onCopy(path: WorkspacePath): void;
}

export interface TreeNode extends WorkspaceEntry {
  readonly name: string;
  readonly children: readonly TreeNode[];
  readonly containsMarkdown: boolean;
}

export function WorkspaceTree({ entries, activePath, gitStatus, onOpen, onCopy }: Props) {
  const roots = useMemo(() => buildTree(entries), [entries]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const changed = useMemo(() => new Set(gitStatus.filter((status) => status.state !== 'unmodified').map((status) => status.path)), [gitStatus]);
  return <nav className="file-tree" aria-label="Workspace files">
    <ul>{roots.map((node) => <TreeItem key={node.path} node={node} depth={0} activePath={activePath} expanded={expanded} changed={changed} onOpen={onOpen} onCopy={onCopy} onToggle={(path) => setExpanded((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; })}/>)}</ul>
  </nav>;
}

function TreeItem({ node, depth, activePath, expanded, changed, onOpen, onCopy, onToggle }: {
  node: TreeNode;
  depth: number;
  activePath?: WorkspacePath | undefined;
  expanded: ReadonlySet<string>;
  changed: ReadonlySet<string>;
  onOpen(path: WorkspacePath): void;
  onCopy(path: WorkspacePath): void;
  onToggle(path: WorkspacePath): void;
}) {
  const open = node.kind === 'directory' && expanded.has(node.path);
  const modified = changed.has(node.path) || (node.kind === 'directory' && [...changed].some((path) => path.startsWith(`${node.path}/`)));
  const editable = node.kind === 'file' && isTextFile(node.path);
  const markdownDocument = node.kind === 'file' && isMarkdown(node.path);
  const emphasis = markdownDocument ? 'markdown-document' : node.containsMarkdown ? 'markdown-branch' : 'muted';
  const Icon = node.kind === 'directory' ? (open ? FolderOpen : Folder) : isImage(node.path) ? ImageIcon : editable ? FileCode2 : File;
  return <li>
    <div className={`tree-row ${emphasis} ${activePath === node.path ? 'active' : ''}`} style={{ '--tree-depth': depth } as CSSProperties}>
      {node.kind === 'directory'
        ? <button className="tree-main" onClick={() => onToggle(node.path)} aria-expanded={open} title={node.path}><span className="tree-chevron">{open ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</span><Icon size={15}/><span>{node.name}</span>{modified && <i/>}</button>
        : <button className="tree-main" disabled={!editable} onClick={() => editable && onOpen(node.path)} title={editable ? node.path : `${node.path} — copy its path to reference it`}><span className="tree-chevron"/><Icon size={15}/><span>{node.name}</span>{modified && <i/>}</button>}
      <button className="tree-copy" onClick={() => onCopy(node.path)} title={`Copy ${node.kind} path`} aria-label={`Copy path ${node.path}`}><Copy size={13}/></button>
    </div>
    {open && node.children.length > 0 && <ul>{node.children.map((child) => <TreeItem key={child.path} node={child} depth={depth + 1} activePath={activePath} expanded={expanded} changed={changed} onOpen={onOpen} onCopy={onCopy} onToggle={onToggle}/>)}</ul>}
  </li>;
}

export function buildTree(entries: readonly WorkspaceEntry[]): readonly TreeNode[] {
  const children = new Map<string, WorkspaceEntry[]>();
  for (const entry of entries) {
    const slash = entry.path.lastIndexOf('/');
    const parent = slash < 0 ? '' : entry.path.slice(0, slash);
    const list = children.get(parent) ?? [];
    list.push(entry);
    children.set(parent, list);
  }
  const visit = (parent: string): readonly TreeNode[] => (children.get(parent) ?? [])
    .sort((a, b) => Number(a.kind === 'file') - Number(b.kind === 'file') || a.path.localeCompare(b.path))
    .map((entry) => {
      const nested = entry.kind === 'directory' ? visit(entry.path) : [];
      return {
        ...entry,
        name: entry.path.split('/').at(-1)!,
        children: nested,
        containsMarkdown: entry.kind === 'file' ? isMarkdown(entry.path) : nested.some((child) => child.containsMarkdown),
      };
    });
  return visit('');
}

function isImage(path: string): boolean { return /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(path); }
function isMarkdown(path: string): boolean { return /\.(?:md|qmd)$/i.test(path); }
function isTextFile(path: string): boolean { return /\.(?:bib|bibtex|csl|css|csv|html?|js|json|jsx|md|mjs|qmd|scss|toml|ts|tsx|txt|ya?ml)$/i.test(path); }
