import { describe, expect, it } from 'vitest';
import { init } from 'isomorphic-git';
import { workspacePath } from '@markroot/core';
import { MemoryWorkspace } from '@markroot/workspace';
import { createGitFs, IsomorphicGitRepository } from './index.js';

describe('IsomorphicGitRepository', () => {
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
});
