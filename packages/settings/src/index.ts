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

export async function loadRecentWorkspace(): Promise<FileSystemDirectoryHandle | undefined> { return backend.get<FileSystemDirectoryHandle>(WORKSPACE_KEY); }
export async function saveRecentWorkspace(handle: FileSystemDirectoryHandle): Promise<void> { await backend.set(WORKSPACE_KEY, handle); }

/** Stable id for a folder: reuses the id of a known handle to the same entry, else assigns a new UUID. */
export async function workspaceIdFor(handle: FileSystemDirectoryHandle): Promise<string> {
  const known = await backend.get<readonly KnownWorkspace[]>(WORKSPACE_IDS_KEY) ?? [];
  for (const entry of known) if (await entry.handle.isSameEntry(handle).catch(() => false)) return entry.id;
  const id = crypto.randomUUID();
  await backend.set(WORKSPACE_IDS_KEY, [...known, { id, handle }]);
  return id;
}

export async function loadPendingSession(workspace: PendingWorkspace, path: string): Promise<PendingSession | undefined> {
  const session = await backend.get<PendingSession>(pendingKey(workspace, path));
  if (session || typeof workspace === 'string' || !workspace.name) return session;
  return backend.get<PendingSession>(pendingKey(workspace.name, path));
}
export async function savePendingSession(session: PendingSession): Promise<void> {
  await backend.set(pendingKey(session.workspaceId ? { id: session.workspaceId } : session.workspaceName, session.path), session);
}
export async function deletePendingSession(workspace: PendingWorkspace, path: string): Promise<void> {
  await backend.delete(pendingKey(workspace, path));
  if (typeof workspace !== 'string' && workspace.name) await backend.delete(pendingKey(workspace.name, path));
}

const indexedDbBackend: SettingsBackend = { get: getValue, set: setValue, delete: deleteValue };
let backend: SettingsBackend = indexedDbBackend;
/** Swap persistence (tests, embedding); call without arguments to restore IndexedDB. */
export function setSettingsBackend(next: SettingsBackend = indexedDbBackend): void { backend = next; }

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
