import { useEffect, useRef, useState, type RefObject } from 'react';
import { type WorkspacePath } from '@markroot/core';
import { DocumentSession, type DocumentSnapshot } from '@markroot/document';
import { FileSystemAccessWorkspace, ensureDirectoryPermission, type GuardedWorkspace, type WorkspaceEntry } from '@markroot/workspace';
import { commentRevision, parseComments } from '@markroot/comments';
import { IsomorphicGitRepository } from '@markroot/git';
import { LocalCitationProvider, type CitationRecord } from '@markroot/citations';
import { deletePendingSession, forgetProject, listRecentProjects, rememberProject, workspaceIdFor, loadPendingSession, loadRecentWorkspace, loadSettings, type MarkrootSettings, type RecentProject } from '@markroot/settings';
import type { useComments } from './useComments.js';
import type { useGitRepository } from './useGitRepository.js';
import { useEvent } from './useEvent.js';

interface Options {
  comments(): ReturnType<typeof useComments>;
  repository(): ReturnType<typeof useGitRepository>;
  settingsRef: RefObject<MarkrootSettings>;
  setSettings(settings: MarkrootSettings): void;
  updateSettings(settings: MarkrootSettings): void;
  setNotice(notice: string | undefined): void;
  reportError(error: unknown): void;
  saveBeforeSwitch(): Promise<DocumentSnapshot | undefined>;
  onFolderReset(): void;
  onDocumentLoading(): void;
  onDocumentOpened(path: WorkspacePath, base: string | undefined, firstBlock: string | undefined, fragment?: string): void;
}

