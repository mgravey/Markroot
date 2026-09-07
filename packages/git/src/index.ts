import './buffer-runtime.js';
import {
  add,
  branch,
  checkout,
  commit,
  currentBranch,
  deleteBranch,
  getConfig,
  hashBlob,
  listBranches,
  log,
  merge,
  readBlob,
  readObject,
  remove,
  resetIndex,
  resolveRef,
  STAGE,
  statusMatrix,
  TREE,
  walk,
  WORKDIR,
  type FsClient,
  type WalkerEntry,
} from 'isomorphic-git';
import { createTwoFilesPatch } from 'diff';
import { MarkrootError, workspacePath, type AuthorIdentity, type WorkspacePath } from '@markroot/core';
import type { ProjectWorkspace, WorkspaceStat } from '@markroot/workspace';

const DIR = '/repo';

export interface GitFileStatus {
  readonly path: WorkspacePath;
  readonly head: number;
  readonly workdir: number;
  readonly stage: number;
  readonly state: 'unmodified' | 'modified' | 'added' | 'deleted' | 'untracked' | 'staged';
}
export interface GitCommitSummary {
  readonly oid: string;
  readonly message: string;
  readonly author: AuthorIdentity;
  readonly timestamp: number;
  readonly parents: readonly string[];
}
export interface GitCommitCandidate {
  readonly openPath: WorkspacePath;
  readonly paths: readonly WorkspacePath[];
  readonly diff: string;
  readonly repositoryFingerprint: string;
  readonly openFileOid: string;
  readonly worktreePaths?: readonly WorkspacePath[];
  readonly diffOid: string;
}
export interface MergePreview { readonly ours: string; readonly theirs: string; readonly clean: boolean; readonly result?: unknown; readonly error?: string }

export interface GitRepository {
  validate(): Promise<void>;
  fingerprint(): Promise<string>;
  status(): Promise<readonly GitFileStatus[]>;
  diff(path: WorkspacePath): Promise<string>;
  prepareCommitCandidate(openPath: WorkspacePath, relatedPaths?: readonly WorkspacePath[]): Promise<GitCommitCandidate | undefined>;
  commitCandidate(candidate: GitCommitCandidate, message: string, author: AuthorIdentity): Promise<string>;
  readFileAtRef(path: WorkspacePath, ref: string): Promise<string>;
  stage(path: WorkspacePath): Promise<void>;
  unstage(path: WorkspacePath): Promise<void>;
  commit(message: string, author: AuthorIdentity): Promise<string>;
  history(depth?: number, ref?: string): Promise<readonly GitCommitSummary[]>;
  branches(): Promise<readonly string[]>;
  currentBranch(): Promise<string | undefined>;
  createBranch(ref: string): Promise<void>;
  renameBranch(from: string, to: string): Promise<void>;
  deleteBranch(ref: string): Promise<void>;
  checkout(ref: string): Promise<void>;
  previewMerge(theirs: string): Promise<MergePreview>;
  merge(theirs: string, author: AuthorIdentity, message?: string): Promise<string | undefined>;
}

export class IsomorphicGitRepository implements GitRepository {
  private readonly fs: FsClient;
  constructor(private readonly workspace: ProjectWorkspace) { this.fs = createGitFs(workspace); }

  async validate(): Promise<void> {
    let dotGit: WorkspaceStat;
    try { dotGit = await this.workspace.stat(workspacePath('.git')); }
    catch (cause) { throw new MarkrootError('GIT_ERROR', 'The selected folder is not a Git repository.', undefined, { cause }); }
    if (dotGit.kind !== 'directory') throw new MarkrootError('NOT_SUPPORTED', 'Linked worktrees and gitdir files are not supported in this release.');
    const config = await this.workspace.readFile(workspacePath('.git/config')).catch(() => '');
    if (/objectFormat\s*=\s*sha256/i.test(config)) throw new MarkrootError('NOT_SUPPORTED', 'SHA-256 repositories are not supported in this release.');
  }

