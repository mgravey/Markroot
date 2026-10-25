import {
  MarkrootError,
  throwIfAborted,
  workspacePath,
  type OperationContext,
  type WorkspacePath,
} from '@markroot/core';

export type WorkspaceEntryKind = 'file' | 'directory';

export interface WorkspaceEntry {
  readonly path: WorkspacePath;
  readonly kind: WorkspaceEntryKind;
}

export interface WorkspaceStat extends WorkspaceEntry {
  readonly size: number;
  readonly modifiedAt?: number;
  readonly version?: string;
}

/** Structurally compatible with Loom's binary ProjectWorkspace. */
export interface ProjectWorkspace {
  listFiles(path?: WorkspacePath, context?: OperationContext): Promise<readonly WorkspaceEntry[]>;
  readFile(path: WorkspacePath, context?: OperationContext): Promise<string>;
  writeFile(path: WorkspacePath, content: string, context?: OperationContext): Promise<boolean>;
  stat(path: WorkspacePath, context?: OperationContext): Promise<WorkspaceStat>;
  readBytes(path: WorkspacePath, context?: OperationContext): Promise<Uint8Array>;
  writeBytes(path: WorkspacePath, content: Uint8Array, context?: OperationContext): Promise<boolean>;
  createDirectory(path: WorkspacePath, options?: Readonly<{ recursive?: boolean }>, context?: OperationContext): Promise<boolean>;
  move(source: WorkspacePath, destination: WorkspacePath, options?: Readonly<{ overwrite?: boolean }>, context?: OperationContext): Promise<void>;
  remove(path: WorkspacePath, options?: Readonly<{ recursive?: boolean }>, context?: OperationContext): Promise<void>;
}

export interface GuardedWorkspace extends ProjectWorkspace {
  writeFileGuarded(path: WorkspacePath, content: string, expectedVersion?: string, context?: OperationContext): Promise<WorkspaceStat>;
}

interface MutableNode { kind: WorkspaceEntryKind; bytes?: Uint8Array; modifiedAt: number }

export class MemoryWorkspace implements GuardedWorkspace {
  private readonly nodes = new Map<string, MutableNode>();
  private clock = 1;

  constructor(seed?: Readonly<Record<string, string | Uint8Array>>) {
    for (const [path, value] of Object.entries(seed ?? {})) {
      const normalized = workspacePath(path);
      this.ensureParents(normalized);
      this.nodes.set(normalized, { kind: 'file', bytes: encode(value), modifiedAt: this.clock++ });
    }
  }

