import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspacePath } from '@markroot/core';
import type { DocumentSnapshot } from '@markroot/document';
import type { CommentStore } from '@markroot/comments';
import type { GitCommitCandidate, IsomorphicGitRepository } from '@markroot/git';
import type { MarkrootSettings } from '@markroot/settings';
import { ChromeCommitMessageGenerator, type CommitGenerationProgress, type CommitProposal, type PreparedCommitMessageGenerator } from '../commit-message.js';
import type { AiModelSetupState } from '../panels/SettingsPanel.js';
import { useEvent } from './useEvent.js';

export interface CommitDialogState {
  readonly phase: 'preparing' | 'ready' | 'committing';
  readonly progress?: CommitGenerationProgress;
  readonly candidate?: GitCommitCandidate;
  readonly proposal?: CommitProposal;
}

interface Options {
  readonly git: IsomorphicGitRepository | undefined;
  readonly settings: MarkrootSettings;
  readonly updateSettings: (next: MarkrootSettings) => void;
  readonly commentStore: CommentStore | undefined;
  readonly saveDocument: () => Promise<DocumentSnapshot | undefined>;
  readonly setNotice: (notice: string | undefined) => void;
  readonly openGitPanel: () => void;
  /** Runs after a successful AI commit; its own failures are not commit failures. */
  readonly onCommitted: () => void;
}