  async fingerprint(): Promise<string> {
    await this.validate();
    const head = await resolveRef({ fs: this.fs, dir: DIR, ref: 'HEAD' }).catch(() => 'unborn');
    const index = await this.workspace.readBytes(workspacePath('.git/index')).catch(() => new Uint8Array());
    return `${head}:${(await hashBlob({ object: index })).oid}`;
  }

  async status(): Promise<readonly GitFileStatus[]> {
    await this.validate();
    const matrix = await statusMatrix({ fs: this.fs, dir: DIR });
    return matrix.map(([filepath, head, workdir, stage]) => ({
      path: workspacePath(filepath), head, workdir, stage,
      state: statusName(head, workdir, stage),
    }));
  }

  async diff(path: WorkspacePath): Promise<string> {
    let base = '';
    try {
      const oid = await resolveRef({ fs: this.fs, dir: DIR, ref: 'HEAD' });
      base = new TextDecoder().decode((await readBlob({ fs: this.fs, dir: DIR, oid, filepath: path })).blob);
    } catch { base = ''; }
    const current = await this.workspace.readFile(path).catch(() => '');
    return createTwoFilesPatch(`a/${path}`, `b/${path}`, base, current, 'HEAD', 'working tree');
  }

  async prepareCommitCandidate(openPath: WorkspacePath, relatedPaths?: readonly WorkspacePath[]): Promise<GitCommitCandidate | undefined> {
    await this.validate();
    const repositoryFingerprint = await this.fingerprint();
    const openBytes = await this.workspace.readBytes(openPath).catch(() => undefined);
    if (!openBytes) return undefined;
    const openFileOid = (await hashBlob({ object: openBytes })).oid;
    const worktreePaths = [...new Set([openPath, ...(relatedPaths ?? [])])];
    const result = await this.candidateDiff(worktreePaths);
    if (!result.openChanged || !result.diff.trim()) return undefined;
    return {
      openPath,
      worktreePaths,
      paths: result.paths,
      diff: result.diff,
      repositoryFingerprint,
      openFileOid,
      diffOid: (await hashBlob({ object: result.diff })).oid,
    };
  }

  async commitCandidate(candidate: GitCommitCandidate, message: string, author: AuthorIdentity): Promise<string> {
    if (!message.trim()) throw new Error('Commit message is required.');
    if (!author.email) throw new Error('A Git author email is required.');
    return this.withMutation(async () => {
      if (await this.fingerprint() !== candidate.repositoryFingerprint) throw new MarkrootError('CONFLICT', 'The repository changed while the commit message was being prepared. Generate it again.');
      const openBytes = await this.workspace.readBytes(candidate.openPath).catch(() => undefined);
      if (!openBytes || (await hashBlob({ object: openBytes })).oid !== candidate.openFileOid) throw new MarkrootError('CONFLICT', 'The open file changed while the commit message was being prepared. Save and generate it again.');

      const indexPath = workspacePath('.git/index');
      const previousIndex = await this.workspace.readBytes(indexPath).catch(() => undefined);
      try {
        for (const path of candidate.worktreePaths ?? [candidate.openPath]) await this.stageUnlocked(path);
        const staged = await this.candidateDiff();
        if ((await hashBlob({ object: staged.diff })).oid !== candidate.diffOid) throw new MarkrootError('CONFLICT', 'The staged changes no longer match the proposed commit. Generate the message again.');
        return await commit({ fs: this.fs, dir: DIR, message: message.trim(), author: { name: author.displayName, email: author.email } });
      } catch (error) {
        if (previousIndex) await this.workspace.writeBytes(indexPath, previousIndex).catch(() => undefined);
        else await this.workspace.remove(indexPath).catch(() => undefined);
        throw error;
      }
    });
  }

  async readFileAtRef(path: WorkspacePath, ref: string): Promise<string> {
    const oid = await resolveRef({ fs: this.fs, dir: DIR, ref });
    return new TextDecoder().decode((await readBlob({ fs: this.fs, dir: DIR, oid, filepath: path })).blob);
  }