/** Owns folder generations, document loads and the live session subscription. */
export function useWorkspaceDocuments({ comments, repository, settingsRef, setSettings, updateSettings, setNotice, reportError, saveBeforeSwitch, onFolderReset, onDocumentLoading, onDocumentOpened }: Options) {
  const [workspace, setWorkspace] = useState<GuardedWorkspace>();
  const [rootName, setRootName] = useState('No folder open');
  const [recentProjects, setRecentProjects] = useState<readonly RecentProject[]>([]);
  const [unavailableProject, setUnavailableProject] = useState<RecentProject>();
  const [entries, setEntries] = useState<readonly WorkspaceEntry[]>([]);
  const [session, setSession] = useState<DocumentSession>();
  const [snapshot, setSnapshot] = useState<DocumentSnapshot>();
  const [fileVersion, setFileVersion] = useState<string>();
  const documentRequest = useRef(0);
  const folderGeneration = useRef(0);
  const activeSession = useRef<DocumentSession | undefined>(undefined);
  const fileVersionRef = useRef<string | undefined>(undefined);
  const workspaceIdRef = useRef<string | undefined>(undefined);
  const [citations, setCitations] = useState<readonly CitationRecord[]>([]);
  const sessionSubscription = useRef<(() => void) | undefined>(undefined);
  const connectFolderEvent = useEvent((handle: FileSystemDirectoryHandle, generation: number) => connectFolder(handle, generation));
  const reportProjectError = useEvent((error: unknown, project?: RecentProject) => {
    if (project && error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'NotAllowedError')) {
      setUnavailableProject(project);
      setNotice(`${project.name} is unavailable. Open the folder again or remove it from the list.`);
    } else reportError(error);
  });
  useEffect(() => {
    // A folder the user picks while this restore is pending wins over the remembered one.
    let disposed = false;
    const generation = folderGeneration.current;
    void loadSettings().then((loaded) => { if (!disposed) { settingsRef.current = loaded; setSettings(loaded); } }).catch(() => undefined).then(() => loadRecentWorkspace()).then(async (handle) => {
      const projects = await listRecentProjects();
      if (disposed || folderGeneration.current !== generation) return;
      setRecentProjects(projects);
      if (!handle) return;
      try {
        if (await ensureDirectoryPermission(handle) === 'granted' && !disposed && folderGeneration.current === generation) await connectFolderEvent(handle, generation);
      } catch (error) { if (!disposed && folderGeneration.current === generation) reportProjectError(error, projects[0]); }
    }).catch(reportProjectError);
    return () => { disposed = true; folderGeneration.current += 1; documentRequest.current += 1; sessionSubscription.current?.(); };
  }, [settingsRef, setSettings, connectFolderEvent, reportProjectError]);
  function canSwitchFolder(): boolean {
    if (comments().writeBusy.current) { setNotice('Wait for the comment to finish saving.'); return false; }
    return !activeSession.current?.snapshot().dirty || settingsRef.current.autosave || window.confirm('Discard unsaved edits and open another folder?');
  }

  async function chooseFolder() {
    if (!canSwitchFolder()) return;
    if (!('showDirectoryPicker' in window)) { setNotice('Markroot needs a Chromium desktop browser with folder access.'); return; }
    const discarded = activeSession.current?.snapshot();
    const generation = ++folderGeneration.current;
    try {
      const handle = await (window as Window & { showDirectoryPicker(options: { mode: 'readwrite'; id: string }): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'readwrite', id: 'markroot-workspace' });
      if (await ensureDirectoryPermission(handle, true) !== 'granted') throw new Error('Read/write permission was not granted.');
      if (generation === folderGeneration.current) await connectFolder(handle, generation, discarded);
    } catch (error) { if (generation === folderGeneration.current) reportError(error); }
  }

  async function selectProject(project: RecentProject) {
    if (workspace && workspaceIdRef.current === project.id) return;
    if (!canSwitchFolder()) return;
    const discarded = activeSession.current?.snapshot();
    const generation = ++folderGeneration.current;
    setUnavailableProject(undefined);
    try {
      // Invoke requestPermission synchronously in the click's activation, before saving or querying IDB.
      const permission = requestProjectPermission(project.handle);
      if (await permission !== 'granted') {
        if (generation !== folderGeneration.current) return;
        setUnavailableProject(project);
        setNotice(`Read/write access to ${project.name} was not granted. Try again or remove it from the list.`);
        return;
      }
      if (generation === folderGeneration.current) await connectFolder(project.handle, generation, discarded);
    } catch (error) {
      if (generation !== folderGeneration.current) return;
      reportProjectError(error, project);
    }
  }

  async function removeProject(id: string) {
    await forgetProject(id);
    setRecentProjects((projects) => projects.filter((project) => project.id !== id));
    setUnavailableProject((project) => project?.id === id ? undefined : project);
  }

  async function connectFolder(handle: FileSystemDirectoryHandle, generation: number, discarded?: DocumentSnapshot) {
    const superseded = () => generation !== folderGeneration.current;
    // Recovery keys fall back to the folder name, but a broken registry must not stay silent.
    const workspaceId = await workspaceIdFor(handle).catch((error: unknown) => { reportError(error); return undefined; });
    if (superseded()) return;
    const next = new FileSystemAccessWorkspace(handle, workspaceId ? { id: workspaceId } : {});
    // Validate access before replacing the working folder, including removed directory handles.
    const nextEntries = await documentEntries(next);
    if (superseded()) return;
    const leaving = activeSession.current;
    const documentContext = documentRequest.current;
    if (leaving?.snapshot().dirty) {
      if (settingsRef.current.autosave) {
        const saved = await saveBeforeSwitch();
        if (superseded()) return;
        if (!saved || leaving !== activeSession.current || leaving.snapshot().dirty) { setNotice('Save your edits before switching folders.'); return; }
      } else {
        const current = leaving.snapshot();
        if ((current.path !== discarded?.path || current.revision !== discarded.revision) && !window.confirm('Discard unsaved edits and open another folder?')) return;
      }
    }
    if (comments().writeBusy.current) { setNotice('Wait for the comment to finish saving.'); return; }
    if (superseded()) return;
    const leavingRevision = leaving?.snapshot().revision;
    if (leaving?.snapshot().dirty) await deletePendingSession(pendingWorkspace(), leaving.snapshot().path).catch(() => undefined);
    if (superseded()) return;
    // A user can keep typing while persistence is pending; never drop a newer dirty revision.
    if (documentRequest.current !== documentContext || (leaving?.snapshot().dirty && (settingsRef.current.autosave || leaving.snapshot().revision !== leavingRevision))) {
      setNotice('Your document changed while opening the folder. Switch again when your edits are ready.'); return;
    }
    if (comments().writeBusy.current) { setNotice('Wait for the comment to finish saving.'); return; }
    onFolderReset();
    comments().clear();
    sessionSubscription.current?.();
    sessionSubscription.current = undefined;
    setWorkspace(undefined);
    setEntries([]);
    setRootName('No folder open');
    workspaceIdRef.current = undefined;
    activeSession.current = undefined;
    setSession(undefined);
    setSnapshot(undefined);
    documentRequest.current += 1;
    fileVersionRef.current = undefined;
    setFileVersion(undefined);
    setCitations([]);
    repository().reset();
    workspaceIdRef.current = workspaceId;
    setWorkspace(next);
    setRootName(handle.name);
    setUnavailableProject(undefined);
    setEntries(nextEntries);
    const project = await rememberProject(handle).catch((error: unknown) => { reportError(error); return undefined; });
    if (superseded()) return;
    if (project) { setRootName(project.name); setRecentProjects((projects) => [project, ...projects.filter((item) => item.id !== project.id)].slice(0, 12)); }
    const bibliographyPaths = nextEntries.filter((entry) => entry.kind === 'file' && /\.(?:bib|bibtex)$/i.test(entry.path)).map((entry) => entry.path);
    const records = await new LocalCitationProvider(next).index(bibliographyPaths).catch(() => []);
    if (superseded()) return;
    setCitations(records);
    const configured = await repository().connect(new IsomorphicGitRepository(next), superseded);
    if (superseded()) return;
    const latest = settingsRef.current;
    if (configured && (configured.displayName || configured.email)) updateSettings({ ...latest, profile: { ...latest.profile, ...configured } });
    setNotice(`Opened ${handle.name}. Files stay on this device.${skippedEntriesNotice(next.skippedEntries)}`);
  }

  const openWorkspaceLink = useEvent((path: string, fragment?: string) => {
    const entry = entries.find((item) => item.kind === 'file' && item.path === path);
    if (!entry) { setNotice(`${path} is not a file in this folder.`); return; }
    if (/\.(?:md|qmd|markdown|txt|bib|bibtex|ya?ml)$/i.test(path)) void openFile(entry.path, fragment).catch(reportError);
    else setNotice(`${path} cannot be opened in Markroot.`);
  });

  async function openFile(path: WorkspacePath, fragment?: string) {
    if (!workspace || !comments().store) return;
    if (comments().writeBusy.current) { setNotice('Wait for the comment to finish saving.'); return; }
    if (snapshot?.dirty) {
      if (!window.confirm('Discard unsaved edits and open another file?')) return;
      await deletePendingSession(pendingWorkspace(), snapshot.path).catch(() => undefined);
    }
    onDocumentLoading();
    sessionSubscription.current?.();
    sessionSubscription.current = undefined;
    activeSession.current = undefined;
    setSession(undefined);
    setSnapshot(undefined);
    const request = comments().beginLoad();
    documentRequest.current += 1;
    const context = documentRequest.current;
    try {
      const source = await workspace.readFile(path);
      const stat = await workspace.stat(path);
      const git = repository().git;
      const base = git ? await git.readFileAtRef(path, 'HEAD').catch(() => '') : undefined;
      if (context !== documentRequest.current) return;
      const pending = await loadPendingSession(pendingWorkspace(), path).catch(() => undefined);
      if (context !== documentRequest.current) return;
      const diskChanged = pending?.baseVersion !== undefined && pending.baseVersion !== stat.version;
      const restore = pending?.source !== undefined && pending.source !== source && window.confirm(`Recover browser-local edits from ${new Date(pending.updatedAt).toLocaleString()}?${diskChanged ? `\n\nWarning: ${path} changed on disk after these edits were made. Recovering replaces the newer disk version once saved.` : ''}`);
      if (pending && !restore) await deletePendingSession(pendingWorkspace(), path).catch(() => undefined);
      const selectedSource = restore && pending ? pending.source : source;
      const legacy = parseComments(selectedSource);
      // Browser recovery stores clean prose; keep migration data from the original disk file.
      const diskLegacy = parseComments(source);
      const legacyCommit = legacy.threads.length || diskLegacy.threads.length ? (git ? (await git.history(1).catch(() => []))[0]?.oid ?? null : null) : null;
      const diskThreads = diskLegacy.threads.filter((thread) => !legacy.threads.some((item) => item.id === thread.id));
      const legacyRevision = legacy.threads.length ? await commentRevision(legacy.cleanSource, legacyCommit) : undefined;
      const diskRevision = diskThreads.length ? await commentRevision(diskLegacy.cleanSource, legacyCommit) : undefined;
      const migrationThreads = [
        ...legacy.threads.map((thread) => ({ ...thread, sourceRevision: legacyRevision! })),
        ...diskThreads.map((thread) => ({ ...thread, sourceRevision: diskRevision! })),
      ];
      const { threads: sidecars, broken } = await comments().store!.loadWithIssues(path);
      if (context !== documentRequest.current || !comments().isCurrentLoad(request)) return;
      const brokenNotice = comments().adopt(sidecars, migrationThreads, broken, path);
      const next = new DocumentSession(path, source);
      sessionSubscription.current = next.subscribe(setSnapshot);
      activeSession.current = next;
      setSession(next);
      if (legacy.cleanSource !== source) next.replace(legacy.cleanSource, 'system');
      const firstBlock = next.snapshot().blocks.find((block) => block.kind !== 'frontmatter') ?? next.snapshot().blocks[0];
      fileVersionRef.current = stat.version;
      setFileVersion(stat.version);
      onDocumentOpened(path, base, firstBlock?.id, fragment);
      setNotice([migrationThreads.length ? 'Embedded comments will move to YAML sidecars when you save. The editor now shows clean Markdown.' : undefined, brokenNotice].filter(Boolean).join(' ') || undefined);
    } catch (error) { reportError(error); }
  }

  function pendingWorkspace() { return workspaceIdRef.current ? { id: workspaceIdRef.current, name: rootName } : rootName; }

  async function refreshWorkspace() {
    if (!workspace) return;
    const generation = folderGeneration.current;
    const nextEntries = await documentEntries(workspace);
    if (generation !== folderGeneration.current) return;
    setEntries(nextEntries);
    await comments().reload();
    const repo = repository();
    const git = repo.git;
    if (git) {
      repo.setGitStatus(await git.status());
      await repo.readBase();
    }
  }

  async function loadCitations() {
    if (!workspace) return;
    const paths = entries.filter((entry) => entry.kind === 'file' && /\.(?:bib|bibtex)$/i.test(entry.path)).map((entry) => entry.path);
    const provider = new LocalCitationProvider(workspace);
    const generation = folderGeneration.current;
    try { const next = await provider.index(paths); if (generation === folderGeneration.current) setCitations(next); }
    catch (error) { reportError(error); }
  }

  return { workspace, rootName, entries, session, snapshot, fileVersion, setFileVersion, activeSession, documentRequest, fileVersionRef, workspaceIdRef, citations, recentProjects, unavailableProject, selectProject, removeProject, chooseFolder, openFile, openWorkspaceLink, pendingWorkspace, loadCitations, refreshWorkspace };
}

