import { memo } from 'react';
import { MessageSquare, X } from 'lucide-react';
import type { SourceRange } from '@markroot/core';
import type { locateComments } from '@markroot/comments';

interface Props {
  busy: boolean;
  parsed: ReturnType<typeof locateComments> | undefined;
  activeId: string | undefined;
  selection: SourceRange;
  body: string;
  setBody(value: string): void;
  replies: Record<string, string>;
  setReplies(value: Record<string, string>): void;
  onAdd(): void;
  onNavigate(id: string): void;
  onRepair(id: string): void;
  onReply(id: string): void;
  onStatus(id: string, status: 'open' | 'resolved'): void;
  onDelete(id: string): void;
}

export const CommentsPanel = memo(function CommentsPanel({ busy, parsed, activeId, selection, body, setBody, replies, setReplies, onAdd, onNavigate, onRepair, onReply, onStatus, onDelete }: Props) {
  return <fieldset disabled={busy} className="inspector-body" style={{ border: 0, margin: 0, minWidth: 0 }}><div className="selection-chip">Selected range: {selection.from}–{selection.to}</div><label className="field"><span>New comment</span><textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Add a precise note…" rows={3}/></label><button className="primary wide" disabled={selection.to <= selection.from || !body.trim()} onClick={onAdd}><MessageSquare size={15}/>Add comment</button><div className="thread-list">{parsed?.threads.map((thread) => { const orphan = parsed.orphans.includes(thread.id); return <article key={thread.id} className={`${thread.status === 'resolved' ? 'resolved' : ''}${thread.id === activeId ? ' active' : ''}`}><header><button onClick={() => onNavigate(thread.id)}>{orphan ? 'detached' : parsed.needsReview?.includes(thread.id) ? 'needs review' : thread.status}</button>{orphan && <button disabled={selection.to <= selection.from} onClick={() => onRepair(thread.id)}>Attach to selection</button>}<button onClick={() => onStatus(thread.id, thread.status === 'open' ? 'resolved' : 'open')}>{thread.status === 'open' ? 'Resolve' : 'Reopen'}</button><button onClick={() => onDelete(thread.id)} title="Delete thread" aria-label="Delete comment thread"><X size={13}/></button></header>{thread.messages.map((message) => <div className="message" key={message.id}><strong>{message.author.displayName}</strong><p>{message.body}</p><time>{new Date(message.createdAt).toLocaleString()}</time></div>)}<div className="reply"><input aria-label="Reply" value={replies[thread.id] ?? ''} onChange={(event) => setReplies({ ...replies, [thread.id]: event.target.value })} placeholder="Reply…"/><button onClick={() => onReply(thread.id)}>Send</button></div></article>; })}</div>{parsed?.orphans.length ? <p className="warning">{parsed.orphans.length} thread(s) are detached. Select their passage and choose Attach to selection.</p> : null}</fieldset>;
});