  async stage(path: WorkspacePath): Promise<void> {
    await this.withMutation(() => this.stageUnlocked(path));
  }

  async unstage(path: WorkspacePath): Promise<void> { await this.withMutation(() => resetIndex({ fs: this.fs, dir: DIR, filepath: path })); }

  async commit(message: string, author: AuthorIdentity): Promise<string> {
    if (!message.trim()) throw new Error('Commit message is required.');
    if (!author.email) throw new Error('A Git author email is required.');
    return this.withMutation(() => commit({ fs: this.fs, dir: DIR, message: message.trim(), author: { name: author.displayName, email: author.email! } }));
  }

  async history(depth = 100, ref = 'HEAD'): Promise<readonly GitCommitSummary[]> {
    const entries = await log({ fs: this.fs, dir: DIR, depth, ref });
    return entries.map((entry) => ({
      oid: entry.oid,
      message: entry.commit.message.trim(),
      author: { actorId: entry.commit.author.email, displayName: entry.commit.author.name, email: entry.commit.author.email },
      timestamp: entry.commit.author.timestamp,
      parents: entry.commit.parent,
    }));
  }

  async branches(): Promise<readonly string[]> { return listBranches({ fs: this.fs, dir: DIR }); }
  async currentBranch(): Promise<string | undefined> { return (await currentBranch({ fs: this.fs, dir: DIR, fullname: false })) ?? undefined; }
  async createBranch(ref: string): Promise<void> { await this.withMutation(() => branch({ fs: this.fs, dir: DIR, ref })); }
  async renameBranch(from: string, to: string): Promise<void> {
    const source = from.trim();
    const target = to.trim();
    if (!source || !target) throw new MarkrootError('GIT_ERROR', 'Both branch names are required.');
    if (source === target) return;
    await this.withMutation(async () => {
      const oid = await resolveRef({ fs: this.fs, dir: DIR, ref: source });
      const active = await currentBranch({ fs: this.fs, dir: DIR, fullname: false });
      await branch({ fs: this.fs, dir: DIR, ref: target, object: oid, checkout: active === source });
      await deleteBranch({ fs: this.fs, dir: DIR, ref: source });
    });
  }
  async deleteBranch(ref: string): Promise<void> { await this.withMutation(() => deleteBranch({ fs: this.fs, dir: DIR, ref })); }
  async checkout(ref: string): Promise<void> { await this.withMutation(() => checkout({ fs: this.fs, dir: DIR, ref })); }

  async previewMerge(theirs: string): Promise<MergePreview> {
    const ours = await this.currentBranch();
    if (!ours) throw new MarkrootError('GIT_ERROR', 'Detached HEAD cannot receive a branch merge.');
    try {
      const result = await merge({ fs: this.fs, dir: DIR, ours, theirs, dryRun: true, abortOnConflict: true });
      return { ours, theirs, clean: true, result };
    } catch (error) { return { ours, theirs, clean: false, error: error instanceof Error ? error.message : String(error) }; }
  }

  async merge(theirs: string, author: AuthorIdentity, message?: string): Promise<string | undefined> {
    if (!author.email) throw new Error('A Git author email is required.');
    const ours = await this.currentBranch();
    if (!ours) throw new MarkrootError('GIT_ERROR', 'Detached HEAD cannot receive a branch merge.');
    const result = await this.withMutation(() => merge({ fs: this.fs, dir: DIR, ours, theirs, author: { name: author.displayName, email: author.email! }, ...(message ? { message } : {}) }));
    return result.oid;
  }

