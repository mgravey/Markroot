import { describe, expect, it } from 'vitest';
import { workspacePath } from '@markroot/core';
import { MemoryWorkspace, listTree } from './index.js';

describe('MemoryWorkspace', () => {
  it('supports guarded writes and recursive traversal', async () => {
    const workspace = new MemoryWorkspace({ 'notes/a.md': '# A' });
    const path = workspacePath('notes/a.md');
    const before = await workspace.stat(path);
    await workspace.writeFileGuarded(path, '# B', before.version);
    expect(await workspace.readFile(path)).toBe('# B');
    expect((await listTree(workspace)).map((entry) => entry.path)).toEqual(['notes', 'notes/a.md']);
    await expect(workspace.writeFileGuarded(path, '# C', before.version)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