async function documentEntries(workspace: GuardedWorkspace): Promise<readonly WorkspaceEntry[]> {
  const result: WorkspaceEntry[] = [];
  const visit = async (parent?: WorkspacePath) => {
    for (const entry of await workspace.listFiles(parent)) {
      const name = entry.path.split('/').at(-1)!;
      if (entry.kind === 'directory') {
        if (!['.git', '.markroot', 'node_modules', '.quarto', '_freeze'].includes(name)) { result.push(entry); await visit(entry.path); }
      } else result.push(entry);
    }
  };
  await visit();
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function skippedEntriesNotice(skipped: ReadonlySet<string>): string {
  if (!skipped.size) return '';
  const names = [...skipped].slice(0, 3).join(', ');
  return ` ${skipped.size} item(s) were skipped because Markroot cannot address their names: ${names}${skipped.size > 3 ? ', …' : ''}.`;
}

/** Avoid queryPermission's asynchronous boundary before requesting access from a stored bookmark. */
export function requestProjectPermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  const capable = handle as FileSystemDirectoryHandle & { requestPermission?(options: { mode: 'readwrite' }): Promise<PermissionState> };
  return capable.requestPermission ? capable.requestPermission({ mode: 'readwrite' }) : ensureDirectoryPermission(handle, true);
}
