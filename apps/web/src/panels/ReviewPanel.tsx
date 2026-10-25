import { memo } from 'react';
import { GitCompare } from 'lucide-react';
import type { ReviewDraft } from '@markroot/review';

interface Props {
  draft: ReviewDraft | undefined;
  activeChangeId: string | undefined;
  attributionBusy: boolean;
  onSelect(id: string): void;
  onDecide(id: string, decision: 'accept' | 'reject'): void;
  onDecideAll(decision: 'accept' | 'reject'): void;
  onApply(): void | Promise<void>;
}

export const ReviewPanel = memo(function ReviewPanel({ draft, activeChangeId, attributionBusy, onSelect, onDecide, onDecideAll, onApply }: Props) {
  if (!draft) return <div className="panel-empty"><GitCompare size={24}/><p>No branch comparison is open.</p></div>;
  const pending = draft.changes.filter((change) => change.decision === 'pending').length;
  const activeIndex = Math.max(0, draft.changes.findIndex((change) => change.id === activeChangeId));
  const active = draft.changes[activeIndex]!;
  const selectOffset = (offset: number) => onSelect(draft.changes[(activeIndex + offset + draft.changes.length) % draft.changes.length]!.id);
  const author = active.authors.map((identity) => identity.displayName).join(', ') || (attributionBusy ? 'Finding author…' : 'Unknown author');
  return <div className="inspector-body review-controls">
    <p>{draft.changes.length} tracked change(s) are shown directly in the Source and Rendered text. The selected change is bold, and each decision updates the text immediately.</p>
    <div className="review-legend"><span><i className="insert"/>Compared branch</span><span><i className="delete"/>Current branch</span></div>
    <div className="review-navigator"><button onClick={() => selectOffset(-1)} aria-label="Previous tracked change">←</button><strong>Change {activeIndex + 1} of {draft.changes.length}</strong><button onClick={() => selectOffset(1)} aria-label="Next tracked change">→</button></div>
    <p className="review-author">{author} · {active.decision === 'pending' ? 'Needs decision' : active.decision === 'accept' ? 'Compared branch accepted' : 'Current branch retained'}</p>
    <div className="review-decision"><button className={active.decision === 'accept' ? 'selected' : ''} aria-pressed={active.decision === 'accept'} onClick={() => onDecide(active.id, 'accept')}>Accept change</button><button className={active.decision === 'reject' ? 'selected reject' : ''} aria-pressed={active.decision === 'reject'} onClick={() => onDecide(active.id, 'reject')}>Reject change</button></div>
    <div className="review-bulk"><button onClick={() => onDecideAll('accept')}>Accept all</button><button onClick={() => onDecideAll('reject')}>Reject all</button></div>
    <button className="primary wide" disabled={pending > 0} onClick={onApply}>Apply reviewed result</button>
    {pending > 0 && <p className="microcopy">{pending} change(s) still need a decision.</p>}
  </div>;
});
