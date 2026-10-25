import type { AuthorIdentity } from '@markroot/core';

export type ThemePreference = 'system' | 'light' | 'dark';
export type PaneFont = 'serif' | 'sans' | 'mono';
export type OutlineDepth = 2 | 3 | 6;
export interface MarkrootSettings {
  readonly theme: ThemePreference;
  readonly autosave: boolean;
  readonly aiCommitSuggestions: boolean;
  readonly allowRemoteResources: boolean;
  readonly sourceFont: PaneFont;
  readonly sourceFontSize: number;
  readonly viewerFont: PaneFont;
  readonly viewerFontSize: number;
  readonly viewerJustified: boolean;
  readonly filesPaneWidth: number;
  readonly sourcePaneRatio: number;
  readonly outlineDepth: OutlineDepth;
  readonly outlineShowFigures: boolean;
  readonly profile: AuthorIdentity;
}

export interface PendingSession {
  /** Display name; also the legacy storage key when no workspaceId is given. */
  readonly workspaceName: string;
  /** Stable identity from workspaceIdFor(); folders with the same name no longer share recovery data. */
  readonly workspaceId?: string;
  readonly path: string;
  readonly source: string;
  readonly baseVersion?: string;
  readonly updatedAt: string;
}

const DATABASE = 'markroot';
const STORE = 'settings';
const SETTINGS_KEY = 'global';
const WORKSPACE_KEY = 'recent-workspace';
const WORKSPACE_IDS_KEY = 'workspace-ids';
const PROJECTS_KEY = 'recent-projects';
const MAX_RECENT_PROJECTS = 12;
const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark'];
const FONTS: readonly PaneFont[] = ['serif', 'sans', 'mono'];

/** Either a legacy workspace name or a stable workspace id (optionally with the name for migrating old recovery data). */
export type PendingWorkspace = string | { readonly id: string; readonly name?: string };
/** Key-value persistence; IndexedDB in the browser, replaceable for tests. */
export interface SettingsBackend {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}
/** Browser-local folder bookmark; forgetting it never removes files or recovery drafts. */
export interface RecentProject {
  readonly id: string;
  readonly name: string;
  readonly handle: FileSystemDirectoryHandle;
  readonly lastOpenedAt: number;
  readonly pinned?: boolean;
}
interface KnownWorkspace { readonly id: string; readonly handle: FileSystemDirectoryHandle }

export function defaultSettings(): MarkrootSettings {
  return {
    theme: 'system',
    autosave: false,
    aiCommitSuggestions: false,
    allowRemoteResources: false,
    sourceFont: 'mono',
    sourceFontSize: 14,
    viewerFont: 'serif',
    viewerFontSize: 17,
    viewerJustified: false,
    filesPaneWidth: 250,
    sourcePaneRatio: 0.5,
    outlineDepth: 2,
    outlineShowFigures: false,
    profile: { actorId: crypto.randomUUID(), displayName: 'Local author' },
  };
}

/** Repairs stored settings field by field; anything invalid falls back to the default. */
export function normalizeSettings(stored: unknown, defaults: MarkrootSettings = defaultSettings()): MarkrootSettings {
  const value = (stored && typeof stored === 'object' ? stored : {}) as Partial<Record<keyof MarkrootSettings, unknown>>;
  const flag = (key: 'autosave' | 'aiCommitSuggestions' | 'allowRemoteResources' | 'viewerJustified' | 'outlineShowFigures') => typeof value[key] === 'boolean' ? value[key] : defaults[key];
  const profile = (value.profile && typeof value.profile === 'object' ? value.profile : {}) as Partial<Record<keyof AuthorIdentity, unknown>>;
  const text = (input: unknown) => typeof input === 'string' && input.trim() ? input : undefined;
  const email = text(profile.email) ?? defaults.profile.email;
  return {
    theme: oneOf(value.theme, THEMES, defaults.theme),
    autosave: flag('autosave'),
    aiCommitSuggestions: flag('aiCommitSuggestions'),
    allowRemoteResources: flag('allowRemoteResources'),
    sourceFont: oneOf(value.sourceFont, FONTS, defaults.sourceFont),
    sourceFontSize: clampFontSize(value.sourceFontSize, defaults.sourceFontSize),
    viewerFont: oneOf(value.viewerFont, FONTS, defaults.viewerFont),
    viewerFontSize: clampFontSize(value.viewerFontSize, defaults.viewerFontSize),
    viewerJustified: flag('viewerJustified'),
    filesPaneWidth: clampNumber(value.filesPaneWidth, 180, 420, defaults.filesPaneWidth),
    sourcePaneRatio: clampNumber(value.sourcePaneRatio, 0.25, 0.75, defaults.sourcePaneRatio),
    outlineDepth: normalizeOutlineDepth(value.outlineDepth),
    outlineShowFigures: flag('outlineShowFigures'),
    profile: { actorId: text(profile.actorId) ?? defaults.profile.actorId, displayName: text(profile.displayName) ?? defaults.profile.displayName, ...(email ? { email } : {}) },
  };
}

