import { describe, expect, it } from 'vitest';
import { init } from 'isomorphic-git';
import { workspacePath } from '@markroot/core';
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
});