  async configuredAuthor(): Promise<Partial<AuthorIdentity>> {
    const name = await getConfig({ fs: this.fs, dir: DIR, path: 'user.name' });
    const email = await getConfig({ fs: this.fs, dir: DIR, path: 'user.email' });
    return { actorId: email ?? crypto.randomUUID(), ...(name ? { displayName: name } : {}), ...(email ? { email } : {}) };
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    await this.validate();
    const run = async () => {
      const before = await this.fingerprint();
      await Promise.resolve();
      if (before !== await this.fingerprint()) throw new MarkrootError('CONFLICT', 'The repository changed before the Git operation started. Refresh and try again.');
      return operation();
    };
    const lockName = (this.workspace as ProjectWorkspace & { readonly lockName?: string }).lockName;
    if (!lockName || typeof navigator === 'undefined' || !navigator.locks) return run();
    return navigator.locks.request(lockName, { mode: 'exclusive' }, run);
  }

  private async stageUnlocked(path: WorkspacePath): Promise<void> {
    const exists = await this.workspace.stat(path).then(() => true).catch(() => false);
    if (exists) await add({ fs: this.fs, dir: DIR, filepath: path });
    else await remove({ fs: this.fs, dir: DIR, filepath: path });
  }

  private async candidateDiff(worktreePaths: readonly WorkspacePath[] = []): Promise<{ readonly diff: string; readonly paths: readonly WorkspacePath[]; readonly openChanged: boolean }> {
    const sections = await walk({
      fs: this.fs,
      dir: DIR,
      trees: [TREE({ ref: 'HEAD' }), STAGE(), WORKDIR({ refresh: false })],
      map: async (filepath, entries) => {
        if (filepath === '.') return undefined;
        const [head, stage, workdir] = entries;
        const selected = worktreePaths.includes(filepath as WorkspacePath);
        const target = selected ? workdir : stage;
        const headType = await entryType(head);
        const targetType = await entryType(target);
        if (headType !== 'blob' && targetType !== 'blob') return undefined;
        const path = workspacePath(filepath);
        const before = await this.entryBytes(head, 'tree');
        const after = await this.entryBytes(target, selected ? 'workdir' : 'stage');
        const headOid = headType === 'blob' ? await head!.oid() : undefined;
        const targetOid = targetType === 'blob'
          ? selected ? (await hashBlob({ object: after })).oid : await target!.oid()
          : undefined;
        if (headType === targetType && headOid === targetOid) return undefined;
        return { path, patch: createPatch(path, before, after), openChanged: selected };
      },
    }) as Array<{ path: WorkspacePath; patch: string; openChanged: boolean }>;
    const ordered = sections.filter(Boolean).sort((left, right) => left.path.localeCompare(right.path));
    return {
      diff: ordered.map((section) => section.patch).join('\n'),
      paths: ordered.map((section) => section.path),
      openChanged: ordered.some((section) => section.openChanged),
    };
  }

  private async entryBytes(entry: WalkerEntry | null | undefined, source: 'tree' | 'stage' | 'workdir'): Promise<Uint8Array> {
    if (!entry || await entry.type() !== 'blob') return new Uint8Array();
    if (source !== 'stage') return new Uint8Array((await entry.content()) ?? []);
    const result = await readObject({ fs: this.fs, dir: DIR, oid: await entry.oid(), format: 'content' });
    return new Uint8Array(result.object as Uint8Array);
  }
}

async function entryType(entry: WalkerEntry | null | undefined): Promise<Awaited<ReturnType<WalkerEntry['type']>> | undefined> {
  return entry ? entry.type() : undefined;
}

function createPatch(path: WorkspacePath, before: Uint8Array, after: Uint8Array): string {
  if (isBinary(before) || isBinary(after)) return `diff --git a/${path} b/${path}\nBinary files a/${path} and b/${path} differ\n`;
  return createTwoFilesPatch(`a/${path}`, `b/${path}`, new TextDecoder().decode(before), new TextDecoder().decode(after), 'HEAD', 'candidate');
}

function isBinary(content: Uint8Array): boolean {
  return content.subarray(0, Math.min(content.length, 8_000)).includes(0);
}

interface NodeStatLike {
  size: number; mode: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number; uid: number; gid: number;
  isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean;
}
interface EncodingOptions { encoding?: string | null }

