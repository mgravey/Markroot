import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { getConfig, init, readTree, resolveRef, setConfig, updateIndex } from 'isomorphic-git';
import { MarkrootError, workspacePath } from '@markroot/core';
import { MemoryWorkspace } from '@markroot/workspace';
import { createGitFs, IsomorphicGitRepository } from './index.js';
import { ensureGitBuffer } from './buffer-runtime.js';

describe('IsomorphicGitRepository', () => {
  it('installs the Buffer implementation required by the browser ESM build', () => {
    const runtime = {} as typeof globalThis & { Buffer?: typeof Buffer };
    ensureGitBuffer(runtime);
    expect(runtime.Buffer).toBeDefined();
    expect(runtime.Buffer!.from('Markroot').toString('utf8')).toBe('Markroot');
  });

  it('uses the workspace as the real repository store', async () => {
    const workspace = new MemoryWorkspace();
    await init({ fs: createGitFs(workspace), dir: '/repo', defaultBranch: 'main' });
    await workspace.writeFile(workspacePath('paper.md'), '# First\n');
    const repository = new IsomorphicGitRepository(workspace);
    await repository.validate();
    expect((await repository.status()).find((item) => item.path === 'paper.md')?.state).toBe('untracked');
    await repository.stage(workspacePath('paper.md'));
    const oid = await repository.commit('Initial paper', { actorId: 'ada', displayName: 'Ada', email: 'ada@example.test' });
    expect(oid).toHaveLength(40);
    expect(await repository.readFileAtRef(workspacePath('paper.md'), 'HEAD')).toBe('# First\n');
    expect((await repository.history())[0]?.message).toBe('Initial paper');
    await repository.renameBranch('main', 'primary');
    expect(await repository.currentBranch()).toBe('primary');
    expect(await repository.branches()).toEqual(['primary']);
    expect(await workspace.stat(workspacePath('.git/HEAD'))).toMatchObject({ kind: 'file' });
  });

  it('builds and commits the staged set plus the saved open file only', async () => {
    const workspace = new MemoryWorkspace();
    await init({ fs: createGitFs(workspace), dir: '/repo', defaultBranch: 'main' });
    await workspace.writeFile(workspacePath('paper.md'), '# First\n');
    await workspace.writeFile(workspacePath('guide.md'), '# Guide\n');
    await workspace.writeFile(workspacePath('notes.md'), '# Notes\n');
    const repository = new IsomorphicGitRepository(workspace);
    for (const path of ['paper.md', 'guide.md', 'notes.md'] as const) await repository.stage(workspacePath(path));
    await repository.commit('docs: add documents', { actorId: 'ada', displayName: 'Ada', email: 'ada@example.test' });

    await workspace.writeFile(workspacePath('paper.md'), '# Revised paper\n');
    await workspace.writeFile(workspacePath('guide.md'), '# Revised guide\n');
    await workspace.writeFile(workspacePath('notes.md'), '# Private notes\n');
    await repository.stage(workspacePath('guide.md'));

    const candidate = await repository.prepareCommitCandidate(workspacePath('paper.md'));
    expect(candidate?.paths).toEqual(['guide.md', 'paper.md']);
    expect(candidate?.diff).toContain('Revised paper');
    expect(candidate?.diff).toContain('Revised guide');
    expect(candidate?.diff).not.toContain('Private notes');

    const oid = await repository.commitCandidate(candidate!, 'docs: revise paper and guide', { actorId: 'ada', displayName: 'Ada', email: 'ada@example.test' });
    expect(oid).toHaveLength(40);
    expect(await repository.readFileAtRef(workspacePath('paper.md'), 'HEAD')).toBe('# Revised paper\n');
    expect(await repository.readFileAtRef(workspacePath('guide.md'), 'HEAD')).toBe('# Revised guide\n');
    expect(await repository.readFileAtRef(workspacePath('notes.md'), 'HEAD')).toBe('# Notes\n');
    expect((await repository.status()).find((item) => item.path === 'notes.md')?.state).toBe('modified');
  });

  it('includes comment-only changes in document candidates and rejects stale sidecars', async () => {
    const workspace = new MemoryWorkspace();
    await init({ fs: createGitFs(workspace), dir: '/repo', defaultBranch: 'main' });
    const paper = workspacePath('paper.md');
    const comment = workspacePath('.markroot/comments/thread/messages/reply.yaml');
    const unrelated = workspacePath('.markroot/comments/other/thread.yaml');
    const author = { actorId: 'ada', displayName: 'Ada', email: 'ada@example.test' };
    await workspace.writeFile(paper, '# Paper\n');
    const repository = new IsomorphicGitRepository(workspace);
    await repository.stage(paper);
    await repository.commit('Initial document', author);
    await workspace.writeFile(comment, 'body: First reply\n');
    await workspace.writeFile(unrelated, 'document: other.md\n');
    const candidate = await repository.prepareCommitCandidate(paper, [comment]);
    expect(candidate?.paths).toEqual([comment]);
    expect(candidate?.diff).toContain('First reply');
    expect(candidate?.diff).not.toContain('other.md');
    await workspace.writeFile(comment, 'body: Changed reply\n');
    await expect(repository.commitCandidate(candidate!, 'Add comment', author)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await repository.status()).find((entry) => entry.path === comment)?.state).toBe('untracked');
    const fresh = await repository.prepareCommitCandidate(paper, [comment]);
    await repository.commitCandidate(fresh!, 'Add comment', author);
    expect(await repository.readFileAtRef(comment, 'HEAD')).toContain('Changed reply');
    expect(await repository.readFileAtRef(paper, 'HEAD')).toBe('# Paper\n');
    expect((await repository.status()).find((entry) => entry.path === unrelated)?.state).toBe('untracked');
  });

  it('rejects stale candidates and restores the previous index after validation failure', async () => {
    const workspace = new MemoryWorkspace();
    await init({ fs: createGitFs(workspace), dir: '/repo', defaultBranch: 'main' });
    await workspace.writeFile(workspacePath('paper.md'), '# First\n');
    const repository = new IsomorphicGitRepository(workspace);
    await repository.stage(workspacePath('paper.md'));
    await repository.commit('docs: add paper', { actorId: 'ada', displayName: 'Ada', email: 'ada@example.test' });
    await workspace.writeFile(workspacePath('paper.md'), '# Revised\n');

    const candidate = await repository.prepareCommitCandidate(workspacePath('paper.md'));
    await expect(repository.commitCandidate({ ...candidate!, diffOid: '0'.repeat(40) }, 'docs: revise paper', { actorId: 'ada', displayName: 'Ada', email: 'ada@example.test' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await repository.status()).find((item) => item.path === 'paper.md')?.state).toBe('modified');

    const fresh = await repository.prepareCommitCandidate(workspacePath('paper.md'));
    await workspace.writeFile(workspacePath('paper.md'), '# Changed again\n');
    await expect(repository.commitCandidate(fresh!, 'docs: revise paper', { actorId: 'ada', displayName: 'Ada', email: 'ada@example.test' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await repository.history())[0]?.message).toBe('docs: add paper');
  });

  it('rejects a candidate when the current branch moves without changing the index', async () => {
    const workspace = new MemoryWorkspace();
    await init({ fs: createGitFs(workspace), dir: '/repo', defaultBranch: 'main' });
    await workspace.writeFile(workspacePath('paper.md'), '# First\n');
    const repository = new IsomorphicGitRepository(workspace);
    await repository.stage(workspacePath('paper.md'));
    const first = await repository.commit('docs: add paper', { actorId: 'ada', displayName: 'Ada', email: 'ada@example.test' });
    await workspace.writeFile(workspacePath('guide.md'), '# Guide\n');
    await repository.stage(workspacePath('guide.md'));
    await repository.commit('docs: add guide', { actorId: 'ada', displayName: 'Ada', email: 'ada@example.test' });
    await workspace.writeFile(workspacePath('paper.md'), '# Revised\n');

    const candidate = await repository.prepareCommitCandidate(workspacePath('paper.md'));
    await workspace.writeFile(workspacePath('.git/refs/heads/main'), `${first}\n`);

    await expect(repository.commitCandidate(candidate!, 'docs: revise paper', { actorId: 'ada', displayName: 'Ada', email: 'ada@example.test' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await repository.status()).find((item) => item.path === 'paper.md')?.state).toBe('modified');
  });

  it('represents added, deleted, and binary candidate changes without decoding binary data', async () => {
    const workspace = new MemoryWorkspace();
    await init({ fs: createGitFs(workspace), dir: '/repo', defaultBranch: 'main' });
    await workspace.writeFile(workspacePath('removed.md'), '# Remove me\n');
    await workspace.writeBytes(workspacePath('figure.bin'), new Uint8Array([0, 1, 2]));
    const repository = new IsomorphicGitRepository(workspace);
    await repository.stage(workspacePath('removed.md'));
    await repository.stage(workspacePath('figure.bin'));
    await repository.commit('chore: add fixtures', { actorId: 'ada', displayName: 'Ada', email: 'ada@example.test' });

    await workspace.remove(workspacePath('removed.md'));
    await repository.stage(workspacePath('removed.md'));
    await workspace.writeBytes(workspacePath('figure.bin'), new Uint8Array([0, 3, 4]));
    const binary = await repository.prepareCommitCandidate(workspacePath('figure.bin'));
    expect(binary?.paths).toEqual(['figure.bin', 'removed.md']);
    expect(binary?.diff).toContain('Binary files a/figure.bin and b/figure.bin differ');
    expect(binary?.diff).toContain('-# Remove me');

    await workspace.writeFile(workspacePath('new.md'), '# New\n');
    const added = await repository.prepareCommitCandidate(workspacePath('new.md'));
    expect(added?.paths).toContain('new.md');
    expect(added?.diff).toContain('+# New');
  });

  const ada = { actorId: 'ada', displayName: 'Ada', email: 'ada@example.test' };
  async function repo(files: Record<string, string> = { 'paper.md': '# First\n' }) {
    const workspace = new MemoryWorkspace();
    await init({ fs: createGitFs(workspace), dir: '/repo', defaultBranch: 'main' });
    const repository = new IsomorphicGitRepository(workspace);
    for (const [path, content] of Object.entries(files)) { await workspace.writeFile(workspacePath(path), content); await repository.stage(workspacePath(path)); }
    await repository.commit('Initial', ada);
    return { workspace, repository };
  }
  const state = async (repository: IsomorphicGitRepository, path: string) => (await repository.status()).find((item) => item.path === path)?.state;

  it('updates the index and files after fast-forward and merge-commit merges', async () => {
    const { workspace, repository } = await repo({ 'paper.md': '# First\n', 'notes.md': '# Notes\n' });
    const paper = workspacePath('paper.md');
    await repository.createBranch('feature');
    await repository.checkout('feature');
    await workspace.writeFile(paper, '# Feature\n');
    await repository.stage(paper);
    await repository.commit('Feature edit', ada);
    await repository.checkout('main');
    expect(await workspace.readFile(paper)).toBe('# First\n');
    await repository.merge('feature', ada);
    expect(await workspace.readFile(paper)).toBe('# Feature\n');
    expect((await repository.status()).every((item) => item.state === 'unmodified')).toBe(true);

    await repository.checkout('feature');
    await workspace.writeFile(paper, '# Feature 2\n');
    await repository.stage(paper);
    await repository.commit('Feature edit 2', ada);
    await repository.checkout('main');
    await workspace.writeFile(workspacePath('notes.md'), '# Main notes\n');
    await repository.stage(workspacePath('notes.md'));
    await repository.commit('Main edit', ada);
    const merged = await repository.merge('feature', ada);
    expect((await repository.history(1))[0]).toMatchObject({ oid: merged, parents: expect.arrayContaining([expect.any(String), expect.any(String)]) });
    expect(await workspace.readFile(paper)).toBe('# Feature 2\n');
    expect(await workspace.readFile(workspacePath('notes.md'))).toBe('# Main notes\n');
    expect((await repository.status()).every((item) => item.state === 'unmodified')).toBe(true);
    // The next commit must build on the merged tree instead of reverting it.
    await workspace.writeFile(workspacePath('extra.md'), '# Extra\n');
    await repository.stage(workspacePath('extra.md'));
    await repository.commit('After merge', ada);
    expect(await repository.readFileAtRef(paper, 'HEAD')).toBe('# Feature 2\n');
  });

  it('refuses to merge into or check out over local changes', async () => {
    const { workspace, repository } = await repo();
    const paper = workspacePath('paper.md');
    await repository.createBranch('feature');
    await repository.checkout('feature');
    await workspace.writeFile(paper, '# Feature\n');
    await repository.stage(paper);
    await repository.commit('Feature edit', ada);
    await repository.checkout('main');
    const main = await resolveRef({ fs: createGitFs(workspace), dir: '/repo', ref: 'main' });
    await workspace.writeFile(paper, '# Local edit\n');
    await expect(repository.merge('feature', ada)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await resolveRef({ fs: createGitFs(workspace), dir: '/repo', ref: 'main' })).toBe(main);
    await expect(repository.checkout('feature')).rejects.toThrow();
    expect(await workspace.readFile(paper)).toBe('# Local edit\n');
    expect(await repository.currentBranch()).toBe('main');
  });

  it('keeps the executable bit recorded in the index when restaging', async () => {
    const { workspace, repository } = await repo({ 'run.sh': 'echo 1\n' });
    const fs = createGitFs(workspace);
    const oid = (await readTree({ fs, dir: '/repo', oid: await resolveRef({ fs, dir: '/repo', ref: 'HEAD' }) })).tree[0]!.oid;
    await updateIndex({ fs, dir: '/repo', filepath: 'run.sh', oid, mode: 0o100755 });
    await repository.commit('Make executable', ada);
    await workspace.writeFile(workspacePath('run.sh'), 'echo 2\n');
    await repository.stage(workspacePath('run.sh'));
    await repository.commit('Edit script', ada);
    const tree = await readTree({ fs, dir: '/repo', oid: await resolveRef({ fs, dir: '/repo', ref: 'HEAD' }) });
    expect(tree.tree[0]).toMatchObject({ path: 'run.sh', mode: '100755' });
  });

  it('excludes ignored untracked sidecars from candidates instead of failing every commit', async () => {
    const { workspace, repository } = await repo({ 'paper.md': '# First\n', '.gitignore': '.markroot/\n*.log\n' });
    const paper = workspacePath('paper.md');
    const sidecar = workspacePath('.markroot/comments/t/thread.yaml');
    await workspace.writeFile(paper, '# Revised\n');
    await workspace.writeFile(sidecar, 'id: t\n');
    const candidate = await repository.prepareCommitCandidate(paper, [sidecar]);
    expect(candidate?.ignored).toEqual([sidecar]);
    expect(candidate?.paths).toEqual([paper]);
    await repository.commitCandidate(candidate!, 'Revise', ada);
    expect(await repository.readFileAtRef(paper, 'HEAD')).toBe('# Revised\n');
    await workspace.writeFile(workspacePath('debug.log'), 'x');
    await expect(repository.prepareCommitCandidate(workspacePath('debug.log'))).rejects.toThrow(/ignored/);
    await expect(repository.stage(workspacePath('debug.log'))).rejects.toThrow(/ignored/);
  });

  it('does not descend into .git or untracked directories when preparing a candidate', async () => {
    const { workspace, repository } = await repo();
    await workspace.writeFile(workspacePath('node_modules/pkg/index.js'), 'x');
    await workspace.writeFile(workspacePath('paper.md'), '# Revised\n');
    const listFiles = vi.spyOn(workspace, 'listFiles');
    expect((await repository.prepareCommitCandidate(workspacePath('paper.md')))?.paths).toEqual(['paper.md']);
    const listed = listFiles.mock.calls.map(([path]) => path ?? '');
    expect(listed.filter((path) => path.startsWith('node_modules/') || path.startsWith('.git/objects'))).toEqual([]);
  });

  it('honours and releases .git/index.lock around mutations', async () => {
    const { workspace, repository } = await repo();
    const lock = workspacePath('.git/index.lock');
    await expect(workspace.stat(lock)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await workspace.writeFile(lock, '');
    await workspace.writeFile(workspacePath('paper.md'), '# Revised\n');
    await expect(repository.stage(workspacePath('paper.md'))).rejects.toThrow(/index\.lock/);
    await workspace.remove(lock);
    await repository.stage(workspacePath('paper.md'));
    await expect(workspace.stat(lock)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a candidate prepared on another branch at the same commit', async () => {
    const { workspace, repository } = await repo();
    await repository.createBranch('other');
    await workspace.writeFile(workspacePath('paper.md'), '# Revised\n');
    const candidate = await repository.prepareCommitCandidate(workspacePath('paper.md'));
    await workspace.writeFile(workspacePath('.git/HEAD'), 'ref: refs/heads/other\n');
    await expect(repository.commitCandidate(candidate!, 'Revise', ada)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('renames branches with their configuration', async () => {
    const { workspace, repository } = await repo();
    const fs = createGitFs(workspace);
    await setConfig({ fs, dir: '/repo', path: 'branch.main.remote', value: 'origin' });
    await repository.renameBranch('main', 'primary');
    expect(await repository.branches()).toEqual(['primary']);
    expect(await getConfig({ fs, dir: '/repo', path: 'branch.primary.remote' })).toBe('origin');
    expect(await getConfig({ fs, dir: '/repo', path: 'branch.main.remote' })).toBeUndefined();
  });

  it('diffs binaries without decoding them and surfaces real read errors', async () => {
    const { workspace, repository } = await repo();
    await workspace.writeBytes(workspacePath('figure.bin'), new Uint8Array([0, 1, 2]));
    expect(await repository.diff(workspacePath('figure.bin'))).toContain('Binary files');
    expect(await repository.diff(workspacePath('missing.md'))).not.toContain('@@');
    const read = workspace.readBytes.bind(workspace);
    vi.spyOn(workspace, 'readBytes').mockImplementation(async (path) => { if (path === 'paper.md') throw new MarkrootError('PERMISSION_DENIED', 'denied'); return read(path); });
    await expect(repository.diff(workspacePath('paper.md'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('never aliases a backslash file name to a nested path', async () => {
    const workspace = new MemoryWorkspace({ 'a/b': 'nested' });
    await expect((createGitFs(workspace) as unknown as { promises: { stat(path: string): Promise<unknown> } }).promises.stat('/repo/a\\b')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
