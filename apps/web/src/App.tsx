import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AlignJustify, BookOpen, ChevronRight, CircleAlert, CircleDot, Code2, Columns2, Download, FileCode2,
  ExternalLink, Files, GitBranch, GitCompare, ListTree, MessageSquare, PanelRight,
  RefreshCw, Save, Search, Settings2, X,
} from 'lucide-react';
import { throwIfAborted, type SourceRange, type WorkspacePath } from '@markroot/core';
import { documentBlockAt, DocumentSession, searchDocument, type DocumentBlock, type DocumentSnapshot } from '@markroot/document';
import type { DocumentOutlineItem } from '@markroot/rendering';
import { FileSystemAccessWorkspace, ensureDirectoryPermission, type GuardedWorkspace, type WorkspaceEntry } from '@markroot/workspace';
import { commentRevision, parseComments } from '@markroot/comments';
import { IsomorphicGitRepository, type GitCommitSummary } from '@markroot/git';
import { mapReviewCompareOffset, mapReviewCurrentOffset, type ReviewDraft } from '@markroot/review';
import { LocalCitationProvider, type CitationRecord } from '@markroot/citations';
import { defaultSettings, deletePendingSession, workspaceIdFor, loadPendingSession, loadRecentWorkspace, loadSettings, savePendingSession, saveRecentWorkspace, saveSettings, type MarkrootSettings } from '@markroot/settings';
import { SourceEditor } from './components/SourceEditor.js';
import { VisualEditor } from './components/VisualEditor.js';
import { Preview } from './components/Preview.js';
import { WorkspaceTree } from './components/WorkspaceTree.js';
import { DocumentOutline } from './components/DocumentOutline.js';
import { PaneResizer } from './components/PaneResizer.js';
import { BrandMark } from './components/BrandMark.js';
import { CommitProposalDialog } from './components/CommitProposalDialog.js';
import { blockProgress } from './components/scroll-sync.js';
import { detachedViewerTitle, prepareDetachedViewerDocument } from './detached-viewer.js';
import { ScrollStore, useScrollState, type ScrollState } from './hooks/scroll-store.js';
import { useEvent } from './hooks/useEvent.js';
import { useSystemDark } from './hooks/useSystemDark.js';
import { GitPanel } from './panels/GitPanel.js';
import { ReviewPanel } from './panels/ReviewPanel.js';
import { CommentsPanel } from './panels/CommentsPanel.js';
import { CitationsPanel } from './panels/CitationsPanel.js';
import { ExportPanel } from './panels/ExportPanel.js';
import { usePreviewRender } from './hooks/usePreviewRender.js';
import { useExport } from './hooks/useExport.js';
import { SettingsPanel } from './panels/SettingsPanel.js';
import { useAiCommit } from './hooks/useAiCommit.js';
import { useGitRepository } from './hooks/useGitRepository.js';
import { useComments } from './hooks/useComments.js';
import { useReview } from './hooks/useReview.js';

type Inspector = 'git' | 'review' | 'comments' | 'citations' | 'export' | 'settings' | undefined;
type RightMode = 'visual' | 'preview';
const EMPTY_WARNINGS: readonly string[] = [];

