import { useEffect, useRef } from 'react';
import { Check, RefreshCw, Sparkles, X } from 'lucide-react';
import type { CommitGenerationProgress, CommitProposal } from '../commit-message.js';

interface Props {
  phase: 'preparing' | 'ready' | 'committing';
  progress?: CommitGenerationProgress | undefined;
  proposal?: CommitProposal | undefined;
  fileCount: number;
  onProposalChange(proposal: CommitProposal): void;
  onAccept(): void;
  onRegenerate(): void;
  onCancel(): void;
}

export function CommitProposalDialog({ phase, progress, proposal, fileCount, onProposalChange, onAccept, onRegenerate, onCancel }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const subject = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);

  useEffect(() => { if (phase === 'ready') subject.current?.focus(); }, [phase]);

  const busy = phase !== 'ready';
  const loaded = progress?.loaded;
  const downloading = progress?.phase === 'downloading';
  return <dialog ref={dialog} className="commit-dialog" aria-labelledby="commit-dialog-title" onCancel={(event) => { event.preventDefault(); if (phase !== 'committing') onCancel(); }}>
    <header>
      <span className="commit-dialog-icon"><Sparkles size={18}/></span>
      <div><h2 id="commit-dialog-title">AI commit proposal</h2><p>Chrome on-device AI · {fileCount || '…'} candidate file{fileCount === 1 ? '' : 's'}</p></div>
      <button className="dialog-close" disabled={phase === 'committing'} onClick={onCancel} aria-label="Cancel commit proposal"><X size={17}/></button>
    </header>
    {phase !== 'ready' ? <section className="commit-dialog-progress" aria-live="polite">
      <RefreshCw className="spin" size={21}/>
      <strong>{phase === 'committing' ? 'Creating local commit' : progress?.message ?? 'Preparing local AI'}</strong>
      {downloading && <div className={`commit-download-track ${typeof loaded !== 'number' || loaded === 0 ? 'indeterminate' : ''}`} role="progressbar" aria-label="Chrome AI model download" aria-valuemin={0} aria-valuemax={100} {...(typeof loaded === 'number' && loaded > 0 ? { 'aria-valuenow': Math.round(loaded * 100) } : {})}><span style={typeof loaded === 'number' && loaded > 0 ? { width: `${Math.round(loaded * 100)}%` } : undefined}/></div>}
      <p>The file is already saved. Chrome manages model downloads outside this tab’s normal Network requests. Cancelling will not create a commit.</p>
    </section> : <section className="commit-dialog-form">
      <p className="ai-review-note">Review or edit the generated message before committing.</p>
      <label className="field"><span>Subject</span><input ref={subject} value={proposal?.subject ?? ''} onChange={(event) => onProposalChange({ subject: event.target.value, body: proposal?.body ?? '' })}/></label>
      <label className="field"><span>Body <small>optional</small></span><textarea rows={5} value={proposal?.body ?? ''} onChange={(event) => onProposalChange({ subject: proposal?.subject ?? '', body: event.target.value })}/></label>
    </section>}
    <footer>
      <button onClick={onCancel} disabled={phase === 'committing'}>Cancel</button>
      {phase === 'ready' && <button onClick={onRegenerate}><RefreshCw size={14}/>Regenerate</button>}
      <button className="primary" disabled={phase !== 'ready' || !proposal?.subject.trim()} onClick={onAccept}><Check size={15}/>Accept &amp; Commit</button>
    </footer>
  </dialog>;
}
