import { describe, expect, it } from 'vitest';
import { workspacePath } from '@markroot/core';
import { FileSystemAccessWorkspace, MemoryWorkspace, listTree } from './index.js';

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

describe('FileSystemAccessWorkspace', () => {
  it('falls through to a directory probe after Chromium reports a file type mismatch', async () => {
    const dotGit = {
      kind: 'directory',
      name: '.git',
      async getDirectoryHandle(): Promise<never> { throw new DOMException('Missing', 'NotFoundError'); },
      async getFileHandle(): Promise<never> { throw new DOMException('Missing', 'NotFoundError'); },
    } as unknown as FileSystemDirectoryHandle;
    const root = {
      kind: 'directory',
      name: 'repository',
      async getFileHandle(name: string): Promise<FileSystemFileHandle> {
        if (name === '.git') throw new DOMException('The entry is a directory', 'TypeMismatchError');
        throw new DOMException('Missing', 'NotFoundError');
      },
      async getDirectoryHandle(name: string): Promise<FileSystemDirectoryHandle> {
        if (name === '.git') return dotGit;
        throw new DOMException('Missing', 'NotFoundError');
      },
    } as unknown as FileSystemDirectoryHandle;

    await expect(new FileSystemAccessWorkspace(root).stat(workspacePath('.git'))).resolves.toMatchObject({
      path: '.git',
      kind: 'directory',
    });
  });
});