/** Save-then-commit with a Chrome on-device AI message proposal, plus the model download setting. */
export function useAiCommit({ git, settings, updateSettings, commentStore, saveDocument, setNotice, openGitPanel, onCommitted }: Options) {
  const generator = useMemo(() => new ChromeCommitMessageGenerator(), []);
  const [commitDialog, setCommitDialog] = useState<CommitDialogState>();
  const [aiModelSetup, setAiModelSetup] = useState<AiModelSetupState>();
  const [aiErrorNotice, setAiErrorNotice] = useState<string>();
  const generationController = useRef<AbortController | undefined>(undefined);
  const setupController = useRef<AbortController | undefined>(undefined);
  const prepared = useRef<PreparedCommitMessageGenerator | undefined>(undefined);

  useEffect(() => () => {
    generationController.current?.abort();
    setupController.current?.abort();
    prepared.current?.destroy();
    prepared.current = undefined;
  }, []);

  const updateAiCommitSuggestions = useEvent((enabled: boolean) => {
    updateSettings({ ...settings, aiCommitSuggestions: enabled });
    setAiErrorNotice(undefined);
    setupController.current?.abort();
    setupController.current = undefined;
    if (!enabled) { setAiModelSetup(undefined); return; }

    const controller = new AbortController();
    setupController.current = controller;
    setAiModelSetup({ phase: 'checking', message: 'Checking Chrome on-device AI support' });
    const preparation = generator.prepare({
      signal: controller.signal,
      onProgress(progress) {
        if (setupController.current !== controller) return;
        setAiModelSetup({
          phase: progress.phase === 'downloading' ? 'downloading' : 'checking',
          message: progress.message,
          ...(typeof progress.loaded === 'number' ? { loaded: progress.loaded } : {}),
        });
      },
    });
    void preparation.then((session) => {
      session.destroy();
      if (setupController.current !== controller) return;
      setupController.current = undefined;
      setAiErrorNotice(undefined);
      setAiModelSetup({ phase: 'ready', message: 'Chrome on-device AI is downloaded and ready' });
    }).catch((error) => {
      if (controller.signal.aborted || setupController.current !== controller) return;
      setupController.current = undefined;
      const detail = errorMessage(error);
      setAiModelSetup({ phase: 'unavailable', message: detail });
      setAiErrorNotice(detail);
    });
  });

  const closeCommitDialog = useEvent((openGit: boolean) => {
    generationController.current?.abort();
    generationController.current = undefined;
    prepared.current?.destroy();
    prepared.current = undefined;
    setCommitDialog(undefined);
    if (openGit) openGitPanel();
  });

  function aiCommitUnavailable() {
    closeCommitDialog(true);
    setAiErrorNotice('AI-generated commit message unavailable; no commit was created.');
  }

  const explicitSave = useEvent(async () => {
    if (!settings.aiCommitSuggestions || !git) { await saveDocument(); return; }
    setAiErrorNotice(undefined);
    if (!settings.profile.email) {
      if (await saveDocument()) { openGitPanel(); setNotice('A Git author email is required before creating a commit.'); }
      return;
    }
    if (commitDialog || generationController.current) return;

    const controller = new AbortController();
    generationController.current = controller;
    setCommitDialog({ phase: 'preparing', progress: { phase: 'checking', message: 'Checking Chrome on-device AI' } });
    const onProgress = (progress: CommitGenerationProgress) => setCommitDialog((current) => current ? { ...current, progress } : current);
    const preparation = generator.prepare({ signal: controller.signal, onProgress });
    void preparation.catch(() => undefined);
    // Until the session is handed to `prepared`, every exit path must destroy it.
    const discardPreparation = () => { void preparation.then((session) => session.destroy(), () => undefined); };

    const saved = await saveDocument().catch((error: unknown) => { discardPreparation(); controller.abort(); closeCommitDialog(true); setAiErrorNotice(errorMessage(error)); return undefined; });
    if (!saved) {
      controller.abort();
      if (generationController.current === controller) generationController.current = undefined;
      discardPreparation();
      if (!controller.signal.aborted || generationController.current === undefined) setCommitDialog(undefined);
      return;
    }
    if (controller.signal.aborted) { discardPreparation(); return; }
    let candidate: GitCommitCandidate | undefined;
    try {
      candidate = await git.prepareCommitCandidate(saved.path, await commentStore?.paths(saved.path as WorkspacePath));
    } catch (error) {
      discardPreparation();
      if (controller.signal.aborted) return;
      closeCommitDialog(true);
      setAiErrorNotice(`No commit was created: ${errorMessage(error)}`);
      return;
    }
    if (!candidate) {
      controller.abort();
      discardPreparation();
      if (generationController.current === controller) generationController.current = undefined;
      setCommitDialog(undefined);
      return;
    }
    if (controller.signal.aborted) { discardPreparation(); return; }
    setCommitDialog((current) => current ? { ...current, candidate } : current);
    let adopted = false;
    try {
      const session = await preparation;
      if (controller.signal.aborted) { session.destroy(); return; }
      prepared.current = session;
      adopted = true;
      const proposal = await session.generate(candidate.diff, { signal: controller.signal, onProgress });
      if (!controller.signal.aborted) setCommitDialog({ phase: 'ready', candidate, proposal });
    } catch {
      if (!adopted) discardPreparation();
      if (!controller.signal.aborted) aiCommitUnavailable();
    }
  });

  const regenerateCommitProposal = useEvent(async () => {
    const candidate = commitDialog?.candidate;
    if (!candidate) return;
    generationController.current?.abort();
    prepared.current?.destroy();
    prepared.current = undefined;
    const controller = new AbortController();
    generationController.current = controller;
    const onProgress = (progress: CommitGenerationProgress) => setCommitDialog((current) => current ? { ...current, phase: 'preparing', progress } : current);
    setCommitDialog({ phase: 'preparing', candidate, progress: { phase: 'checking', message: 'Preparing Chrome on-device AI' } });
    try {
      const session = await generator.prepare({ signal: controller.signal, onProgress });
      if (controller.signal.aborted) { session.destroy(); return; }
      prepared.current = session;
      const proposal = await session.generate(candidate.diff, { signal: controller.signal, onProgress });
      if (!controller.signal.aborted) setCommitDialog({ phase: 'ready', candidate, proposal });
    } catch {
      if (!controller.signal.aborted) aiCommitUnavailable();
    }
  });

  const acceptAiCommit = useEvent(async () => {
    const state = commitDialog;
    if (!git || state?.phase !== 'ready' || !state.candidate || !state.proposal?.subject.trim()) return;
    setCommitDialog({ ...state, phase: 'committing' });
    const message = `${state.proposal.subject.trim()}${state.proposal.body.trim() ? `\n\n${state.proposal.body.trim()}` : ''}`;
    let oid: string;
    try { oid = await git.commitCandidate(state.candidate, message, settings.profile); }
    catch (error) {
      closeCommitDialog(true);
      setAiErrorNotice(errorMessage(error));
      return;
    }
    closeCommitDialog(false);
    setAiErrorNotice(undefined);
    setNotice(`Committed ${oid.slice(0, 8)}.`);
    onCommitted();
  });

  const cancelAiCommit = useEvent(() => {
    closeCommitDialog(true);
    setNotice('AI commit message generation cancelled; no commit was created.');
  });

  const changeProposal = useEvent((proposal: CommitProposal) => setCommitDialog((current) => current ? { ...current, proposal } : current));

  return { commitDialog, aiModelSetup, aiErrorNotice, setAiErrorNotice, updateAiCommitSuggestions, explicitSave, regenerateCommitProposal, acceptAiCommit, cancelAiCommit, closeCommitDialog, changeProposal };
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