export function App() {
  const [settings, setSettings] = useState<MarkrootSettings>(defaultSettings);
  const [workspace, setWorkspace] = useState<GuardedWorkspace>();
  const [rootName, setRootName] = useState('No folder open');
  const [entries, setEntries] = useState<readonly WorkspaceEntry[]>([]);
  const [session, setSession] = useState<DocumentSession>();
  const [snapshot, setSnapshot] = useState<DocumentSnapshot>();
  const [fileVersion, setFileVersion] = useState<string>();
  const [rightMode, setRightMode] = useState<RightMode>('preview');
  const [inspector, setInspector] = useState<Inspector>();
  const [search, setSearch] = useState('');
  const [regularExpression, setRegularExpression] = useState(false);
  const [matchCursor, setMatchCursor] = useState(-1);
  const [findOpen, setFindOpen] = useState(false);
  const [lineInput, setLineInput] = useState('');
  const [goToLine, setGoToLine] = useState<number>();
  const [selection, setSelection] = useState<SourceRange>({ from: 0, to: 0 });
  const [sourceCursorTarget, setSourceCursorTarget] = useState<number>();
  const [notice, setNotice] = useState<string>();
  const [trackChangesOpen, setTrackChangesOpen] = useState(false);
  // Identifies the open document; bumped only when a different file or folder replaces it.
  const documentRequest = useRef(0);
  // Identifies the open folder; a slower folder connection never overwrites a newer one.
  const folderGeneration = useRef(0);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const fileVersionRef = useRef<string | undefined>(undefined);
  const workspaceIdRef = useRef<string | undefined>(undefined);
  const [citations, setCitations] = useState<readonly CitationRecord[]>([]);
  const [citationQuery, setCitationQuery] = useState('');
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [previewAnchor, setPreviewAnchor] = useState<Readonly<{ id: string; request: number }>>();
  const [detachedViewerRoot, setDetachedViewerRoot] = useState<HTMLElement>();
  const sessionSubscription = useRef<(() => void) | undefined>(undefined);
  const snapshotRef = useRef<DocumentSnapshot | undefined>(undefined);
  const reviewRef = useRef<ReviewDraft | undefined>(undefined);
  const reviewPreviewSnapshotRef = useRef<DocumentSnapshot | undefined>(undefined);
  const settingsRef = useRef(settings);
  const workspacePane = useRef<HTMLElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const detachedViewerWindow = useRef<Window | undefined>(undefined);
  const scroll = useMemo(() => new ScrollStore(), []);
  const lineInputId = useId();
  const reportError = useCallback((error: unknown) => { if (!isAbortError(error)) setNotice(errorMessage(error)); }, []);
  const reloadCommentsEvent = useEvent(() => commentState.reload());
  const repo = useGitRepository({ openPath: snapshot?.path, dirty: snapshot?.dirty ?? false, profile: settings.profile, reloadComments: reloadCommentsEvent, setNotice, reportError });
  const { git, gitStatus, setGitStatus, gitBase, setGitBase } = repo;
  const saveDocumentEvent = useEvent(() => saveDocument());
  const applyReviewedSource = useEvent((source: string, origin: 'review') => applySource(source, origin));
  const showReview = useCallback(() => { setRightMode('preview'); setInspector('review'); }, []);
  const hideInspector = useCallback(() => setInspector(undefined), []);
  const reviewState = useReview({ git, workspace, snapshot, scroll, setSelection, setSourceCursorTarget, applySource: applyReviewedSource, setNotice, reportError, onOpened: showReview, onApplied: hideInspector });
  const { review, presentation: reviewPresentation, presentedSnapshot, previewSnapshot: reviewPreviewSnapshot, trackChanges: reviewTrackChanges, activeTrackChange, activeSourceTrackChange, renderedChanges: renderedReviewChanges, renderedDecisions: renderedReviewDecisions, reset: resetReview, select: selectReviewChange } = reviewState;
  const previewSnapshot = reviewPreviewSnapshot ?? presentedSnapshot;
  const comparisonBaseSource = reviewPresentation?.base ?? (gitBase?.path === presentedSnapshot?.path ? gitBase?.source : undefined);
  const renderedComparisonBaseSource = review?.base ?? comparisonBaseSource;
  const trackedChangesVisible = Boolean(review) || trackChangesOpen;
  const trackChangesUnavailable = Boolean(review) || (!trackChangesOpen && (gitBase?.path !== snapshot?.path || gitBase?.source === snapshot?.source));
  const commentState = useComments({ workspace, session, snapshot, selection, reviewing: Boolean(review), git, profile: settings.profile, saveDocument: saveDocumentEvent, setNotice, reportError, onCommentsWritten: repo.refreshStatus });
  const { store: commentStore, located: comments, activeId: activeCommentId, setActiveId: setActiveCommentId, writeBusy: commentWriteBusy, legacy: legacyComments } = commentState;
  const matches = useMemo(() => presentedSnapshot ? searchDocument(presentedSnapshot, search, { regularExpression }) : [], [presentedSnapshot, search, regularExpression]);
  const currentLine = useMemo(() => presentedSnapshot ? lineAt(presentedSnapshot.source, selection.from) : 1, [presentedSnapshot?.source, selection.from]);
  const workspacePaths = useMemo(() => entries.map((entry) => entry.path), [entries]);
  const systemDark = useSystemDark();
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && systemDark);
  snapshotRef.current = presentedSnapshot;
  reviewRef.current = review;
  reviewPreviewSnapshotRef.current = reviewPreviewSnapshot;
  settingsRef.current = settings;
  fileVersionRef.current = fileVersion;

  const { rendered, renderedBaseHtml } = usePreviewRender({ previewSnapshot, workspace, citations, allowRemoteResources: settings.allowRemoteResources, baseSource: trackedChangesVisible ? renderedComparisonBaseSource : undefined, reportError });
  const refreshWorkspaceInBackground = useEvent(() => { void refreshWorkspace().catch(reportError); });
  const exports = useExport({ snapshot, workspace, justified: settings.viewerJustified, setNotice, onWorkspaceChanged: refreshWorkspaceInBackground });

  useEffect(() => {
    // A folder the user picks while this restore is pending wins over the remembered one.
    const generation = folderGeneration.current;
    void loadSettings().then((loaded) => { settingsRef.current = loaded; setSettings(loaded); }).catch(() => undefined).then(() => loadRecentWorkspace()).then(async (handle) => {
      if (!handle || folderGeneration.current !== generation) return;
      if (await ensureDirectoryPermission(handle) === 'granted' && folderGeneration.current === generation) await connectFolder(handle);
    }).catch(reportError);
    return () => sessionSubscription.current?.();
  }, []);

  useEffect(() => () => {
    detachedViewerWindow.current?.close();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    if (detachedViewerRoot) detachedViewerRoot.ownerDocument.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark, detachedViewerRoot]);

  useEffect(() => {
    if (detachedViewerRoot) detachedViewerRoot.ownerDocument.title = detachedViewerTitle(snapshot?.path);
  }, [detachedViewerRoot, snapshot?.path]);

  useEffect(() => {
    if (!settings.autosave || !snapshot?.dirty || commentState.busy) return;
    const timer = window.setTimeout(() => { void saveDocument(); }, 900);
    return () => window.clearTimeout(timer);
  }, [settings.autosave, snapshot?.revision, snapshot?.dirty, workspace, fileVersion, commentState.busy]);

  useEffect(() => {
    if (!snapshot?.dirty || rootName === 'No folder open') return;
    const timer = window.setTimeout(() => {
      void savePendingSession({ workspaceName: rootName, ...(workspaceIdRef.current ? { workspaceId: workspaceIdRef.current } : {}), path: snapshot.path, source: snapshot.source, ...(fileVersion ? { baseVersion: fileVersion } : {}), updatedAt: new Date().toISOString() })
        .catch(() => setNotice('Could not keep a browser-local recovery copy of unsaved edits.'));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [snapshot?.revision, snapshot?.dirty, snapshot?.path, snapshot?.source, rootName, fileVersion]);

  useEffect(() => {
    if (!snapshot?.dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [snapshot?.dirty]);

  useEffect(() => {
    if (!workspace || !snapshot || !fileVersion) return;
    const check = async () => {
      const current = await workspace.stat(snapshot.path).catch(() => undefined);
      if (current?.version && current.version !== fileVersion) setNotice(`${snapshot.path} changed outside Markroot. Reload or compare before saving.`);
    };
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [workspace, snapshot?.path, fileVersion]);

  useEffect(() => {
    if (findOpen) window.setTimeout(() => searchInput.current?.focus(), 0);
  }, [findOpen]);

  // Cmd/Ctrl+S and Cmd/Ctrl+F outside CodeMirror (which handles and prevents them itself), including the detached viewer.
  const handleShortcut = useEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key === 's') { event.preventDefault(); if (snapshotRef.current) void explicitSave().catch(reportError); }
    else if (key === 'f' && snapshotRef.current) { event.preventDefault(); openFind(); }
  });
  useEffect(() => {
    const targets = [window, detachedViewerRoot?.ownerDocument.defaultView].filter((target): target is Window & typeof globalThis => Boolean(target));
    targets.forEach((target) => target.addEventListener('keydown', handleShortcut));
    return () => targets.forEach((target) => target.removeEventListener('keydown', handleShortcut));
  }, [detachedViewerRoot, handleShortcut]);

  // Keeps the scroll target on a block of the shown document; reruns when the pane position changes.
  useEffect(() => {
    const ensureTarget = () => {
      const navigationSnapshot = reviewPreviewSnapshot ?? snapshot;
      const { target } = scroll.get();
      if (!navigationSnapshot || (target && navigationSnapshot.blocks.some((block) => block.id === target))) return;
      const navigationOffset = review ? mapReviewCurrentOffset(review, selection.from) : selection.from;
      const block = documentBlockAt(navigationSnapshot.blocks, navigationOffset)
        ?? navigationSnapshot.blocks.find((candidate) => candidate.kind !== 'frontmatter');
      if (block) scroll.set({ target: block.id });
    };
    ensureTarget();
    return scroll.subscribe(ensureTarget);
  }, [snapshot, review, reviewPreviewSnapshot, selection.from, scroll]);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool || !session) return;
    const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({
      name: 'start_document_search',
      title: 'Search the open document',
      description: 'Open Markroot search, highlight a literal phrase in both panes, and return only the number of source matches. Document text is not returned.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1, maxLength: 200 } },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute(input) {
        if (typeof input !== 'object' || input === null || !('query' in input) || typeof input.query !== 'string' || !input.query.trim() || input.query.length > 200) throw new TypeError('query must be a non-empty string of at most 200 characters');
        const query = input.query;
        const current = snapshotRef.current;
        if (!current) throw new Error('No document is open.');
        setSearch(query);
        setFindOpen(true);
        return { matchCount: searchDocument(current, query).length };
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, [session]);

  const updateSettings = useCallback((next: MarkrootSettings) => {
    settingsRef.current = next;
    setSettings(next);
    void saveSettings(next).catch(() => setNotice('Could not save browser preferences.'));
  }, []);
  const openGitPanel = useCallback(() => setInspector('git'), []);
  const afterAiCommit = useEvent(() => { repo.setCommitMessage(''); void repo.refresh().catch(reportError); });
  const { commitDialog, aiModelSetup, aiErrorNotice, setAiErrorNotice, updateAiCommitSuggestions, explicitSave, regenerateCommitProposal, acceptAiCommit, cancelAiCommit, closeCommitDialog, changeProposal } = useAiCommit({ git, settings, updateSettings, commentStore, saveDocument: saveDocumentEvent, setNotice, openGitPanel, onCommitted: afterAiCommit });

  async function chooseFolder() {
    if (commentWriteBusy.current) { setNotice('Wait for the comment to finish saving.'); return; }
    if (snapshot?.dirty && !window.confirm('Discard unsaved edits and open another folder?')) return;
    if (!('showDirectoryPicker' in window)) { setNotice('Markroot needs a Chromium desktop browser with folder access.'); return; }
    try {
      const handle = await (window as Window & { showDirectoryPicker(options: { mode: 'readwrite'; id: string }): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'readwrite', id: 'markroot-workspace' });
      if (await ensureDirectoryPermission(handle, true) !== 'granted') throw new Error('Read/write permission was not granted.');
      await saveRecentWorkspace(handle);
      await connectFolder(handle);
    } catch (error) { reportError(error); }
  }

  async function connectFolder(handle: FileSystemDirectoryHandle) {
    if (commentWriteBusy.current) { setNotice('Wait for the comment to finish saving.'); return; }
    const generation = ++folderGeneration.current;
    const superseded = () => generation !== folderGeneration.current;
    closeCommitDialog(false);
    commentState.clear();
    sessionSubscription.current?.();
    sessionSubscription.current = undefined;
    setSession(undefined);
    setSnapshot(undefined);
    documentRequest.current += 1;
    fileVersionRef.current = undefined;
    setFileVersion(undefined);
    resetReview();
    setInspector((open) => open === 'review' ? undefined : open);
    repo.reset();
    setTrackChangesOpen(false);
    setCitations([]);
    setOutlineOpen(false);
    setPreviewAnchor(undefined);
    setSourceCursorTarget(undefined);
    scroll.set({ target: undefined, progress: 0, origin: 'command', alignment: 'reveal' });
    if (detachedViewerWindow.current) reattachViewer();
    const workspaceId = await workspaceIdFor(handle).catch(() => undefined);
    if (superseded()) return;
    const next = new FileSystemAccessWorkspace(handle, workspaceId ? { id: workspaceId } : {});
    const nextEntries = await documentEntries(next);
    if (superseded()) return;
    workspaceIdRef.current = workspaceId;
    setWorkspace(next);
    setRootName(handle.name);
    setEntries(nextEntries);
    const bibliographyPaths = nextEntries.filter((entry) => entry.kind === 'file' && /\.(?:bib|bibtex)$/i.test(entry.path)).map((entry) => entry.path);
    const records = await new LocalCitationProvider(next).index(bibliographyPaths).catch(() => []);
    if (superseded()) return;
    setCitations(records);
    const configured = await repo.connect(new IsomorphicGitRepository(next), superseded);
    if (superseded()) return;
    const latest = settingsRef.current;
    if (configured && (configured.displayName || configured.email)) updateSettings({ ...latest, profile: { ...latest.profile, ...configured } });
    setNotice(`Opened ${handle.name}. Files stay on this device.${skippedEntriesNotice(next.skippedEntries)}`);
  }

  const openWorkspaceLink = useEvent((path: string) => {
    const entry = entries.find((item) => item.kind === 'file' && item.path === path);
    if (!entry) { setNotice(`${path} is not a file in this folder.`); return; }
    if (/\.(?:md|qmd|markdown|txt|bib|bibtex|ya?ml)$/i.test(path)) void openFile(entry.path);
    else setNotice(`${path} cannot be opened in Markroot.`);
  });

  async function openFile(path: WorkspacePath) {
    if (!workspace || !commentStore) return;
    if (commentWriteBusy.current) { setNotice('Wait for the comment to finish saving.'); return; }
    if (snapshot?.dirty) {
      if (!window.confirm('Discard unsaved edits and open another file?')) return;
      await deletePendingSession(pendingWorkspace(), snapshot.path).catch(() => undefined);
    }
    const request = commentState.beginLoad();
    documentRequest.current += 1;
    try {
      const source = await workspace.readFile(path);
      const stat = await workspace.stat(path);
      const base = git ? await git.readFileAtRef(path, 'HEAD').catch(() => '') : undefined;
      const pending = await loadPendingSession(pendingWorkspace(), path).catch(() => undefined);
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
      const { threads: sidecars, broken } = await commentStore.loadWithIssues(path);
      if (!commentState.isCurrentLoad(request)) return;
      const brokenNotice = commentState.adopt(sidecars, migrationThreads, broken, path);
      sessionSubscription.current?.();
      const next = new DocumentSession(path, source);
      sessionSubscription.current = next.subscribe(setSnapshot);
      setSession(next);
      if (legacy.cleanSource !== source) next.replace(legacy.cleanSource, 'system');
      const firstBlock = next.snapshot().blocks.find((block) => block.kind !== 'frontmatter') ?? next.snapshot().blocks[0];
      setFileVersion(stat.version);
      setGitBase(base === undefined ? undefined : { path, source: base });
      setTrackChangesOpen(false);
      resetReview();
      scroll.set({ target: firstBlock?.id, progress: 0, origin: 'command', alignment: 'reveal' });
      setSourceCursorTarget(undefined);
      setActiveCommentId(undefined);
      setOutlineOpen(false);
      setPreviewAnchor(undefined);
      setNotice([migrationThreads.length ? 'Embedded comments will move to YAML sidecars when you save. The editor now shows clean Markdown.' : undefined, brokenNotice].filter(Boolean).join(' ') || undefined);
    } catch (error) { reportError(error); }
  }

  const copyWorkspacePath = useEvent(async (path: WorkspacePath) => {
    try {
      await copyText(path);
      setNotice(`Copied ${path}. It will paste relative to the open document.`);
    } catch { setNotice(`Could not copy ${path}.`); }
  });

  const applySource = useCallback((source: string, origin: 'source' | 'visual' | 'comment' | 'review' = 'source') => {
    const current = session?.snapshot();
    if (session && current && source !== current.source) session.replace(source, origin);
  }, [session]);

  const selectSource = useCallback((range: SourceRange) => {
    setSelection(range);
    setSourceCursorTarget(undefined);
    const draft = reviewRef.current;
    const navigationSnapshot = draft ? reviewPreviewSnapshotRef.current : snapshotRef.current;
    const navigationOffset = draft ? mapReviewCurrentOffset(draft, range.from) : range.from;
    const block = navigationSnapshot ? documentBlockAt(navigationSnapshot.blocks, navigationOffset) : undefined;
    if (!block) return;
    scroll.set({ origin: 'source', alignment: 'reveal', target: block.id, progress: blockProgress(navigationOffset, block) });
  }, [scroll]);

  const navigateFromRight = useCallback((blockId: string, sourceOffset?: number) => {
    const draft = reviewRef.current;
    const navigationSnapshot = draft ? reviewPreviewSnapshotRef.current : snapshotRef.current;
    const block = navigationSnapshot?.blocks.find((candidate) => candidate.id === blockId);
    const comparePosition = block ? Math.max(block.from, Math.min(sourceOffset ?? block.from, block.to)) : sourceOffset;
    const position = draft && comparePosition !== undefined ? mapReviewCompareOffset(draft, comparePosition) : comparePosition;
    scroll.set({ origin: 'right', alignment: 'reveal', target: blockId, progress: block && comparePosition !== undefined ? blockProgress(comparePosition, block) : 0 });
    setSourceCursorTarget(undefined);
    if (position !== undefined) window.setTimeout(() => setSourceCursorTarget(position), 0);
  }, [scroll]);

  const selectFromRight = useCallback((range: SourceRange) => {
    const draft = reviewRef.current;
    const currentRange = draft
      ? { from: mapReviewCompareOffset(draft, range.from), to: mapReviewCompareOffset(draft, range.to) }
      : range;
    setSelection(currentRange);
    setSourceCursorTarget(undefined);
    const navigationSnapshot = draft ? reviewPreviewSnapshotRef.current : snapshotRef.current;
    const block = navigationSnapshot ? documentBlockAt(navigationSnapshot.blocks, range.from) : undefined;
    if (!block) return;
    scroll.set({ origin: 'right', alignment: 'reveal', target: block.id, progress: blockProgress(range.from, block) });
  }, [scroll]);

  const navigateFromSourceScroll = useCallback((blockId: string, progress: number) => {
    const currentSnapshot = snapshotRef.current;
    const sourceBlock = currentSnapshot?.blocks.find((block) => block.id === blockId);
    const currentOffset = sourceBlock
      ? sourceBlock.from + Math.round((sourceBlock.to - sourceBlock.from) * progress)
      : undefined;
    const draft = reviewRef.current;
    const compareOffset = draft && currentOffset !== undefined ? mapReviewCurrentOffset(draft, currentOffset) : currentOffset;
    const navigationSnapshot = draft ? reviewPreviewSnapshotRef.current : currentSnapshot;
    const block = navigationSnapshot && compareOffset !== undefined ? documentBlockAt(navigationSnapshot.blocks, compareOffset) : undefined;
    setSourceCursorTarget(undefined);
    scroll.set({ origin: 'source', alignment: 'center', progress: block && compareOffset !== undefined ? blockProgress(compareOffset, block) : progress, target: block?.id ?? blockId });
  }, [scroll]);

  const resizeLayout = useCallback((patch: Pick<MarkrootSettings, 'filesPaneWidth'> | Pick<MarkrootSettings, 'sourcePaneRatio'>, finished: boolean) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    if (finished) void saveSettings(next).catch(() => setNotice('Could not save the workspace layout.'));
  }, []);
  const resizeFilesPane = useCallback((value: number, finished: boolean) => resizeLayout({ filesPaneWidth: Math.round(value) }, finished), [resizeLayout]);
  const resizeSourcePane = useCallback((value: number, finished: boolean) => resizeLayout({ sourcePaneRatio: value }, finished), [resizeLayout]);
  const workspacePaneWidth = useCallback(() => workspacePane.current?.clientWidth ?? 1, []);

  const navigateOutline = useCallback((item: DocumentOutlineItem) => {
    setRightMode('preview');
    scroll.set({ origin: 'right', alignment: 'reveal', target: item.blockId, progress: 0 });
    setSourceCursorTarget(undefined);
    window.setTimeout(() => setSourceCursorTarget(item.from), 0);
    setPreviewAnchor((current) => ({ id: item.id, request: (current?.request ?? 0) + 1 }));
  }, [scroll]);

  const applyVisualBlock = useCallback((block: DocumentBlock, replacement: string) => {
    if (!session) return;
    const current = session.snapshot();
    const live = current.blocks.find((candidate) => candidate.id === block.id);
    if (!live) { setNotice('That block changed before the visual edit could be applied.'); return; }
    session.apply({ from: live.from, to: live.to, insert: replacement, origin: 'visual', baseRevision: current.revision });
  }, [session]);

  function pendingWorkspace() { return workspaceIdRef.current ? { id: workspaceIdRef.current, name: rootName } : rootName; }

  // Saves run one at a time so overlapping autosave, Cmd+S and comment saves never race on the file version.
  function saveDocument(): Promise<DocumentSnapshot | undefined> {
    const queued = saveQueue.current.then(() => writeDocument(), () => writeDocument());
    saveQueue.current = queued;
    return queued;
  }

  async function writeDocument(): Promise<DocumentSnapshot | undefined> {
    if (!workspace || !session) return undefined;
    const current = session.snapshot();
    if (!current.dirty && !legacyComments.current.length) return current;
    const migration = legacyComments.current;
    const context = documentRequest.current;
    let brokenNotice: string | undefined;
    try {
      if (migration.length && commentStore) {
        const commit = git ? (await git.history(1).catch(() => []))[0]?.oid ?? null : null;
        await commentStore.importLegacy(current.path, migration, await commentRevision(current.source, commit));
        // Validate persisted sidecars before removing legacy data.
        const { broken } = await commentStore.loadWithIssues(current.path);
        if (broken.some((item) => !item.document || item.document === current.path || migration.some((thread) => thread.id === item.id))) throw new Error('Some comment files could not be read back; legacy comments were kept in the document.');
      }
      const stat = await workspace.writeFileGuarded(current.path, current.source, fileVersionRef.current);
      if (context !== documentRequest.current) return current;
      fileVersionRef.current = stat.version;
      if (migration.length && commentStore) {
        const loaded = await commentStore.loadWithIssues(current.path);
        brokenNotice = commentState.adopt(loaded.threads, [], loaded.broken, current.path);
      }
      setFileVersion(stat.version);
      session.markSaved(current.revision);
      await deletePendingSession(pendingWorkspace(), current.path).catch(() => undefined);
      if (/\.(?:bib|bibtex)$/i.test(current.path)) await loadCitations();
      setNotice(brokenNotice ? `Saved ${current.path}. ${brokenNotice}` : `Saved ${current.path}.`);
    } catch (error) { reportError(error); return undefined; }
    // A status refresh failure is not a save failure.
    repo.refreshStatus();
    return current;
  }

  async function refreshWorkspace() {
    if (!workspace) return;
    setEntries(await documentEntries(workspace));
    await commentState.reload();
    if (git) {
      setGitStatus(await git.status());
      await repo.readBase();
    }
  }

  const checkoutBranch = useEvent(async (ref: string) => {
    if (!git) return;
    if (commentWriteBusy.current) { setNotice('Wait for the comment to finish saving.'); return; }
    if (snapshot?.dirty) { setNotice('Save the open document before switching branches.'); return; }
    try {
      const openPath = snapshot?.path;
      await git.checkout(ref);
      await refreshWorkspace();
      if (openPath) await openFile(openPath);
      setNotice(`Checked out ${ref}.`);
    } catch (error) { reportError(error); }
  });

  const mergeBranch = useEvent(async (ref: string) => {
    if (!git) return;
    if (commentWriteBusy.current) { setNotice('Wait for the comment to finish saving.'); return; }
    if (snapshot?.dirty) { setNotice('Save the open document before merging.'); return; }
    try {
      const preview = await git.previewMerge(ref);
      if (!preview.clean) { setNotice(`Merge needs manual conflict resolution: ${preview.error ?? 'conflict'}`); return; }
      if (!window.confirm(`Merge ${ref} into ${preview.ours}?`)) return;
      await git.merge(ref, settings.profile);
      await refreshWorkspace();
      if (snapshot?.path) await openFile(snapshot.path);
      setNotice(`Merged ${ref}.`);
    } catch (error) { reportError(error); }
  });

  const navigateComment = useEvent((threadId: string) => {
    if (!snapshot || !comments) return;
    setActiveCommentId(threadId);
    const range = comments.ranges.get(threadId) ?? comments.threads.find((thread) => thread.id === threadId)?.selector;
    if (!range) return;
    const line = lineAt(snapshot.source, range.from);
    setSelection({ from: range.from, to: range.to });
    setLineInput(String(line));
    setGoToLine(undefined);
    window.setTimeout(() => setGoToLine(line), 0);
    setSourceCursorTarget(undefined);
    window.setTimeout(() => setSourceCursorTarget(range.from), 0);
    const block = snapshot.blocks.find((candidate) => range.from >= candidate.from && range.from <= candidate.to);
    if (block) scroll.set({ origin: 'command', alignment: 'reveal', progress: blockProgress(range.from, block), target: block.id });
  });
  const activateComment = useEvent((id: string) => { setInspector('comments'); navigateComment(id); });

  function navigateMatch(direction: -1 | 1) {
    if (!snapshot || !matches.length) return;
    const nextIndex = matchCursor < 0 ? (direction > 0 ? 0 : matches.length - 1) : (matchCursor + direction + matches.length) % matches.length;
    const match = matches[nextIndex]!;
    setMatchCursor(nextIndex);
    setSelection({ from: match.from, to: match.to });
    setGoToLine(undefined);
    window.setTimeout(() => setGoToLine(lineAt(snapshot.source, match.from)), 0);
    setSourceCursorTarget(undefined);
    window.setTimeout(() => setSourceCursorTarget(match.from), 0);
    if (match.blockId) scroll.set({ origin: 'command', alignment: 'reveal', progress: 0, target: match.blockId });
  }

  async function loadCitations() {
    if (!workspace) return;
    const paths = entries.filter((entry) => entry.kind === 'file' && /\.(?:bib|bibtex)$/i.test(entry.path)).map((entry) => entry.path);
    const provider = new LocalCitationProvider(workspace);
    try { setCitations(await provider.index(paths)); }
    catch (error) { reportError(error); }
  }

  const toggleInspector = (next: Exclude<Inspector, undefined>) => {
    if (review && next !== 'review') resetReview();
    setInspector((current) => current === next ? undefined : next);
    if (next === 'citations') void loadCitations();
    if (next === 'git') void repo.refresh().catch(reportError);
  };

  function closeInspector() {
    if (inspector === 'review') resetReview();
    setInspector(undefined);
  }

  const detachViewer = () => {
    const existing = detachedViewerWindow.current;
    if (existing && !existing.closed) { existing.focus(); return; }
    const popup = window.open('', 'markroot-detached-viewer', 'popup=yes,width=1000,height=820,resizable=yes,scrollbars=yes');
    if (!popup) { setNotice('The viewer could not open. Allow pop-ups for Markroot and try again.'); return; }
    const root = prepareDetachedViewerDocument(document, popup.document, snapshot?.path, dark);
    detachedViewerWindow.current = popup;
    setDetachedViewerRoot(root);
    scroll.set({ origin: 'command', alignment: 'reveal' });
    const handleClose = () => {
      if (detachedViewerWindow.current !== popup) return;
      detachedViewerWindow.current = undefined;
      setDetachedViewerRoot(undefined);
    };
    popup.addEventListener('beforeunload', handleClose, { once: true });
    popup.focus();
  };

  function reattachViewer() {
    const popup = detachedViewerWindow.current;
    detachedViewerWindow.current = undefined;
    setDetachedViewerRoot(undefined);
    scroll.set({ origin: 'command', alignment: 'reveal' });
    if (popup && !popup.closed) popup.close();
  }

  const handleViewerScroll = useCallback((id: string, progress: number) => {
    setSourceCursorTarget(undefined);
    scroll.set({ origin: 'right', alignment: 'center', progress, target: id });
  }, [scroll]);

  const saveFromEditor = useEvent(() => { void explicitSave().catch(reportError); });
  const openFind = useCallback(() => { setFindOpen(true); window.setTimeout(() => searchInput.current?.focus(), 0); }, []);
  const changeOutlineDepth = useEvent((outlineDepth: MarkrootSettings['outlineDepth']) => updateSettings({ ...settingsRef.current, outlineDepth }));
  const changeOutlineFigures = useEvent((outlineShowFigures: boolean) => updateSettings({ ...settingsRef.current, outlineShowFigures }));
  const closeOutline = useCallback(() => setOutlineOpen(false), []);
  const openWorkspaceFile = useEvent((path: WorkspacePath) => { void openFile(path); });
  const copyPath = useEvent((path: WorkspacePath) => { void copyWorkspacePath(path); });
  const toggleTrackChanges = useCallback(() => setTrackChangesOpen((open) => !open), []);
  const trackChangesToggle = <TrackChangesToggle reviewing={Boolean(review)} open={trackChangesOpen} visible={trackedChangesVisible} disabled={trackChangesUnavailable} onToggle={toggleTrackChanges}/>;

  const renderViewerContent = () => presentedSnapshot ? <ScrollBound store={scroll} render={(position) => rightMode === 'visual' && !review
    ? <VisualEditor snapshot={presentedSnapshot} activeBlock={position.target} scrollTarget={position.origin === 'right' ? undefined : position.target} scrollProgress={position.progress} scrollAlignment={position.alignment} fontFamily={settings.viewerFont} fontSize={settings.viewerFontSize} justified={settings.viewerJustified} onApply={applyVisualBlock} onNavigate={navigateFromRight} onScroll={handleViewerScroll}/>
    : <Preview html={rendered?.html ?? ''} objectUrls={rendered?.objectUrls ?? EMPTY_WARNINGS} warnings={rendered?.warnings ?? EMPTY_WARNINGS} blocks={previewSnapshot?.blocks ?? presentedSnapshot.blocks} search={search} regularExpression={regularExpression} activeBlock={position.target} scrollTarget={position.origin === 'right' ? undefined : position.target} scrollProgress={position.progress} scrollAlignment={position.alignment} anchorTarget={previewAnchor} allowRemoteResources={settings.allowRemoteResources} fontFamily={settings.viewerFont} fontSize={settings.viewerFontSize} justified={settings.viewerJustified} trackChangesBaseHtml={trackedChangesVisible ? renderedBaseHtml : undefined} activeTrackChange={activeTrackChange} reviewChanges={renderedReviewChanges} reviewDecisions={renderedReviewDecisions} comments={review ? undefined : comments} activeCommentId={review ? undefined : activeCommentId} onNavigate={navigateFromRight} documentPath={presentedSnapshot.path} onOpenWorkspaceLink={openWorkspaceLink} onSelect={selectFromRight} onCommentActivate={activateComment} onScroll={handleViewerScroll}/>}/> : null;

  const switchRightMode = (mode: RightMode) => { scroll.set({ origin: 'command', alignment: 'reveal' }); setRightMode(mode); };
  const viewerToolbar = (detached: boolean) => <div className="pane-title viewer-toolbar">
    <div className="segmented" role="group" aria-label="Viewer mode"><button disabled={Boolean(review)} className={rightMode === 'visual' && !review ? 'active' : ''} aria-pressed={rightMode === 'visual' && !review} onClick={() => switchRightMode('visual')}>Visual</button><button className={rightMode === 'preview' || Boolean(review) ? 'active' : ''} aria-pressed={rightMode === 'preview' || Boolean(review)} onClick={() => switchRightMode('preview')}>Rendered</button></div>
    <button className={settings.viewerJustified ? 'viewer-option active' : 'viewer-option'} onClick={() => updateSettings({ ...settings, viewerJustified: !settings.viewerJustified })} title="Justify viewer text" aria-label="Justify viewer text" aria-pressed={settings.viewerJustified}><AlignJustify size={14}/></button>
    {(rightMode === 'preview' || review) && trackChangesToggle}
    <span className="spacer"/>
    <span>{Math.round(settings.viewerFontSize / 17 * 100)}% view · {rendered?.engine ?? 'source model'}</span>
    <button className="viewer-option" onClick={detached ? reattachViewer : detachViewer} title={detached ? 'Return viewer to the main window' : 'Detach viewer to another window'} aria-label={detached ? 'Reattach viewer' : 'Detach viewer'}>{detached ? <Columns2 size={15}/> : <ExternalLink size={15}/>}</button>
  </div>;

  if (!('showDirectoryPicker' in window)) return <main className="unsupported-browser"><BrandMark className="welcome-symbol"/><h1>Markroot needs Chromium desktop</h1><p>This browser cannot grant direct access to a real local folder. Use a current Chromium-based desktop browser over HTTPS or localhost; Markroot does not offer an upload fallback.</p></main>;

  const inspectorToggle = (panel: Exclude<Inspector, undefined>, label: string, icon: ReactNode) => <button onClick={() => toggleInspector(panel)} className={inspector === panel ? 'selected' : ''} title={label} aria-label={label} aria-pressed={inspector === panel}>{icon}</button>;

  return <><div className={`app ${inspector ? 'with-inspector' : ''}`} style={{ '--files-width': `${settings.filesPaneWidth}px` } as CSSProperties}>
    <header className="topbar">
      <div className="brand" aria-label="Markroot"><BrandMark className="brand-mark"/><strong>Markroot</strong></div>
      <button className="workspace-button" onClick={() => void chooseFolder()} title="Open another folder"><Files size={16}/><span>{rootName}</span><ChevronRight size={14}/></button>
      <div className="document-title"><FileCode2 size={16}/><span>{snapshot?.path ?? 'Open a Markdown or QMD file'}</span>{snapshot?.dirty && <CircleDot size={13} aria-label="Unsaved"/>}</div>
      <div className="top-actions">
        {snapshot && <button onClick={saveFromEditor} title="Save (Ctrl/Cmd+S)" aria-label="Save"><Save size={17}/></button>}
        <button onClick={() => setFindOpen((open) => !open)} title="Find (Ctrl/Cmd+F)" aria-label="Find" aria-expanded={findOpen}><Search size={17}/></button>
        {inspectorToggle('comments', comments?.threads.length ? `Comments (${comments.threads.length})` : 'Comments', <><MessageSquare size={17}/>{comments?.threads.length ? <small>{comments.threads.length}</small> : null}</>)}
        {inspectorToggle('git', 'Git', <GitBranch size={17}/>)}
        {inspectorToggle('export', 'Export', <Download size={17}/>)}
        {inspectorToggle('settings', 'Settings', <Settings2 size={17}/>)}
      </div>
    </header>

    {findOpen && <div className="findbar" role="search"><Search size={15}/><input ref={searchInput} aria-label="Find in source and rendered view" value={search} onChange={(event) => { setSearch(event.target.value); setMatchCursor(-1); }} placeholder="Find in source and rendered view"/><button className={regularExpression ? 'find-option active' : 'find-option'} onClick={() => { setRegularExpression((value) => !value); setMatchCursor(-1); }} title="Use regular expression" aria-label="Use regular expression" aria-pressed={regularExpression}>.*</button><button className="find-step" disabled={!matches.length} onClick={() => navigateMatch(-1)} title="Previous match" aria-label="Previous match">↑</button><button className="find-step" disabled={!matches.length} onClick={() => navigateMatch(1)} title="Next match" aria-label="Next match">↓</button><span aria-live="polite">{matches.length} source matches</span><form className="goto-line" onSubmit={(event) => { event.preventDefault(); const line = Number.parseInt(lineInput, 10); if (Number.isFinite(line) && line > 0) { setGoToLine(undefined); window.setTimeout(() => setGoToLine(line), 0); } }}><label htmlFor={lineInputId}>Line</label><input id={lineInputId} inputMode="numeric" value={lineInput} onChange={(event) => setLineInput(event.target.value.replace(/\D/g, ''))} placeholder="#"/><button type="submit">Go</button></form><button onClick={() => { setSearch(''); setFindOpen(false); }} title="Close find" aria-label="Close find"><X size={15}/></button></div>}
    {notice && <div className="notice" role="status"><span>{notice}</span><button onClick={() => setNotice(undefined)} aria-label="Dismiss notice"><X size={14}/></button></div>}
    {aiErrorNotice && <div className="notice error-notice" role="alert"><CircleAlert size={18}/><span>{aiErrorNotice}</span><button onClick={() => setAiErrorNotice(undefined)} aria-label="Dismiss error"><X size={14}/></button></div>}

    <aside className="files-panel">
      <div className="panel-heading"><span>Workspace</span><div className="panel-heading-actions"><button className={outlineOpen ? 'selected' : ''} disabled={!rendered?.outline?.length} onClick={() => setOutlineOpen((open) => !open)} title="Document outline" aria-label="Document outline" aria-expanded={outlineOpen}><ListTree size={14}/></button><button onClick={() => void refreshWorkspace().catch(reportError)} title="Refresh" aria-label="Refresh workspace"><RefreshCw size={14}/></button></div></div>
      {outlineOpen && <ScrollBound store={scroll} render={(position) => <DocumentOutline items={rendered?.outline ?? []} activeBlock={position.target} maxLevel={settings.outlineDepth} showFigures={settings.outlineShowFigures} onSelect={navigateOutline} onMaxLevelChange={changeOutlineDepth} onShowFiguresChange={changeOutlineFigures} onClose={closeOutline}/>}/>}
      {!workspace ? <div className="empty-files"><div className="folder-illustration"><Files size={28}/></div><h2>Open a working folder</h2><p>Markroot reads and writes the folder directly. Nothing is uploaded.</p><button className="primary" onClick={() => void chooseFolder()}>Choose folder</button></div>
      : <WorkspaceTree key={rootName} entries={entries} activePath={snapshot?.path} gitStatus={gitStatus} onOpen={openWorkspaceFile} onCopy={copyPath}/>}
      <div className="side-footer"><button onClick={() => toggleInspector('citations')} aria-pressed={inspector === 'citations'}><BookOpen size={15}/>Citations</button><span>Local only</span></div>
      <PaneResizer className="files-resizer" label="Resize workspace tree" value={settings.filesPaneWidth} min={180} max={420} keyboardStep={12} onChange={resizeFilesPane}/>
    </aside>

    <main className={`workspace ${detachedViewerRoot ? 'viewer-detached' : ''}`} ref={workspacePane} style={{ '--source-width': `${settings.sourcePaneRatio * 100}%` } as CSSProperties}>
      {!presentedSnapshot ? <div className="welcome"><BrandMark className="welcome-symbol"/><h1>Your local writing workspace</h1><p>Choose a folder, then open a Markdown or QMD file. Source, preview, comments, and Git stay together on this device.</p>{!workspace && <button className="primary" onClick={() => void chooseFolder()}>Open folder</button>}</div>
      : <>
        <section className="pane source-pane"><div className="pane-title"><Code2 size={15}/><span>{review ? 'Source · branch review' : 'Source'}</span>{trackChangesToggle}<span className="spacer"/>{detachedViewerRoot && <><button className="detached-indicator" onClick={() => detachedViewerWindow.current?.focus()} title="Focus the detached viewer"><ExternalLink size={13}/>Viewer detached</button><button className="viewer-option" onClick={reattachViewer} title="Return viewer to this window" aria-label="Reattach viewer"><Columns2 size={15}/></button></>}<span>{settings.sourceFontSize}px · Ln {currentLine}</span></div><ScrollBound store={scroll} render={(position) => { const location = sourceScrollLocation(position, review, reviewPreviewSnapshot, presentedSnapshot); return <SourceEditor key={presentedSnapshot.path} path={presentedSnapshot.path} workspacePaths={workspacePaths} value={presentedSnapshot.source} comparisonBase={review ? undefined : comparisonBaseSource} trackChangesOverride={reviewTrackChanges} showTrackChanges={trackedChangesVisible} activeTrackChange={activeSourceTrackChange} readOnly={Boolean(review)} blocks={presentedSnapshot.blocks} search={search} regularExpression={regularExpression} dark={dark} fontFamily={settings.sourceFont} fontSize={settings.sourceFontSize} activeBlock={location.target} scrollTarget={position.origin === 'source' ? undefined : location.target} scrollProgress={location.progress} scrollAlignment={position.alignment} cursorTarget={sourceCursorTarget} goToLine={goToLine} onChange={applySource} onSelection={selectSource} onTrackChangeActivate={selectReviewChange} onScroll={navigateFromSourceScroll} onSave={saveFromEditor} onFind={openFind}/>; }}/></section>
        {!detachedViewerRoot && <><PaneResizer label="Resize source and viewer panes" value={settings.sourcePaneRatio} min={0.25} max={0.75} keyboardStep={0.02} pixelsPerUnit={workspacePaneWidth} onChange={resizeSourcePane}/><section className="pane right-pane">{viewerToolbar(false)}<div className="right-scroll">{renderViewerContent()}</div></section></>}
      </>}
    </main>

    {inspector && <aside className="inspector" aria-label={panelTitle(inspector)}><div className="inspector-head"><strong>{panelTitle(inspector)}</strong><button onClick={closeInspector} title="Close panel" aria-label={`Close ${panelTitle(inspector)} panel`}><PanelRight size={16}/></button></div>
      {inspector === 'git' && <GitPanel git={git} error={repo.gitError} status={gitStatus} branches={repo.branches} currentBranch={repo.currentBranch} history={repo.history} dirty={snapshot?.dirty ?? false} message={repo.commitMessage} setMessage={repo.setCommitMessage} onStage={repo.stage} onCommit={repo.createCommit} onRefresh={repo.refreshPanel} onCheckout={checkoutBranch} onCreateBranch={repo.createBranch} onRenameBranch={repo.renameBranch} onDeleteBranch={repo.deleteBranch} onMerge={mergeBranch} onCompare={reviewState.compare} onError={reportError}/>}
      {inspector === 'review' && <ReviewPanel draft={review} activeChangeId={reviewState.activeChangeId} attributionBusy={reviewState.attributionBusy} onSelect={selectReviewChange} onDecide={reviewState.decide} onDecideAll={reviewState.decideAll} onApply={reviewState.apply}/>}
      {inspector === 'comments' && <CommentsPanel parsed={comments} activeId={activeCommentId} selection={selection} body={commentState.body} setBody={commentState.setBody} replies={commentState.replies} setReplies={commentState.setReplies} onAdd={commentState.add} onNavigate={navigateComment} busy={commentState.busy || Boolean(review)} onRepair={commentState.repair} onReply={commentState.reply} onStatus={commentState.setStatus} onDelete={commentState.remove}/>}
      {inspector === 'citations' && <CitationsPanel records={citations} query={citationQuery} setQuery={setCitationQuery}/>}
      {inspector === 'export' && <ExportPanel disabled={!snapshot} busy={exports.busy} progress={exports.progress} onCancel={exports.cancel} onExport={exports.exportDocument}/>}
      {inspector === 'settings' && <SettingsPanel settings={settings} aiModelSetup={aiModelSetup} onChange={updateSettings} onAiCommitSuggestionsChange={updateAiCommitSuggestions}/>}
    </aside>}
  </div>{commitDialog && <CommitProposalDialog phase={commitDialog.phase} progress={commitDialog.progress} proposal={commitDialog.proposal} fileCount={commitDialog.candidate?.paths.length ?? 0} ignored={commitDialog.candidate?.ignored} onProposalChange={changeProposal} onAccept={() => void acceptAiCommit()} onRegenerate={() => void regenerateCommitProposal()} onCancel={cancelAiCommit}/>} {detachedViewerRoot && createPortal(<main className="detached-viewer"><div className="detached-viewer-title"><BrandMark className="detached-viewer-mark"/><strong>Markroot</strong><span>{snapshot?.path ?? 'Viewer'}</span></div>{viewerToolbar(true)}<div className="right-scroll">{renderViewerContent()}</div></main>, detachedViewerRoot)}</>;
}

/** Re-renders only its pane when the shared scroll position changes, instead of the whole app. */
function ScrollBound({ store, render }: { store: ScrollStore; render(position: ScrollState): ReactNode }) {
  return <>{render(useScrollState(store))}</>;
}

function TrackChangesToggle({ reviewing, open, visible, disabled, onToggle }: { reviewing: boolean; open: boolean; visible: boolean; disabled: boolean; onToggle(): void }) {
  const label = reviewing ? 'Branch changes are shown inline during review' : open ? 'Hide tracked changes in both panes' : 'Show tracked changes in both panes';
  return <button className={visible ? 'viewer-option active' : 'viewer-option'} disabled={disabled} onClick={onToggle} title={label} aria-label={reviewing ? 'Branch changes shown in both panes' : label} aria-pressed={visible}><GitCompare size={14}/></button>;
}

/** Maps the viewer's scroll position (in compared-branch offsets during review) onto the source pane's document. */
function sourceScrollLocation(position: ScrollState, review: ReviewDraft | undefined, reviewSnapshot: DocumentSnapshot | undefined, presented: DocumentSnapshot): { target: string | undefined; progress: number } {
  if (!review || !reviewSnapshot || !position.target) return { target: position.target, progress: position.progress };
  const compareBlock = reviewSnapshot.blocks.find((block) => block.id === position.target);
  if (!compareBlock) return { target: position.target, progress: position.progress };
  const compareOffset = compareBlock.from + Math.round((compareBlock.to - compareBlock.from) * position.progress);
  const currentOffset = mapReviewCompareOffset(review, compareOffset);
  const currentBlock = documentBlockAt(presented.blocks, currentOffset);
  return currentBlock ? { target: currentBlock.id, progress: blockProgress(currentOffset, currentBlock) } : { target: undefined, progress: 0 };
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

function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError'; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function panelTitle(panel: Exclude<Inspector, undefined>): string { return ({ git: 'Local Git', review: 'Track Changes', comments: 'Comments', citations: 'Citations', export: 'Export', settings: 'Settings' })[panel]; }
function lineAt(source: string, offset: number): number { return source.slice(0, offset).split('\n').length; }


async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; }
  const input = document.createElement('textarea');
  input.value = value;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('Clipboard is unavailable.');
}