/** Persists the first generated profile so the comment/review actor stays stable across launches. */
export async function loadSettings(): Promise<MarkrootSettings> {
  const stored = await backend.get<unknown>(SETTINGS_KEY);
  const settings = normalizeSettings(stored);
  if (JSON.stringify(settings) !== JSON.stringify(stored)) await backend.set(SETTINGS_KEY, settings);
  return settings;
}

export async function saveSettings(settings: MarkrootSettings): Promise<void> {
  if (typeof localStorage !== 'undefined') localStorage.setItem('markroot-theme', settings.theme);
  await backend.set(SETTINGS_KEY, settings);
}

export async function loadRecentWorkspace(): Promise<FileSystemDirectoryHandle | undefined> { return (await listRecentProjects())[0]?.handle; }
export async function saveRecentWorkspace(handle: FileSystemDirectoryHandle): Promise<void> { await rememberProject(handle); }

/** Shares the identity registry's lock and transaction, including first-load legacy migration. */
export async function listRecentProjects(): Promise<readonly RecentProject[]> {
  return withProjects((storage) => readProjects(storage));
}

export async function rememberProject(handle: FileSystemDirectoryHandle): Promise<RecentProject> {
  return withProjects(async (storage) => {
    const projects = await readProjects(storage);
    const id = await workspaceIdIn(storage, handle);
    const previous = projects.find((project) => project.id === id);
    const project: RecentProject = { ...previous, id, name: previous?.name ?? handle.name, handle, lastOpenedAt: Date.now() };
    await storage.set(PROJECTS_KEY, [project, ...projects.filter((item) => item.id !== id)].slice(0, MAX_RECENT_PROJECTS));
    return project;
  });
}

export async function forgetProject(id: string): Promise<void> {
  await withProjects(async (storage) => { await storage.set(PROJECTS_KEY, (await readProjects(storage)).filter((project) => project.id !== id)); });
}

/** An empty label resets the display name to the folder name. */
export async function renameProject(id: string, label: string): Promise<void> {
  await withProjects(async (storage) => {
    await storage.set(PROJECTS_KEY, (await readProjects(storage)).map((project) => project.id === id ? { ...project, name: label.trim() || project.handle.name } : project));
  });
}

function withProjects<T>(operation: (storage: SettingsBackend) => Promise<T>): Promise<T> {
  return withSettingsLock('markroot:workspace-ids', () => atomicBackend(operation));
}

async function readProjects(storage: SettingsBackend): Promise<readonly RecentProject[]> {
  const stored = await storage.get<readonly RecentProject[]>(PROJECTS_KEY);
  if (stored) return stored;
  const legacy = await storage.get<FileSystemDirectoryHandle>(WORKSPACE_KEY);
  const projects: readonly RecentProject[] = legacy ? [{ id: await workspaceIdIn(storage, legacy), name: legacy.name, handle: legacy, lastOpenedAt: Date.now() }] : [];
  await storage.set(PROJECTS_KEY, projects);
  await storage.delete(WORKSPACE_KEY);
  return projects;
}

/** Stable id for a folder: reuses the id of a known handle to the same entry, else assigns a new UUID. */
export async function workspaceIdFor(handle: FileSystemDirectoryHandle): Promise<string> {
  return withProjects((storage) => workspaceIdIn(storage, handle));
}

async function workspaceIdIn(storage: SettingsBackend, handle: FileSystemDirectoryHandle): Promise<string> {
  const known = await storage.get<readonly KnownWorkspace[]>(WORKSPACE_IDS_KEY) ?? [];
  for (const entry of known) if (await entry.handle.isSameEntry(handle).catch(() => false)) return entry.id;
  const id = crypto.randomUUID();
  await storage.set(WORKSPACE_IDS_KEY, [...known, { id, handle }]);
  return id;
}