  async listFiles(path?: WorkspacePath): Promise<readonly WorkspaceEntry[]> {
    const prefix = path ? `${path}/` : '';
    const entries = new Map<string, WorkspaceEntry>();
    for (const key of this.nodes.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      const node = this.nodes.get(key)!;
      entries.set(key, { path: key as WorkspacePath, kind: node.kind });
    }
    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async readFile(path: WorkspacePath): Promise<string> { return new TextDecoder().decode(await this.readBytes(path)); }

  async readBytes(path: WorkspacePath): Promise<Uint8Array> {
    const node = this.nodes.get(path);
    if (!node || node.kind !== 'file') throw new MarkrootError('NOT_FOUND', `File not found: ${path}`);
    return node.bytes!.slice();
  }

  async writeFile(path: WorkspacePath, content: string): Promise<boolean> { return this.writeBytes(path, new TextEncoder().encode(content)); }

  async writeBytes(path: WorkspacePath, content: Uint8Array): Promise<boolean> {
    this.ensureParents(path);
    const created = !this.nodes.has(path);
    this.nodes.set(path, { kind: 'file', bytes: content.slice(), modifiedAt: this.clock++ });
    return created;
  }

  async writeFileGuarded(path: WorkspacePath, content: string, expectedVersion?: string): Promise<WorkspaceStat> {
    if (expectedVersion !== undefined) {
      const current = await this.stat(path);
      if (current.version !== expectedVersion) throw new MarkrootError('CONFLICT', `File changed outside Markroot: ${path}`);
    }
    await this.writeFile(path, content);
    return this.stat(path);
  }

  async stat(path: WorkspacePath): Promise<WorkspaceStat> {
    const node = this.nodes.get(path);
    if (!node) throw new MarkrootError('NOT_FOUND', `Entry not found: ${path}`);
    const size = node.kind === 'file' ? node.bytes!.byteLength : 0;
    return { path, kind: node.kind, size, modifiedAt: node.modifiedAt, version: `${node.modifiedAt}:${size}` };
  }

  async createDirectory(path: WorkspacePath, options?: Readonly<{ recursive?: boolean }>): Promise<boolean> {
    if (this.nodes.has(path)) return false;
    if (options?.recursive) this.ensureParents(path);
    else {
      const parent = parentPath(path);
      if (parent && this.nodes.get(parent)?.kind !== 'directory') throw new MarkrootError('NOT_FOUND', `Parent not found: ${parent}`);
    }
    this.nodes.set(path, { kind: 'directory', modifiedAt: this.clock++ });
    return true;
  }

  async move(source: WorkspacePath, destination: WorkspacePath, options?: Readonly<{ overwrite?: boolean }>): Promise<void> {
    const node = this.nodes.get(source);
    if (!node) throw new MarkrootError('NOT_FOUND', `Entry not found: ${source}`);
    if (this.nodes.has(destination) && !options?.overwrite) throw new MarkrootError('CONFLICT', `Entry exists: ${destination}`);
    if (this.nodes.has(destination)) await this.remove(destination, { recursive: true });
    this.ensureParents(destination);
    const affected = [...this.nodes.entries()].filter(([key]) => key === source || key.startsWith(`${source}/`));
    for (const [key, value] of affected) {
      const target = `${destination}${key.slice(source.length)}`;
      this.nodes.set(target, { kind: value.kind, ...(value.bytes ? { bytes: value.bytes.slice() } : {}), modifiedAt: this.clock++ });
      this.nodes.delete(key);
    }
  }

  async remove(path: WorkspacePath, options?: Readonly<{ recursive?: boolean }>): Promise<void> {
    const children = [...this.nodes.keys()].filter((key) => key.startsWith(`${path}/`));
    if (children.length && !options?.recursive) throw new MarkrootError('CONFLICT', `Directory is not empty: ${path}`);
    if (!this.nodes.delete(path) && children.length === 0) throw new MarkrootError('NOT_FOUND', `Entry not found: ${path}`);
    for (const child of children) this.nodes.delete(child);
  }

  private ensureParents(path: WorkspacePath): void {
    const parts = path.split('/');
    parts.pop();
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.nodes.has(current)) this.nodes.set(current, { kind: 'directory', modifiedAt: this.clock++ });
    }
  }
}

type PermissionMode = 'read' | 'readwrite';
interface PermissionCapableHandle {
  queryPermission?(options: { mode: PermissionMode }): Promise<PermissionState>;
  requestPermission?(options: { mode: PermissionMode }): Promise<PermissionState>;
}
interface MovableHandle { move?(parent: FileSystemDirectoryHandle, name: string): Promise<void> }
interface IterableDirectoryHandle extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void>;
}

export async function ensureDirectoryPermission(root: FileSystemDirectoryHandle, request = false): Promise<PermissionState> {
  const handle = root as FileSystemDirectoryHandle & PermissionCapableHandle;
  const options = { mode: 'readwrite' as const };
  const current = await handle.queryPermission?.(options) ?? 'prompt';
  if (current === 'granted' || !request) return current;
  return await handle.requestPermission?.(options) ?? 'denied';
}

export interface FileSystemAccessWorkspaceOptions {
  /** Stable workspace identity (e.g. settings' workspaceIdFor); folder names are not unique. */
  readonly id?: string;
}

