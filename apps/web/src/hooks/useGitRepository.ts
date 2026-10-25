import { useState } from 'react';
import type { AuthorIdentity, WorkspacePath } from '@markroot/core';
import type { GitCommitSummary, GitFileStatus, IsomorphicGitRepository } from '@markroot/git';
import { useEvent } from './useEvent.js';

interface Options {
  readonly openPath: WorkspacePath | undefined;
  readonly dirty: boolean;
  readonly profile: AuthorIdentity;
  readonly reloadComments: () => Promise<void>;
  readonly setNotice: (notice: string | undefined) => void;
  readonly reportError: (error: unknown) => void;
}

/** Local repository state for the inspector, the tree badges and the open document's HEAD base. */
export function useGitRepository({ openPath, dirty, profile, reloadComments, setNotice, reportError }: Options) {
  const [git, setGit] = useState<IsomorphicGitRepository>();
  const [gitError, setGitError] = useState<string>();
  const [gitStatus, setGitStatus] = useState<readonly GitFileStatus[]>([]);
  const [gitBase, setGitBase] = useState<{ readonly path: WorkspacePath; readonly source: string }>();
  const [branches, setBranches] = useState<readonly string[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string>();
  const [history, setHistory] = useState<readonly GitCommitSummary[]>([]);
  const [commitMessage, setCommitMessage] = useState('');

  const reset = useEvent(() => { setGit(undefined); setGitBase(undefined); });

  /** Loads a newly opened folder's repository; returns its configured author unless a newer folder superseded it. */
  const connect = useEvent(async (repository: IsomorphicGitRepository, superseded: () => boolean): Promise<Awaited<ReturnType<IsomorphicGitRepository['configuredAuthor']>> | undefined> => {
    try {
      await repository.validate();
      const [status, branchNames, branch, commits, configured] = [await repository.status(), await repository.branches(), await repository.currentBranch(), await repository.history(20), await repository.configuredAuthor()];
      if (superseded()) return undefined;
      setGit(repository);
      setGitError(undefined);
      setGitStatus(status);
      setBranches(branchNames);
      setCurrentBranch(branch);
      setHistory(commits);
      return configured;
    } catch (error) {
      if (superseded()) return undefined;
      setGit(undefined); setGitError(error instanceof Error ? error.message : String(error)); setGitStatus([]); setBranches([]); setCurrentBranch(undefined); setHistory([]);
      return undefined;
    }
  });

  const readBase = useEvent(async () => {
    if (git && openPath) setGitBase({ path: openPath, source: await git.readFileAtRef(openPath, 'HEAD').catch(() => '') });
  });

  const refresh = useEvent(async () => {
    if (!git) return;
    await reloadComments();
    setGitStatus(await git.status());
    setBranches(await git.branches());
    setCurrentBranch(await git.currentBranch());
    setHistory(await git.history(20));
    await readBase();
  });

  /** Background status refresh whose failure never masks the operation that triggered it. */
  const refreshStatus = useEvent(() => { if (git) void git.status().then(setGitStatus, reportError); });

  /** Runs a Git operation; a failing refresh afterwards is reported separately, not as the operation failing. */
  async function run(operation: (repository: IsomorphicGitRepository) => Promise<string | undefined>) {
    if (!git) return;
    let message: string | undefined;
    try { message = await operation(git); }
    catch (error) { reportError(error); return; }
    if (message) setNotice(message);
    void refresh().catch(reportError);
  }

  const stage = useEvent(async (path: WorkspacePath, staged: boolean) => {
    if (!git || dirty) { setNotice('Save the open document before changing the Git index.'); return; }
    await run(async (repository) => { if (staged) await repository.unstage(path); else await repository.stage(path); return undefined; });
  });
  const createCommit = useEvent(() => run(async (repository) => {
    const oid = await repository.commit(commitMessage, profile);
    setCommitMessage('');
    return `Committed ${oid.slice(0, 8)}.`;
  }));
  const createBranch = useEvent((ref: string) => run(async (repository) => { await repository.createBranch(ref); return `Created branch ${ref}.`; }));
  const renameBranch = useEvent(async (from: string, to: string) => {
    if (dirty) { setNotice('Save the open document before renaming a branch.'); return; }
    await run(async (repository) => { await repository.renameBranch(from, to); return `Renamed branch ${from} to ${to}.`; });
  });
  const deleteBranch = useEvent(async (ref: string) => {
    if (!git || ref === currentBranch || !window.confirm(`Delete local branch ${ref}?`)) return;
    await run(async (repository) => { await repository.deleteBranch(ref); return `Deleted branch ${ref}.`; });
  });
  const refreshPanel = useEvent(() => refresh().catch(reportError));

  return { git, gitError, gitStatus, setGitStatus, gitBase, setGitBase, readBase, branches, currentBranch, history, commitMessage, setCommitMessage, reset, connect, refresh, refreshPanel, refreshStatus, stage, createCommit, createBranch, renameBranch, deleteBranch };
}
