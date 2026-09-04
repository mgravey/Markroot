import type { AuthorIdentity } from '@markroot/core';

export type ThemePreference = 'system' | 'light' | 'dark';
export type PaneFont = 'serif' | 'sans' | 'mono';
export interface MarkrootSettings {
  readonly theme: ThemePreference;
  readonly autosave: boolean;
  readonly allowRemoteResources: boolean;
  readonly sourceFont: PaneFont;
  readonly sourceFontSize: number;
  readonly viewerFont: PaneFont;
  readonly viewerFontSize: number;
  readonly viewerJustified: boolean;
  readonly profile: AuthorIdentity;
}

export interface PendingSession {
  readonly workspaceName: string;
  readonly path: string;
  readonly source: string;
  readonly baseVersion?: string;
  readonly updatedAt: string;
}

const DATABASE = 'markroot';
const STORE = 'settings';
const SETTINGS_KEY = 'global';
const WORKSPACE_KEY = 'recent-workspace';

export function defaultSettings(): MarkrootSettings {
  return {
    theme: 'system',
    autosave: false,
    allowRemoteResources: false,
    sourceFont: 'mono',
    sourceFontSize: 14,
    viewerFont: 'serif',
    viewerFontSize: 17,
    viewerJustified: false,
    profile: { actorId: crypto.randomUUID(), displayName: 'Local author' },
  };
}

export async function loadSettings(): Promise<MarkrootSettings> {
  const stored = await getValue<MarkrootSettings>(SETTINGS_KEY);
  const defaults = defaultSettings();
  if (!stored) return defaults;
  return {
    ...defaults,
    ...stored,
    sourceFontSize: clampFontSize(stored.sourceFontSize, defaults.sourceFontSize),
    viewerFontSize: clampFontSize(stored.viewerFontSize, defaults.viewerFontSize),
    profile: { ...defaults.profile, ...stored.profile },
  };
}

export async function saveSettings(settings: MarkrootSettings): Promise<void> {
  localStorage.setItem('markroot-theme', settings.theme);
  await setValue(SETTINGS_KEY, settings);
}

export async function loadRecentWorkspace(): Promise<FileSystemDirectoryHandle | undefined> { return getValue<FileSystemDirectoryHandle>(WORKSPACE_KEY); }
export async function saveRecentWorkspace(handle: FileSystemDirectoryHandle): Promise<void> { await setValue(WORKSPACE_KEY, handle); }
export async function loadPendingSession(workspaceName: string, path: string): Promise<PendingSession | undefined> { return getValue<PendingSession>(pendingKey(workspaceName, path)); }
export async function savePendingSession(session: PendingSession): Promise<void> { await setValue(pendingKey(session.workspaceName, session.path), session); }
export async function deletePendingSession(workspaceName: string, path: string): Promise<void> { await deleteValue(pendingKey(workspaceName, path)); }

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

function pendingKey(workspaceName: string, path: string): string { return `pending:${workspaceName}:${path}`; }
function clampFontSize(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(12, Math.min(28, Math.round(value!))) : fallback;
}
