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
  isIgnored,
  listBranches,
  listFiles,
  log,
  merge,
  readBlob,
  readObject,
  remove,
  renameBranch,
  resetIndex,
  resolveRef,
  STAGE,
  statusMatrix,
  TREE,
  walk,
  WORKDIR,
  writeRef,
  type FsClient,
  type WalkerEntry,
} from 'isomorphic-git';
import { createTwoFilesPatch } from 'diff';
import { MarkrootError, workspacePath, type AuthorIdentity, type WorkspacePath } from '@markroot/core';
import type { ProjectWorkspace, WorkspaceStat } from '@markroot/workspace';

const DIR = '/repo';
const INDEX_LOCK = workspacePath('.git/index.lock');
const EXECUTABLE = 0o100755;

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
  /** Requested paths left out because .gitignore excludes them and Git does not track them. */
  readonly ignored?: readonly WorkspacePath[];
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
  /** Index modes other than 0o100644, so staging through FSA never drops the executable bit. */
  private modes = new Map<string, number>();
  private modesVersion: string | undefined;
  constructor(private readonly workspace: ProjectWorkspace) { this.fs = createGitFs(workspace, { modeFor: (path) => this.modes.get(path) }); }

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
    const symbolic = await currentBranch({ fs: this.fs, dir: DIR, fullname: true }).catch(() => undefined) ?? 'detached';
    const head = await resolveRef({ fs: this.fs, dir: DIR, ref: 'HEAD' }).catch(() => 'unborn');
    const index = await this.workspace.readBytes(workspacePath('.git/index')).catch(() => new Uint8Array());
    return `${symbolic}:${head}:${(await hashBlob({ object: index })).oid}`;
  }

  async status(): Promise<readonly GitFileStatus[]> {
    await this.validate();
    await this.refreshModes();
    const matrix = await statusMatrix({ fs: this.fs, dir: DIR });
    return matrix.map(([filepath, head, workdir, stage]) => ({
      path: workspacePath(filepath), head, workdir, stage,
      state: statusName(head, workdir, stage),
    }));
  }

  async diff(path: WorkspacePath): Promise<string> {
    let base: Uint8Array = new Uint8Array();
    try {
      const oid = await resolveRef({ fs: this.fs, dir: DIR, ref: 'HEAD' });
      base = (await readBlob({ fs: this.fs, dir: DIR, oid, filepath: path })).blob;
    } catch (error) { if (!isGitNotFound(error)) throw error; }
    let current: Uint8Array = new Uint8Array();
    try { current = await this.workspace.readBytes(path); }
    catch (error) { if (!(error instanceof MarkrootError && error.code === 'NOT_FOUND')) throw error; }
    return createPatch(path, base, current, 'working tree');
  }

  async prepareCommitCandidate(openPath: WorkspacePath, relatedPaths?: readonly WorkspacePath[]): Promise<GitCommitCandidate | undefined> {
    await this.validate();
    const repositoryFingerprint = await this.fingerprint();
    const openBytes = await this.workspace.readBytes(openPath).catch(() => undefined);
    if (!openBytes) return undefined;
    const openFileOid = (await hashBlob({ object: openBytes })).oid;
    const requested = [...new Set([openPath, ...(relatedPaths ?? [])])];
    // add() silently skips ignored untracked files; keep them out so the staged diff can match.
    const tracked = new Set(await listFiles({ fs: this.fs, dir: DIR }));
    const ignored: WorkspacePath[] = [];
    for (const path of requested) if (!tracked.has(path) && await isIgnored({ fs: this.fs, dir: DIR, filepath: path })) ignored.push(path);
    if (ignored.includes(openPath)) throw new MarkrootError('GIT_ERROR', `${openPath} is ignored by .gitignore and is not tracked, so it cannot be committed.`);
    const worktreePaths = requested.filter((path) => !ignored.includes(path));
    await this.refreshModes();
    const result = await this.candidateDiff(worktreePaths);
    if (!result.openChanged || !result.diff.trim()) return undefined;
    return {
      openPath,
      worktreePaths,
      ...(ignored.length ? { ignored } : {}),
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
    await this.withMutation(async () => {
      const tracked = (await listFiles({ fs: this.fs, dir: DIR })).includes(path);
      if (!tracked && await isIgnored({ fs: this.fs, dir: DIR, filepath: path })) throw new MarkrootError('GIT_ERROR', `${path} is ignored by .gitignore.`);
      await this.stageUnlocked(path);
    });
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
      await renameBranch({ fs: this.fs, dir: DIR, oldref: source, ref: target });
      // Carry upstream/merge settings along, like `git branch -m`.
      const configPath = workspacePath('.git/config');
      const config = await this.workspace.readFile(configPath).catch(() => undefined);
      const header = new RegExp(`^(\\s*)\\[branch\\s+"${escapeRegExp(escapeConfig(source))}"\\]`, 'gm');
      const next = config?.replace(header, `$1[branch "${escapeConfig(target).replaceAll('$', '$$$$')}"]`);
      if (config !== undefined && next !== config) await this.workspace.writeFile(configPath, next!);
    });
  }
  async deleteBranch(ref: string): Promise<void> { await this.withMutation(() => deleteBranch({ fs: this.fs, dir: DIR, ref })); }
  /** isomorphic-git refuses with CheckoutConflictError when local edits would be overwritten. */
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
    return this.withMutation(async () => {
      if (await this.dirty()) throw new MarkrootError('CONFLICT', 'Commit or discard local changes before merging.');
      const before = await resolveRef({ fs: this.fs, dir: DIR, ref: ours });
      // isomorphic-git only moves the branch (and writes the merge commit); index and files stay behind.
      const result = await merge({ fs: this.fs, dir: DIR, ours, theirs, author: { name: author.displayName, email: author.email! }, ...(message ? { message } : {}) });
      if (result.oid && result.oid !== before) {
        try { await checkout({ fs: this.fs, dir: DIR, ref: ours }); }
        catch (error) { await writeRef({ fs: this.fs, dir: DIR, ref: `refs/heads/${ours}`, value: before, force: true }); throw error; }
      }
      return result.oid;
    });
  }

  async configuredAuthor(): Promise<Partial<AuthorIdentity>> {
    const name = await getConfig({ fs: this.fs, dir: DIR, path: 'user.name' });
    const email = await getConfig({ fs: this.fs, dir: DIR, path: 'user.email' });
    return { actorId: email ?? crypto.randomUUID(), ...(name ? { displayName: name } : {}), ...(email ? { email } : {}) };
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    await this.validate();
    const run = async () => {
      // Exclude native Git for the duration, using the lock file it honours itself.
      if (await this.workspace.stat(INDEX_LOCK).then(() => true, () => false)) throw new MarkrootError('CONFLICT', 'Another Git process is using this repository (.git/index.lock exists). If none is running, delete .git/index.lock and try again.');
      await this.workspace.writeBytes(INDEX_LOCK, new Uint8Array());
      try { await this.refreshModes(); return await operation(); }
      finally { await this.workspace.remove(INDEX_LOCK).catch(() => undefined); }
    };
    const lockName = (this.workspace as ProjectWorkspace & { readonly lockName?: string }).lockName;
    if (!lockName || typeof navigator === 'undefined' || !navigator.locks) return run();
    return navigator.locks.request(lockName, { mode: 'exclusive' }, run);
  }

  private async dirty(): Promise<boolean> {
    const matrix = await statusMatrix({ fs: this.fs, dir: DIR });
    return matrix.some(([, head, workdir, stage]) => !(head === 0 && stage === 0) && (head !== workdir || head !== stage));
  }

  private async refreshModes(): Promise<void> {
    const version = await this.workspace.stat(workspacePath('.git/index')).then((stat) => stat.version ?? `${stat.modifiedAt}:${stat.size}`, () => 'none');
    if (version === this.modesVersion) return;
    const entries = version === 'none' ? [] : await walk({
      fs: this.fs, dir: DIR, trees: [STAGE()],
      map: async (filepath, [entry]) => {
        if (!entry || await entry.type() !== 'blob') return undefined;
        const mode = await entry.mode();
        return mode !== 0o100644 ? [filepath, mode] : undefined;
      },
    }) as Array<[string, number]>;
    this.modes = new Map(entries.filter(Boolean));
    this.modesVersion = version;
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
        if (filepath === '.git' || filepath.startsWith('.git/')) return null;
        const [head, stage, workdir] = entries;
        const headType = await entryType(head);
        const stageType = await entryType(stage);
        // Prune untracked directories (node_modules, build output…) unless a selected path lives inside.
        if (headType !== 'tree' && stageType !== 'tree' && await entryType(workdir) === 'tree') return worktreePaths.some((path) => path.startsWith(`${filepath}/`)) ? undefined : null;
        const selected = worktreePaths.includes(filepath as WorkspacePath);
        const target = selected ? workdir : stage;
        const targetType = selected ? await entryType(target) : stageType;
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

function createPatch(path: WorkspacePath, before: Uint8Array, after: Uint8Array, label = 'candidate'): string {
  if (isBinary(before) || isBinary(after)) return `diff --git a/${path} b/${path}\nBinary files a/${path} and b/${path} differ\n`;
  return createTwoFilesPatch(`a/${path}`, `b/${path}`, new TextDecoder().decode(before), new TextDecoder().decode(after), 'HEAD', label);
}
function isGitNotFound(error: unknown): boolean {
  const code = typeof error === 'object' && error && 'code' in error ? error.code : undefined;
  return code === 'NotFoundError' || code === 'ENOENT';
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function escapeConfig(value: string): string { return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"'); }

function isBinary(content: Uint8Array): boolean {
  return content.subarray(0, Math.min(content.length, 8_000)).includes(0);
}

interface NodeStatLike {
  size: number; mode: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number; uid: number; gid: number;
  isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean;
}
interface EncodingOptions { encoding?: string | null }

export interface GitFsOptions {
  /** Git mode recorded for a path (index/HEAD); the FSA has no permission bits, so never report less. */
  readonly modeFor?: (path: WorkspacePath) => number | undefined;
}

export function createGitFs(workspace: ProjectWorkspace, options: GitFsOptions = {}): FsClient {
  const adaptPath = (input: string): WorkspacePath | undefined => {
    const clean = input.replace(/^\/repo\/?/, '').replace(/^\/+/, '');
    // A tracked name containing a backslash cannot exist in a browser-visible folder; never alias it to a/b.
    if (clean.includes('\\')) throw Object.assign(new Error(`Unsupported file name: ${clean}`), { code: 'ENOENT' });
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
    try { const value = await workspace.stat(path); return makeStat(value.kind, value.size, value.modifiedAt ?? 0, value.kind === 'file' ? options.modeFor?.(path) : undefined); }
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
  return { promises };
}

function makeStat(kind: 'file' | 'directory', size: number, mtimeMs: number, fileMode?: number): NodeStatLike {
  return { size, mode: kind === 'file' ? fileMode === EXECUTABLE ? EXECUTABLE : 0o100644 : 0o040755, mtimeMs, ctimeMs: mtimeMs, dev: 0, ino: 0, uid: 0, gid: 0, isFile: () => kind === 'file', isDirectory: () => kind === 'directory', isSymbolicLink: () => false };
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
