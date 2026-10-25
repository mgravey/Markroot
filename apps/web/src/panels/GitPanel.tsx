import { memo, useState } from 'react';
import { Check, GitBranch, GitCommitHorizontal, GitCompare, RefreshCw, Undo2, X } from 'lucide-react';
import type { WorkspacePath } from '@markroot/core';
import type { GitCommitSummary, GitFileStatus, IsomorphicGitRepository } from '@markroot/git';

interface Props {
  git: IsomorphicGitRepository | undefined;
  error: string | undefined;
  status: readonly GitFileStatus[];
  branches: readonly string[];
  currentBranch: string | undefined;
  history: readonly GitCommitSummary[];
  dirty: boolean;
  message: string;
  setMessage(value: string): void;
  onStage(path: WorkspacePath, staged: boolean): Promise<void>;
  onCommit(): Promise<void>;
  onRefresh(): Promise<void>;
  onCheckout(ref: string): Promise<void>;
  onCreateBranch(ref: string): Promise<void>;
  onRenameBranch(from: string, to: string): Promise<void>;
  onDeleteBranch(ref: string): Promise<void>;
  onMerge(ref: string): Promise<void>;
  onCompare(ref: string): Promise<void>;
  onError(error: unknown): void;
}

export const GitPanel = memo(function GitPanel({ git, error, status, branches, currentBranch, history, dirty, message, setMessage, onStage, onCommit, onRefresh, onCheckout, onCreateBranch, onRenameBranch, onDeleteBranch, onMerge, onCompare, onError }: Props) {
  const [selectedBranch, setSelectedBranch] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [renamedBranch, setRenamedBranch] = useState('');
  const [diff, setDiff] = useState<{ path: WorkspacePath; text: string }>();
  if (!git) return <div className="panel-empty"><GitBranch size={24}/><p>This folder is not a supported Git repository.</p>{error && <small>{error}</small>}</div>;
  const changed = status.filter((item) => item.state !== 'unmodified');
  const candidates = branches.filter((branch) => branch !== currentBranch);
  const selected = selectedBranch || candidates[0] || '';
  return <div className="inspector-body"><div className="section-label"><span>{currentBranch ? `Branch · ${currentBranch}` : 'Detached HEAD'}</span><button onClick={() => void onRefresh()} title="Refresh Git status" aria-label="Refresh Git status"><RefreshCw size={13}/></button></div><div className="branch-tools"><select aria-label="Branch" value={selected} onChange={(event) => setSelectedBranch(event.target.value)}>{candidates.map((branch) => <option key={branch}>{branch}</option>)}</select><button disabled={!selected || dirty} onClick={() => void onCheckout(selected)}>Checkout</button><button disabled={!selected || dirty} onClick={() => void onCompare(selected)}><GitCompare size={13}/>Compare</button><button disabled={!selected || dirty} onClick={() => void onMerge(selected)}>Merge</button><button disabled={!selected || dirty} onClick={() => void onDeleteBranch(selected)}>Delete</button></div><div className="branch-create"><input aria-label="New branch name" value={newBranch} onChange={(event) => setNewBranch(event.target.value)} placeholder="new-branch"/><button disabled={!newBranch.trim()} onClick={() => { void onCreateBranch(newBranch.trim()); setNewBranch(''); }}>Create</button></div>{currentBranch && <div className="branch-create"><input aria-label={`Rename ${currentBranch}`} value={renamedBranch} onChange={(event) => setRenamedBranch(event.target.value)} placeholder={`rename ${currentBranch}`}/><button disabled={dirty || !renamedBranch.trim() || renamedBranch.trim() === currentBranch} onClick={() => { void onRenameBranch(currentBranch, renamedBranch.trim()); setRenamedBranch(''); }}>Rename</button></div>}<div className="section-label"><span>Changes · {changed.length}</span></div>{dirty && <p className="warning">Save the open document before staging.</p>}<div className="change-list">{changed.map((item) => { const staged = item.state === 'staged' || item.state === 'added'; return <div key={item.path}><span className={`status-code ${item.state}`}>{statusLetter(item.state)}</span><button className="path-button" title={`Show diff for ${item.path}`} onClick={() => void git.diff(item.path).then((text) => setDiff({ path: item.path, text })).catch(onError)}>{item.path}</button><button disabled={dirty} onClick={() => void onStage(item.path, staged)} title={staged ? `Unstage ${item.path}` : `Stage ${item.path}`} aria-label={staged ? `Unstage ${item.path}` : `Stage ${item.path}`}>{staged ? <Undo2 size={13}/> : <Check size={13}/>}</button></div>; })}</div>{diff && <div className="git-diff"><header><span>{diff.path}</span><button onClick={() => setDiff(undefined)} aria-label="Close diff"><X size={12}/></button></header><pre>{diff.text}</pre></div>}<label className="field"><span>Commit message</span><textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={3}/></label><button className="primary wide" disabled={!message.trim() || dirty} onClick={() => void onCommit()}><GitCommitHorizontal size={15}/>Commit staged changes</button><div className="section-label history-label"><span>History</span></div><div className="history-list">{history.slice(0, 8).map((entry) => <div key={entry.oid}><code>{entry.oid.slice(0, 7)}</code><span>{entry.message.split('\n')[0]}</span><small>{entry.author.displayName}</small></div>)}</div><p className="microcopy">Local repository only. Markroot never contacts a remote.</p></div>;
});

function statusLetter(status: GitFileStatus['state']): string { return ({ modified: 'M', added: 'A', deleted: 'D', untracked: 'U', staged: 'S', unmodified: '·' })[status]; }