export class FileSystemAccessWorkspace implements GuardedWorkspace {
  readonly lockName: string;
  /** Entries the browser listed but no workspace path can represent (e.g. names containing `\`). */
  readonly skippedEntries = new Set<string>();
  /** Content hashes of files as last read or written, keyed by their coarse `mtime:size` version. */
  private readonly knownContent = new Map<string, { readonly version: string; readonly hash: string }>();
  constructor(readonly root: FileSystemDirectoryHandle, options: FileSystemAccessWorkspaceOptions = {}) { this.lockName = `markroot:workspace:${options.id ?? root.name}`; }

  async listFiles(path?: WorkspacePath, context?: OperationContext): Promise<readonly WorkspaceEntry[]> {
    const dir = await this.directory(path, false, context);
    const entries: WorkspaceEntry[] = [];
    try {
      for await (const [name, handle] of (dir as IterableDirectoryHandle).entries()) {
        throwIfAborted(context);
        const raw = path ? `${path}/${name}` : name;
        // workspacePath() would rewrite `a\b` to `a/b`; skip names that cannot round-trip instead of failing the listing.
        if (name.includes('\\') || name.includes('/') || name === '.' || name === '..') { this.skippedEntries.add(raw); continue; }
        entries.push({ path: workspacePath(raw), kind: handle.kind });
      }
    } catch (cause) { throw mapFsError(cause, path ?? ('.' as WorkspacePath)); }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Text reads (documents, sidecars) remember a content hash for guarded writes; binary/Git reads do not pay for it. */
  async readFile(path: WorkspacePath, context?: OperationContext): Promise<string> {
    const { bytes, file } = await this.read(path, context);
    this.knownContent.set(path, { version: fileVersion(file), hash: await contentHash(bytes) });
    return new TextDecoder().decode(bytes);
  }

  async readBytes(path: WorkspacePath, context?: OperationContext): Promise<Uint8Array> { return (await this.read(path, context)).bytes; }

  private async read(path: WorkspacePath, context?: OperationContext): Promise<{ readonly bytes: Uint8Array; readonly file: File }> {
    throwIfAborted(context);
    try {
      const handle = await this.fileHandle(path, false, context);
      const file = await handle.getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      throwIfAborted(context);
      return { bytes, file };
    } catch (cause) { throw mapFsError(cause, path); }
  }

  async writeFile(path: WorkspacePath, content: string, context?: OperationContext): Promise<boolean> {
    return this.writeBytes(path, new TextEncoder().encode(content), context);
  }

  async writeBytes(path: WorkspacePath, content: Uint8Array, context?: OperationContext): Promise<boolean> {
    throwIfAborted(context);
    let existed = true;
    try { await this.fileHandle(path, false, context); } catch (error) {
      if (error instanceof MarkrootError && error.code === 'NOT_FOUND') existed = false;
      else throw error;
    }
    try {
      const handle = await this.fileHandle(path, true, context);
      const writable = await handle.createWritable();
      try {
        await writable.write(content.slice());
        throwIfAborted(context);
        await writable.close();
      } catch (cause) { await writable.abort(cause).catch(() => undefined); throw cause; }
      return !existed;
    } catch (cause) { throw mapFsError(cause, path); }
  }

  async writeFileGuarded(path: WorkspacePath, content: string, expectedVersion?: string, context?: OperationContext): Promise<WorkspaceStat> {
    return withBrowserLock(this.lockName, async () => {
      if (expectedVersion !== undefined) {
        const current = await this.stat(path, context);
        if (current.version !== expectedVersion) throw new MarkrootError('CONFLICT', `File changed outside Markroot: ${path}`);
        // `mtime:size` misses same-size edits within the timestamp resolution; re-check the content we last saw.
        const known = this.knownContent.get(path);
        if (known?.version === expectedVersion) {
          const file = await (await this.fileHandle(path, false, context)).getFile();
          if (await contentHash(new Uint8Array(await file.arrayBuffer())) !== known.hash) throw new MarkrootError('CONFLICT', `File changed outside Markroot: ${path}`);
        }
      }
      const bytes = new TextEncoder().encode(content);
      await this.writeBytes(path, bytes, context);
      const stat = await this.stat(path, context);
      if (stat.version) this.knownContent.set(path, { version: stat.version, hash: await contentHash(bytes) });
      return stat;
    });
  }

  async stat(path: WorkspacePath, context?: OperationContext): Promise<WorkspaceStat> {
    throwIfAborted(context);
    try {
      const handle = await this.fileHandle(path, false, context);
      const file = await handle.getFile();
      return { path, kind: 'file', size: file.size, modifiedAt: file.lastModified, version: fileVersion(file) };
    } catch (error) {
      if (!(error instanceof MarkrootError && error.code === 'NOT_FOUND') && !hasDomExceptionName(error, 'TypeMismatchError')) throw error;
    }
    try { await this.directory(path, false, context); return { path, kind: 'directory', size: 0 }; }
    catch (cause) { throw mapFsError(cause, path); }
  }

  async createDirectory(path: WorkspacePath, options?: Readonly<{ recursive?: boolean }>, context?: OperationContext): Promise<boolean> {
    try { await this.directory(path, false, context); return false; } catch (error) {
      if (!(error instanceof MarkrootError && error.code === 'NOT_FOUND')) throw error;
    }
    if (options?.recursive) { await this.directory(path, true, context); return true; }
    const [parent, name] = splitPath(path);
    await (await this.directory(parent, false, context)).getDirectoryHandle(name, { create: true });
    return true;
  }

  async move(source: WorkspacePath, destination: WorkspacePath, options?: Readonly<{ overwrite?: boolean }>, context?: OperationContext): Promise<void> {
    if (source === destination || destination.startsWith(`${source}/`)) throw new MarkrootError('INVALID_PATH', 'Cannot move an entry into itself.');
    const { kind } = await this.stat(source, context);
    let targetExists = true;
    try { await this.stat(destination, context); } catch (error) {
      if (error instanceof MarkrootError && error.code === 'NOT_FOUND') targetExists = false;
      else throw error;
    }
    if (targetExists && !options?.overwrite) throw new MarkrootError('CONFLICT', `Entry exists: ${destination}`);
    const [parent, name] = splitPath(destination);
    if (parent) await this.createDirectory(parent, { recursive: true }, context);
    if (!targetExists) return this.relocate(source, kind, destination, context);
    // Never delete the destination before the source is safely staged beside it.
    const staging = workspacePath(`${parent ? `${parent}/` : ''}.${name}.markroot-move-${crypto.randomUUID()}`);
    await this.relocate(source, kind, staging, context);
    await this.remove(destination, { recursive: true }, context);
    await this.relocate(staging, kind, destination, context);
  }

  async remove(path: WorkspacePath, options?: Readonly<{ recursive?: boolean }>, context?: OperationContext): Promise<void> {
    throwIfAborted(context);
    const [parent, name] = splitPath(path);
    try { await (await this.directory(parent, false, context) as IterableDirectoryHandle).removeEntry(name, { recursive: options?.recursive === true }); }
    catch (cause) { throw mapFsError(cause, path); }
  }

  /** Native FileSystemHandle.move() when available; otherwise copy, then delete the source. */
  private async relocate(source: WorkspacePath, kind: WorkspaceEntryKind, destination: WorkspacePath, context?: OperationContext): Promise<void> {
    const handle: FileSystemHandle & MovableHandle = kind === 'file' ? await this.fileHandle(source, false, context) : await this.directory(source, false, context);
    if (typeof handle.move === 'function') {
      const [parent, name] = splitPath(destination);
      try { await handle.move(await this.directory(parent, false, context), name); this.knownContent.delete(source); return; }
      catch (cause) { if (!hasDomExceptionName(cause, 'NotSupportedError') && !(cause instanceof TypeError)) throw mapFsError(cause, source); }
    }
    if (kind === 'file') await this.writeBytes(destination, await this.readBytes(source, context), context);
    else { await this.createDirectory(destination, { recursive: true }, context); await this.copyChildren(await this.directory(source, false, context), await this.directory(destination, false, context), context); }
    await this.remove(source, { recursive: true }, context);
    this.knownContent.delete(source);
  }

  /** Raw handles preserve names listFiles intentionally hides; never delete a partially copied source. */
  private async copyChildren(source: FileSystemDirectoryHandle, destination: FileSystemDirectoryHandle, context?: OperationContext): Promise<void> {
    for await (const [name, entry] of (source as IterableDirectoryHandle).entries()) {
      throwIfAborted(context);
      if (entry.kind === 'directory') {
        await this.copyChildren(await source.getDirectoryHandle(name), await destination.getDirectoryHandle(name, { create: true }), context);
      } else {
        const file = await (await source.getFileHandle(name)).getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        throwIfAborted(context);
        const writable = await (await destination.getFileHandle(name, { create: true })).createWritable();
        try {
          await writable.write(bytes);
          throwIfAborted(context);
          await writable.close();
        } catch (cause) { await writable.abort(cause).catch(() => undefined); throw cause; }
      }
    }
  }

  private async directory(path: WorkspacePath | undefined, create: boolean, context?: OperationContext): Promise<FileSystemDirectoryHandle> {
    throwIfAborted(context);
    let current = this.root;
    for (const part of path?.split('/') ?? []) {
      try { current = await current.getDirectoryHandle(part, { create }); }
      catch (cause) { throw mapFsError(cause, path!); }
      throwIfAborted(context);
    }
    return current;
  }

  private async fileHandle(path: WorkspacePath, create: boolean, context?: OperationContext): Promise<FileSystemFileHandle> {
    const [parent, name] = splitPath(path);
    try { return await (await this.directory(parent, create, context)).getFileHandle(name, { create }); }
    catch (cause) { throw mapFsError(cause, path); }
  }
}

export async function listTree(workspace: ProjectWorkspace, root?: WorkspacePath, context?: OperationContext): Promise<readonly WorkspaceEntry[]> {
  const result: WorkspaceEntry[] = [];
  for (const entry of await workspace.listFiles(root, context)) {
    result.push(entry);
    if (entry.kind === 'directory') result.push(...await listTree(workspace, entry.path, context));
  }
  return result;
}

function splitPath(path: WorkspacePath): [WorkspacePath | undefined, string] {
  const index = path.lastIndexOf('/');
  return index < 0 ? [undefined, path] : [workspacePath(path.slice(0, index)), path.slice(index + 1)];
}

function parentPath(path: WorkspacePath): WorkspacePath | undefined { return splitPath(path)[0]; }
function encode(value: string | Uint8Array): Uint8Array { return typeof value === 'string' ? new TextEncoder().encode(value) : value.slice(); }

function mapFsError(cause: unknown, path: WorkspacePath): MarkrootError {
  const name = typeof cause === 'object' && cause && 'name' in cause ? String(cause.name) : '';
  if (name === 'NotFoundError' || (cause instanceof MarkrootError && cause.code === 'NOT_FOUND')) return new MarkrootError('NOT_FOUND', `Entry not found: ${path}`, undefined, { cause });
  if (name === 'NotAllowedError' || name === 'SecurityError') return new MarkrootError('PERMISSION_DENIED', `Permission denied: ${path}`, undefined, { cause });
  if (cause instanceof MarkrootError) return cause;
  return new MarkrootError('WORKSPACE_ERROR', `Workspace operation failed: ${path}`, undefined, { cause });
}

function fileVersion(file: File): string { return `${file.lastModified}:${file.size}`; }
async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hasDomExceptionName(error: unknown, name: string): boolean {
  let current = error;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    if (typeof current === 'object' && 'name' in current && current.name === name) return true;
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return false;
}

async function withBrowserLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks) return operation();
  return navigator.locks.request(name, { mode: 'exclusive' }, operation);
}