export function createGitFs(workspace: ProjectWorkspace): FsClient {
  const adaptPath = (input: string): WorkspacePath | undefined => {
    const clean = input.replaceAll('\\', '/').replace(/^\/repo\/?/, '').replace(/^\/+/, '');
    return clean && clean !== '.' ? workspacePath(clean) : undefined;
  };
  const nodeError = (error: unknown): never => {
    const source = error instanceof MarkrootError ? error : new MarkrootError('WORKSPACE_ERROR', String(error));
    const wrapped = Object.assign(new Error(source.message), { code: source.code === 'NOT_FOUND' ? 'ENOENT' : source.code === 'CONFLICT' ? 'EEXIST' : 'EIO' });
    throw wrapped;
  };
  const stat = async (input: string): Promise<NodeStatLike> => {
    const path = adaptPath(input);
    if (!path) return makeStat('directory', 0, 0);
    try { const value = await workspace.stat(path); return makeStat(value.kind, value.size, value.modifiedAt ?? 0); }
    catch (error) { return nodeError(error); }
  };
  const promises = {
    readFile: async (input: string, options?: EncodingOptions | string): Promise<Uint8Array | string> => {
      const path = adaptPath(input); if (!path) throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
      try {
        const bytes = await workspace.readBytes(path);
        const encoding = typeof options === 'string' ? options : options?.encoding;
        return encoding ? new TextDecoder().decode(bytes) : bytes;
      } catch (error) { return nodeError(error); }
    },
    writeFile: async (input: string, data: Uint8Array | string): Promise<void> => {
      const path = adaptPath(input); if (!path) throw new Error('Cannot write repository root.');
      try { await ensureParent(workspace, path); await workspace.writeBytes(path, typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)); }
      catch (error) { nodeError(error); }
    },
    unlink: async (input: string): Promise<void> => { const path = adaptPath(input); if (!path) throw new Error('Cannot unlink root.'); try { await workspace.remove(path); } catch (error) { nodeError(error); } },
    readdir: async (input: string): Promise<string[]> => { try { return (await workspace.listFiles(adaptPath(input))).map((entry) => entry.path.split('/').at(-1)!); } catch (error) { return nodeError(error); } },
    mkdir: async (input: string): Promise<void> => { const path = adaptPath(input); if (!path) return; try { await workspace.createDirectory(path); } catch (error) { nodeError(error); } },
    rmdir: async (input: string): Promise<void> => { const path = adaptPath(input); if (!path) return; try { await workspace.remove(path); } catch (error) { nodeError(error); } },
    stat,
    lstat: stat,
    readlink: async (): Promise<never> => { throw Object.assign(new Error('Symbolic links are unsupported.'), { code: 'EINVAL' }); },
    symlink: async (): Promise<never> => { throw Object.assign(new Error('Symbolic links are unsupported.'), { code: 'ENOTSUP' }); },
    chmod: async (): Promise<void> => undefined,
  };
  return { promises } as unknown as FsClient;
}

function makeStat(kind: 'file' | 'directory', size: number, mtimeMs: number): NodeStatLike {
  return { size, mode: kind === 'file' ? 0o100644 : 0o040755, mtimeMs, ctimeMs: mtimeMs, dev: 0, ino: 0, uid: 0, gid: 0, isFile: () => kind === 'file', isDirectory: () => kind === 'directory', isSymbolicLink: () => false };
}
async function ensureParent(workspace: ProjectWorkspace, path: WorkspacePath): Promise<void> {
  const index = path.lastIndexOf('/');
  if (index > 0) await workspace.createDirectory(workspacePath(path.slice(0, index)), { recursive: true });
}
function statusName(head: number, workdir: number, stage: number): GitFileStatus['state'] {
  if (head === 0 && workdir === 2 && stage === 0) return 'untracked';
  if (head === 0 && stage === 2) return 'added';
  if (workdir === 0) return 'deleted';
  if (head === stage && head !== workdir) return 'modified';
  if (head !== stage) return 'staged';
  return 'unmodified';
}