export async function loadPendingSession(workspace: PendingWorkspace, path: string): Promise<PendingSession | undefined> {
  // Claim legacy recovery only when it actually supplies this load. Migrating immediately records
  // ownership persistently, so later deletion never needs to guess from a shared directory name.
  return withSettingsLock('markroot:pending-sessions', () => atomicBackend(async (storage) => {
    const key = pendingKey(workspace, path);
    const session = await storage.get<PendingSession>(key);
    if (session || typeof workspace === 'string' || !workspace.name) return session;
    const legacyKey = pendingKey(workspace.name, path);
    const legacy = await storage.get<PendingSession>(legacyKey);
    if (!legacy || (legacy.workspaceId && legacy.workspaceId !== workspace.id)) return undefined;
    const claimed = { ...legacy, workspaceId: workspace.id };
    await storage.set(key, claimed);
    await storage.delete(legacyKey);
    return claimed;
  }));
}
export async function savePendingSession(session: PendingSession): Promise<void> {
  await backend.set(pendingKey(session.workspaceId ? { id: session.workspaceId } : session.workspaceName, session.path), session);
}
export async function deletePendingSession(workspace: PendingWorkspace, path: string): Promise<void> {
  await backend.delete(pendingKey(workspace, path));
}

const indexedDbBackend: SettingsBackend = { get: getValue, set: setValue, delete: deleteValue };
let backend: SettingsBackend = indexedDbBackend;
/** Swap persistence (tests, embedding); call without arguments to restore IndexedDB. */
export function setSettingsBackend(next: SettingsBackend = indexedDbBackend): void { backend = next; }

async function withSettingsLock<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(name, { mode: 'exclusive' }, run);
  return run();
}

const backendQueues = new WeakMap<SettingsBackend, Promise<unknown>>();
/** Custom backends retain the original get/set/delete seam; serialize their operations in-process. */
async function atomicBackend<T>(operation: (storage: SettingsBackend) => Promise<T>): Promise<T> {
  const storage = backend;
  if (storage === indexedDbBackend) return indexedDbTransaction(operation);
  const next = (backendQueues.get(storage) ?? Promise.resolve()).then(() => operation(storage));
  backendQueues.set(storage, next.catch(() => undefined));
  return next;
}

/** The complete registry read/compare/write shares one readwrite transaction, even without Web Locks. */
async function indexedDbTransaction<T>(operation: (storage: SettingsBackend) => Promise<T>): Promise<T> {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    let finished = false;
    let result: T;
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => { finished = true; reject(transaction.error); };
    transaction.onabort = () => { finished = true; reject(transaction.error ?? new Error('Settings transaction aborted.')); };
    const request = <V>(value: IDBRequest<V>) => new Promise<V>((done, fail) => {
      value.onsuccess = () => done(value.result);
      value.onerror = () => fail(value.error);
    });
    const storage: SettingsBackend = {
      get: async <V>(key: string) => await request(store.get(key)) as V | undefined,
      set: async <V>(key: string, value: V) => { await request(store.put(value, key)); },
      delete: async (key: string) => { await request(store.delete(key)); },
    };
    // isSameEntry() is asynchronous outside IDB. Keep a request pending until it settles;
    // otherwise IDB auto-commits before the comparison can enqueue the registry update.
    const keepAlive = () => {
      if (finished) return;
      const pending = store.get(WORKSPACE_IDS_KEY);
      pending.onsuccess = keepAlive;
    };
    keepAlive();
    void operation(storage).then((value) => { result = value; finished = true; }, (error: unknown) => {
      finished = true;
      reject(error);
      try { transaction.abort(); } catch { /* A failed request may already have aborted it. */ }
    });
  }).finally(() => db.close());
}

function database(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getValue<T>(key: string): Promise<T | undefined> {
  const db = await database();
  return new Promise<T | undefined>((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}

async function setValue<T>(key: string, value: T): Promise<void> {
  const db = await database();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  }).finally(() => db.close());
}

async function deleteValue(key: string): Promise<void> {
  const db = await database();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  }).finally(() => db.close());
}

function pendingKey(workspace: PendingWorkspace, path: string): string { return typeof workspace === 'string' ? `pending:${workspace}:${path}` : `pending-id:${workspace.id}:${path}`; }
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T { return allowed.includes(value as T) ? value as T : fallback; }
function clampFontSize(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(12, Math.min(28, Math.round(value))) : fallback;
}
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
function normalizeOutlineDepth(value: unknown): OutlineDepth { return value === 3 || value === 6 ? value : 2; }
