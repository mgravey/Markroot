import { describe, expect, it, vi } from 'vitest';
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

/** Minimal in-memory File System Access handles with a frozen clock (coarse mtime). */
class FakeFile {
  readonly kind = 'file';
  move?: (parent: FakeDirectory, name: string) => Promise<void>;
  constructor(public name: string, public bytes: Uint8Array, public parent: FakeDirectory, public lastModified = 1000) {}
  async getFile() { return new File([this.bytes.slice()], this.name, { lastModified: this.lastModified }); }
  async createWritable() {
    let next = new Uint8Array();
    return { write: async (chunk: Uint8Array) => { next = new Uint8Array(chunk); }, close: async () => { this.bytes = next; }, abort: async () => undefined };
  }
}
class FakeDirectory {
  readonly kind = 'directory';
  readonly children = new Map<string, FakeFile | FakeDirectory>();
  move?: (parent: FakeDirectory, name: string) => Promise<void>;
  constructor(public name: string, public parent?: FakeDirectory, readonly native = false) {}
  private adopt<T extends FakeFile | FakeDirectory>(entry: T): T {
    if (this.native) entry.move = async (parent, name) => { entry.parent!.children.delete(entry.name); entry.name = name; entry.parent = parent; parent.children.set(name, entry); };
    this.children.set(entry.name, entry);
    return entry;
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const entry = this.children.get(name);
    if (entry instanceof FakeDirectory) return entry;
    if (entry) throw new DOMException('File', 'TypeMismatchError');
    if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
    return this.adopt(new FakeDirectory(name, this, this.native));
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    const entry = this.children.get(name);
    if (entry instanceof FakeFile) return entry;
    if (entry) throw new DOMException('Directory', 'TypeMismatchError');
    if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
    return this.adopt(new FakeFile(name, new Uint8Array(), this));
  }
  async *entries() { yield* this.children.entries(); }
  async removeEntry(name: string, options?: { recursive?: boolean }) {
    const entry = this.children.get(name);
    if (!entry) throw new DOMException('Missing', 'NotFoundError');
    if (entry instanceof FakeDirectory && entry.children.size && !options?.recursive) throw new DOMException('Not empty', 'InvalidModificationError');
    this.children.delete(name);
  }
  put(path: string, content: string): FakeFile {
    const parts = path.split('/');
    let dir: FakeDirectory = this;
    for (const part of parts.slice(0, -1)) dir = (dir.children.get(part) as FakeDirectory | undefined) ?? dir.adopt(new FakeDirectory(part, dir, this.native));
    return dir.adopt(new FakeFile(parts.at(-1)!, new TextEncoder().encode(content), dir));
  }
}
const asRoot = (dir: FakeDirectory) => dir as unknown as FileSystemDirectoryHandle;

describe('FileSystemAccessWorkspace safety', () => {
  it('detects same-size edits that keep the coarse mtime:size version', async () => {
    const root = new FakeDirectory('project');
    const file = root.put('paper.md', '# One');
    const workspace = new FileSystemAccessWorkspace(asRoot(root));
    const path = workspacePath('paper.md');
    expect(await workspace.readFile(path)).toBe('# One');
    const version = (await workspace.stat(path)).version;
    file.bytes = new TextEncoder().encode('# Two');
    expect((await workspace.stat(path)).version).toBe(version);
    await expect(workspace.writeFileGuarded(path, '# Mine', version)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(new TextDecoder().decode(file.bytes)).toBe('# Two');
    expect(await workspace.readFile(path)).toBe('# Two');
    const saved = await workspace.writeFileGuarded(path, '# Mine', version);
    await expect(workspace.writeFileGuarded(path, '# Next', saved.version)).resolves.toMatchObject({ path });
  });

  it('keeps the destination when reading the source fails during an overwriting move', async () => {
    const root = new FakeDirectory('project');
    root.put('a.md', 'A');
    root.put('b.md', 'B');
    const workspace = new FileSystemAccessWorkspace(asRoot(root));
    vi.spyOn(workspace, 'readBytes').mockRejectedValueOnce(new Error('read failed'));
    await expect(workspace.move(workspacePath('a.md'), workspacePath('b.md'), { overwrite: true })).rejects.toThrow('read failed');
    expect(await workspace.readFile(workspacePath('b.md'))).toBe('B');
    expect(await workspace.readFile(workspacePath('a.md'))).toBe('A');
    vi.restoreAllMocks();
    await workspace.move(workspacePath('a.md'), workspacePath('b.md'), { overwrite: true });
    expect(await workspace.readFile(workspacePath('b.md'))).toBe('A');
    expect((await listTree(workspace)).map((entry) => entry.path)).toEqual(['b.md']);
  });

  it('uses native FileSystemHandle.move for files and directories', async () => {
    const root = new FakeDirectory('project', undefined, true);
    const nested = root.put('notes/deep/a.md', 'A');
    root.put('other.md', 'O');
    const workspace = new FileSystemAccessWorkspace(asRoot(root));
    const write = vi.spyOn(workspace, 'writeBytes');
    await workspace.move(workspacePath('notes'), workspacePath('archive/notes'));
    await workspace.move(workspacePath('other.md'), workspacePath('archive/notes/deep/a.md'), { overwrite: true });
    expect(write).not.toHaveBeenCalled();
    expect((await listTree(workspace)).map((entry) => entry.path)).toEqual(['archive', 'archive/notes', 'archive/notes/deep', 'archive/notes/deep/a.md']);
    expect(await workspace.readFile(workspacePath('archive/notes/deep/a.md'))).toBe('O');
    expect(nested.parent.children.size).toBe(1);
  });

  it('skips unrepresentable names instead of failing the listing, and locks by workspace id', async () => {
    const root = new FakeDirectory('project');
    root.put('good.md', 'G');
    root.put('bad\\name.md', 'B');
    root.put('bad\\', 'B');
    const workspace = new FileSystemAccessWorkspace(asRoot(root), { id: 'ws-1' });
    expect((await workspace.listFiles()).map((entry) => entry.path)).toEqual(['good.md']);
    expect([...workspace.skippedEntries].sort()).toEqual(['bad\\', 'bad\\name.md']);
    expect(workspace.lockName).toBe('markroot:workspace:ws-1');
    expect(new FileSystemAccessWorkspace(asRoot(root)).lockName).toBe('markroot:workspace:project');
  });
});
