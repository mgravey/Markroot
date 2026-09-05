import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  AlignJustify, BookOpen, Check, ChevronRight, CircleAlert, CircleDot, Code2, Columns2, Download, FileCode2,
  ExternalLink, Files, GitBranch, GitCommitHorizontal, GitCompare, ListTree, MessageSquare, Moon, PanelRight,
  RefreshCw, Save, Search, Settings2, Sun, Undo2, X,
} from 'lucide-react';
import { resolveWorkspaceReference, throwIfAborted, workspacePath, type OperationContext, type ProgressEvent, type SourceRange, type WorkspacePath } from '@markroot/core';
import { DocumentSession, searchDocument, type DocumentBlock, type DocumentSnapshot } from '@markroot/document';
import { BasicDocumentEngine, type DocumentOutlineItem, type RenderArtifact } from '@markroot/rendering';
import { FileSystemAccessWorkspace, ensureDirectoryPermission, type GuardedWorkspace, type WorkspaceEntry } from '@markroot/workspace';
import { createThread, deleteThread, parseComments, recoverOrphan, replyToThread, setThreadStatus } from '@markroot/comments';
import { IsomorphicGitRepository, type GitCommitCandidate, type GitCommitSummary, type GitFileStatus } from '@markroot/git';
import { createReviewDraft, decideChange, materializeReview, type ReviewDraft } from '@markroot/review';
import { parseExportOptions, type ExportFormat, type ExportResource } from '@markroot/export';
import { LocalCitationProvider, type CitationRecord } from '@markroot/citations';
import { defaultSettings, deletePendingSession, loadPendingSession, loadRecentWorkspace, loadSettings, savePendingSession, saveRecentWorkspace, saveSettings, type MarkrootSettings } from '@markroot/settings';
import { SourceEditor } from './components/SourceEditor.js';
import { VisualEditor } from './components/VisualEditor.js';
import { Preview } from './components/Preview.js';
import { WorkspaceTree } from './components/WorkspaceTree.js';
import { DocumentOutline } from './components/DocumentOutline.js';
import { PaneResizer } from './components/PaneResizer.js';
import { BrandMark } from './components/BrandMark.js';
import { CommitProposalDialog } from './components/CommitProposalDialog.js';
import { ChromeCommitMessageGenerator, type CommitGenerationProgress, type CommitProposal, type PreparedCommitMessageGenerator } from './commit-message.js';
import { WorkerExporter } from './workers/export-client.js';
import { isPdfFigurePath, renderPdfFigurePreview } from './pdf-preview.js';
import { detachedViewerTitle, prepareDetachedViewerDocument } from './detached-viewer.js';

type Inspector = 'git' | 'review' | 'comments' | 'citations' | 'export' | 'settings' | undefined;
type RightMode = 'visual' | 'preview';
interface ExportProgressState extends ProgressEvent { readonly format: ExportFormat }
interface CommitDialogState {
  readonly phase: 'preparing' | 'ready' | 'committing';
  readonly progress?: CommitGenerationProgress;
  readonly candidate?: GitCommitCandidate;
  readonly proposal?: CommitProposal;
}
interface AiModelSetupState {
  readonly phase: 'checking' | 'downloading' | 'ready' | 'unavailable';
  readonly message: string;
  readonly loaded?: number;
}
const EMPTY_WARNINGS: readonly string[] = [];

export function App() {
  const [settings, setSettings] = useState<MarkrootSettings>(defaultSettings);
  const [workspace, setWorkspace] = useState<GuardedWorkspace>();
  const [rootName, setRootName] = useState('No folder open');
  const [entries, setEntries] = useState<readonly WorkspaceEntry[]>([]);
  const [session, setSession] = useState<DocumentSession>();
  const [snapshot, setSnapshot] = useState<DocumentSnapshot>();
  const [fileVersion, setFileVersion] = useState<string>();
  const [rendered, setRendered] = useState<RenderArtifact>();
  const [renderedBaseHtml, setRenderedBaseHtml] = useState<string>();
  const [rightMode, setRightMode] = useState<RightMode>('preview');
  const [inspector, setInspector] = useState<Inspector>();
  const [search, setSearch] = useState('');
  const [regularExpression, setRegularExpression] = useState(false);
  const [matchCursor, setMatchCursor] = useState(-1);
  const [findOpen, setFindOpen] = useState(false);
  const [lineInput, setLineInput] = useState('');
  const [goToLine, setGoToLine] = useState<number>();
  const [selection, setSelection] = useState<SourceRange>({ from: 0, to: 0 });
  const [scrollTarget, setScrollTarget] = useState<string>();
  const [scrollProgress, setScrollProgress] = useState(0);
  const [scrollOrigin, setScrollOrigin] = useState<'source' | 'right' | 'command'>('command');
  const [scrollAlignment, setScrollAlignment] = useState<'center' | 'reveal'>('reveal');
  const [sourceCursorTarget, setSourceCursorTarget] = useState<number>();
  const [notice, setNotice] = useState<string>();
  const [aiErrorNotice, setAiErrorNotice] = useState<string>();
  const [git, setGit] = useState<IsomorphicGitRepository>();
  const [gitError, setGitError] = useState<string>();
  const [gitStatus, setGitStatus] = useState<readonly GitFileStatus[]>([]);
  const [gitBase, setGitBase] = useState<{ readonly path: WorkspacePath; readonly source: string }>();
  const [trackChangesOpen, setTrackChangesOpen] = useState(false);
  const [branches, setBranches] = useState<readonly string[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string>();
  const [history, setHistory] = useState<readonly GitCommitSummary[]>([]);
  const [review, setReview] = useState<ReviewDraft>();
  const [commitMessage, setCommitMessage] = useState('');
  const [commitDialog, setCommitDialog] = useState<CommitDialogState>();
  const [aiModelSetup, setAiModelSetup] = useState<AiModelSetupState>();
  const [commentBody, setCommentBody] = useState('');
  const [replyBodies, setReplyBodies] = useState<Record<string, string>>({});
  const [activeCommentId, setActiveCommentId] = useState<string>();
  const [citations, setCitations] = useState<readonly CitationRecord[]>([]);
  const [citationQuery, setCitationQuery] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgressState>();
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [previewAnchor, setPreviewAnchor] = useState<Readonly<{ id: string; request: number }>>();
  const [detachedViewerRoot, setDetachedViewerRoot] = useState<HTMLElement>();
  const sessionSubscription = useRef<(() => void) | undefined>(undefined);
  const snapshotRef = useRef<DocumentSnapshot | undefined>(undefined);
  const settingsRef = useRef(settings);
  const workspacePane = useRef<HTMLElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const exportController = useRef<AbortController | undefined>(undefined);
  const commitGenerationController = useRef<AbortController | undefined>(undefined);
  const aiModelSetupController = useRef<AbortController | undefined>(undefined);
  const preparedCommitGenerator = useRef<PreparedCommitMessageGenerator | undefined>(undefined);
  const renderedRef = useRef<RenderArtifact | undefined>(undefined);
  const detachedViewerWindow = useRef<Window | undefined>(undefined);
  const engine = useMemo(() => new BasicDocumentEngine(), []);
  const exporter = useMemo(() => new WorkerExporter(), []);
  const commitMessageGenerator = useMemo(() => new ChromeCommitMessageGenerator(), []);
  const comments = useMemo(() => snapshot ? parseComments(snapshot.source) : undefined, [snapshot?.source]);
  const matches = snapshot ? searchDocument(snapshot, search, { regularExpression }) : [];
  const dark = resolvedDark(settings.theme);
  snapshotRef.current = snapshot;
  settingsRef.current = settings;
  renderedRef.current = rendered;

  useEffect(() => {
    void loadSettings().then(setSettings).catch(() => undefined);
    void loadRecentWorkspace().then(async (handle) => {
      if (handle && await ensureDirectoryPermission(handle) === 'granted') await connectFolder(handle);
    }).catch(() => undefined);
    return () => sessionSubscription.current?.();
  }, []);

  useEffect(() => () => {
    exporter.terminate();
    commitGenerationController.current?.abort();
    aiModelSetupController.current?.abort();
    preparedCommitGenerator.current?.destroy();
    revokeArtifact(renderedRef.current);
    detachedViewerWindow.current?.close();
  }, [exporter]);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    if (detachedViewerRoot) detachedViewerRoot.ownerDocument.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark, detachedViewerRoot]);

  useEffect(() => {
    if (detachedViewerRoot) detachedViewerRoot.ownerDocument.title = detachedViewerTitle(snapshot?.path);
  }, [detachedViewerRoot, snapshot?.path]);

  useEffect(() => {
    if (!snapshot || !/\.(?:md|qmd)$/i.test(snapshot.path)) { setRendered((current) => { revokeArtifact(current); return undefined; }); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void collectPreviewResources(workspace, snapshot, controller.signal).then((dependencies) => engine.render({ snapshot, dependencies, citations, allowRemoteResources: settings.allowRemoteResources }, { signal: controller.signal }))
        .then((artifact) => {
          if (controller.signal.aborted) { revokeArtifact(artifact); return; }
          setRendered((current) => { revokeArtifact(current); return artifact; });
        })
        .catch((error) => { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : String(error)); });
    }, 120);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [snapshot, engine, settings.allowRemoteResources, workspace, citations]);

  useEffect(() => {
    if (!trackChangesOpen || !snapshot || gitBase?.path !== snapshot.path) { setRenderedBaseHtml(undefined); return; }
    const controller = new AbortController();
    const baseSnapshot = new DocumentSession(snapshot.path, gitBase.source).snapshot();
    void engine.render({ snapshot: baseSnapshot, citations, allowRemoteResources: settings.allowRemoteResources }, { signal: controller.signal })
      .then((artifact) => { if (!controller.signal.aborted) setRenderedBaseHtml(artifact.html); })
      .catch((error) => { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : String(error)); });
    return () => controller.abort();
  }, [trackChangesOpen, snapshot?.path, gitBase?.path, gitBase?.source, engine, citations, settings.allowRemoteResources]);

  useEffect(() => {
    if (!settings.autosave || !snapshot?.dirty) return;
    const timer = window.setTimeout(() => { void saveDocument(); }, 900);
    return () => window.clearTimeout(timer);
  }, [settings.autosave, snapshot?.revision, snapshot?.dirty, workspace, fileVersion]);

  useEffect(() => {
    if (!snapshot?.dirty || rootName === 'No folder open') return;
    const timer = window.setTimeout(() => {
      void savePendingSession({ workspaceName: rootName, path: snapshot.path, source: snapshot.source, ...(fileVersion ? { baseVersion: fileVersion } : {}), updatedAt: new Date().toISOString() });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [snapshot?.revision, snapshot?.dirty, snapshot?.path, snapshot?.source, rootName, fileVersion]);

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

  useEffect(() => {
    if (!snapshot || (scrollTarget && snapshot.blocks.some((block) => block.id === scrollTarget))) return;
    const block = snapshot.blocks.find((candidate) => selection.from >= candidate.from && selection.from <= candidate.to)
      ?? snapshot.blocks.find((candidate) => candidate.kind !== 'frontmatter');
    if (block) setScrollTarget(block.id);
  }, [snapshot, scrollTarget, selection.from]);

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
    setSettings(next);
    void saveSettings(next).catch(() => setNotice('Could not save browser preferences.'));
  }, []);

  function updateAiCommitSuggestions(enabled: boolean) {
    updateSettings({ ...settings, aiCommitSuggestions: enabled });
    setAiErrorNotice(undefined);
    aiModelSetupController.current?.abort();
    aiModelSetupController.current = undefined;
    if (!enabled) { setAiModelSetup(undefined); return; }

    const controller = new AbortController();
    aiModelSetupController.current = controller;
    setAiModelSetup({ phase: 'checking', message: 'Checking Chrome on-device AI support' });
    const preparation = commitMessageGenerator.prepare({
      signal: controller.signal,
      onProgress(progress) {
        if (aiModelSetupController.current !== controller) return;
        setAiModelSetup({
          phase: progress.phase === 'downloading' ? 'downloading' : 'checking',
          message: progress.message,
          ...(typeof progress.loaded === 'number' ? { loaded: progress.loaded } : {}),
        });
      },
    });
    void preparation.then((prepared) => {
      prepared.destroy();
      if (aiModelSetupController.current !== controller) return;
      aiModelSetupController.current = undefined;
      setAiErrorNotice(undefined);
      setAiModelSetup({ phase: 'ready', message: 'Chrome on-device AI is downloaded and ready' });
    }).catch((error) => {
      if (controller.signal.aborted || aiModelSetupController.current !== controller) return;
      aiModelSetupController.current = undefined;
      const detail = error instanceof Error ? error.message : String(error);
      setAiModelSetup({ phase: 'unavailable', message: detail });
      setAiErrorNotice(detail);
    });
  }

  async function chooseFolder() {
    if (!('showDirectoryPicker' in window)) { setNotice('Markroot needs a Chromium desktop browser with folder access.'); return; }
    try {
      const handle = await (window as Window & { showDirectoryPicker(options: { mode: 'readwrite'; id: string }): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'readwrite', id: 'markroot-workspace' });
      if (await ensureDirectoryPermission(handle, true) !== 'granted') throw new Error('Read/write permission was not granted.');
      await saveRecentWorkspace(handle);
      await connectFolder(handle);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function connectFolder(handle: FileSystemDirectoryHandle) {
    closeCommitDialog(false);
    const next = new FileSystemAccessWorkspace(handle);
    const nextEntries = await documentEntries(next);
    setWorkspace(next);
    setRootName(handle.name);
    setEntries(nextEntries);
    const bibliographyPaths = nextEntries.filter((entry) => entry.kind === 'file' && /\.(?:bib|bibtex)$/i.test(entry.path)).map((entry) => entry.path);
    const citationProvider = new LocalCitationProvider(next);
    setCitations(await citationProvider.index(bibliographyPaths).catch(() => []));
    const repository = new IsomorphicGitRepository(next);
    setGitBase(undefined);
    setTrackChangesOpen(false);
    try {
      await repository.validate();
      setGit(repository);
      setGitError(undefined);
      setGitStatus(await repository.status());
      setBranches(await repository.branches());
      setCurrentBranch(await repository.currentBranch());
      setHistory(await repository.history(20));
      const configured = await repository.configuredAuthor();
      if (configured.displayName || configured.email) updateSettings({ ...settings, profile: { ...settings.profile, ...configured } });
    } catch (error) { setGit(undefined); setGitError(error instanceof Error ? error.message : String(error)); setGitStatus([]); setBranches([]); setCurrentBranch(undefined); setHistory([]); }
    setNotice(`Opened ${handle.name}. Files stay on this device.`);
  }

  async function openFile(path: WorkspacePath) {
    if (!workspace) return;
    if (snapshot?.dirty) {
      if (!window.confirm('Discard unsaved edits and open another file?')) return;
      await deletePendingSession(rootName, snapshot.path).catch(() => undefined);
    }
    try {
      const source = await workspace.readFile(path);
      const stat = await workspace.stat(path);
      const base = git ? await git.readFileAtRef(path, 'HEAD').catch(() => '') : undefined;
      const pending = await loadPendingSession(rootName, path).catch(() => undefined);
      const restore = pending?.source !== undefined && pending.source !== source && window.confirm(`Recover browser-local edits from ${new Date(pending.updatedAt).toLocaleString()}?`);
      if (pending && !restore) await deletePendingSession(rootName, path).catch(() => undefined);
      sessionSubscription.current?.();
      const next = new DocumentSession(path, source);
      sessionSubscription.current = next.subscribe(setSnapshot);
      setSession(next);
      if (restore && pending) next.replace(pending.source, 'system');
      const firstBlock = next.snapshot().blocks.find((block) => block.kind !== 'frontmatter') ?? next.snapshot().blocks[0];
      setFileVersion(stat.version);
      setGitBase(base === undefined ? undefined : { path, source: base });
      setTrackChangesOpen(false);
      setScrollTarget(firstBlock?.id);
      setScrollProgress(0);
      setScrollOrigin('command');
      setScrollAlignment('reveal');
      setSourceCursorTarget(undefined);
      setActiveCommentId(undefined);
      setOutlineOpen(false);
      setPreviewAnchor(undefined);
      setNotice(undefined);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function copyWorkspacePath(path: WorkspacePath) {
    try {
      await copyText(path);
      setNotice(`Copied ${path}. It will paste relative to the open document.`);
    } catch { setNotice(`Could not copy ${path}.`); }
  }

  const applySource = useCallback((source: string, origin: 'source' | 'visual' | 'comment' | 'review' = 'source') => {
    const current = session?.snapshot();
    if (session && current && source !== current.source) session.replace(source, origin);
  }, [session]);

  const selectSource = useCallback((range: SourceRange) => {
    setSelection(range);
    setSourceCursorTarget(undefined);
    const block = snapshotRef.current?.blocks.find((candidate) => range.from >= candidate.from && range.from <= candidate.to);
    if (!block) return;
    setScrollOrigin('source');
    setScrollAlignment('reveal');
    setScrollTarget(block.id);
    setScrollProgress(Math.max(0, Math.min(1, (range.from - block.from) / Math.max(1, block.to - block.from))));
  }, []);

  const navigateFromRight = useCallback((blockId: string, sourceOffset?: number) => {
    const block = snapshotRef.current?.blocks.find((candidate) => candidate.id === blockId);
    const position = block ? Math.max(block.from, Math.min(sourceOffset ?? block.from, block.to)) : sourceOffset;
    setScrollOrigin('right');
    setScrollAlignment('reveal');
    setScrollTarget(blockId);
    setScrollProgress(block && position !== undefined ? (position - block.from) / Math.max(1, block.to - block.from) : 0);
    setSourceCursorTarget(undefined);
    if (position !== undefined) window.setTimeout(() => setSourceCursorTarget(position), 0);
  }, []);

  const selectFromRight = useCallback((range: SourceRange) => {
    setSelection(range);
    setSourceCursorTarget(undefined);
    const block = snapshotRef.current?.blocks.find((candidate) => range.from >= candidate.from && range.from <= candidate.to);
    if (!block) return;
    setScrollOrigin('right');
    setScrollAlignment('reveal');
    setScrollTarget(block.id);
    setScrollProgress(Math.max(0, Math.min(1, (range.from - block.from) / Math.max(1, block.to - block.from))));
  }, []);

  const resizeLayout = useCallback((patch: Pick<MarkrootSettings, 'filesPaneWidth'> | Pick<MarkrootSettings, 'sourcePaneRatio'>, finished: boolean) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    if (finished) void saveSettings(next).catch(() => setNotice('Could not save the workspace layout.'));
  }, []);

  const navigateOutline = useCallback((item: DocumentOutlineItem) => {
    setRightMode('preview');
    setScrollOrigin('right');
    setScrollAlignment('reveal');
    setScrollTarget(item.blockId);
    setScrollProgress(0);
    setSourceCursorTarget(undefined);
    window.setTimeout(() => setSourceCursorTarget(item.from), 0);
    setPreviewAnchor((current) => ({ id: item.id, request: (current?.request ?? 0) + 1 }));
  }, []);

  const applyVisualBlock = useCallback((block: DocumentBlock, replacement: string) => {
    if (!session) return;
    const current = session.snapshot();
    const live = current.blocks.find((candidate) => candidate.id === block.id);
    if (!live) { setNotice('That block changed before the visual edit could be applied.'); return; }
    session.apply({ from: live.from, to: live.to, insert: replacement, origin: 'visual', baseRevision: current.revision });
  }, [session]);

  async function saveDocument(): Promise<DocumentSnapshot | undefined> {
    if (!workspace || !session) return undefined;
    const current = session.snapshot();
    try {
      const stat = await workspace.writeFileGuarded(current.path, current.source, fileVersion);
      setFileVersion(stat.version);
      session.markSaved(current.revision);
      await deletePendingSession(rootName, current.path).catch(() => undefined);
      if (/\.(?:bib|bibtex)$/i.test(current.path)) await loadCitations();
      setNotice(`Saved ${current.path}.`);
      if (git) setGitStatus(await git.status());
      return current;
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return undefined; }
  }

  async function explicitSave() {
    if (!settings.aiCommitSuggestions || !git) { await saveDocument(); return; }
    setAiErrorNotice(undefined);
    if (!settings.profile.email) {
      if (await saveDocument()) { setInspector('git'); setNotice('A Git author email is required before creating a commit.'); }
      return;
    }
    if (commitDialog || commitGenerationController.current) return;

    const controller = new AbortController();
    commitGenerationController.current = controller;
    setCommitDialog({ phase: 'preparing', progress: { phase: 'checking', message: 'Checking Chrome on-device AI' } });
    const onProgress = (progress: CommitGenerationProgress) => setCommitDialog((current) => current ? { ...current, progress } : current);
    const preparation = commitMessageGenerator.prepare({ signal: controller.signal, onProgress });
    void preparation.catch(() => undefined);

    const saved = await saveDocument();
    if (!saved) {
      controller.abort();
      if (commitGenerationController.current === controller) commitGenerationController.current = undefined;
      void preparation.then((prepared) => prepared.destroy()).catch(() => undefined);
      setCommitDialog(undefined);
      return;
    }
    try {
      const candidate = await git.prepareCommitCandidate(saved.path);
      if (!candidate) {
        controller.abort();
        const prepared = await preparation.catch(() => undefined);
        prepared?.destroy();
        if (commitGenerationController.current === controller) commitGenerationController.current = undefined;
        setCommitDialog(undefined);
        return;
      }
      setCommitDialog((current) => current ? { ...current, candidate } : current);
      const prepared = await preparation;
      if (controller.signal.aborted) { prepared.destroy(); return; }
      preparedCommitGenerator.current = prepared;
      const proposal = await prepared.generate(candidate.diff, { signal: controller.signal, onProgress });
      if (!controller.signal.aborted) setCommitDialog({ phase: 'ready', candidate, proposal });
    } catch (error) {
      if (!controller.signal.aborted) aiCommitUnavailable();
    }
  }

  async function regenerateCommitProposal() {
    const candidate = commitDialog?.candidate;
    if (!candidate) return;
    commitGenerationController.current?.abort();
    preparedCommitGenerator.current?.destroy();
    preparedCommitGenerator.current = undefined;
    const controller = new AbortController();
    commitGenerationController.current = controller;
    const onProgress = (progress: CommitGenerationProgress) => setCommitDialog((current) => current ? { ...current, phase: 'preparing', progress } : current);
    setCommitDialog({ phase: 'preparing', candidate, progress: { phase: 'checking', message: 'Preparing Chrome on-device AI' } });
    try {
      const prepared = await commitMessageGenerator.prepare({ signal: controller.signal, onProgress });
      preparedCommitGenerator.current = prepared;
      const proposal = await prepared.generate(candidate.diff, { signal: controller.signal, onProgress });
      if (!controller.signal.aborted) setCommitDialog({ phase: 'ready', candidate, proposal });
    } catch {
      if (!controller.signal.aborted) aiCommitUnavailable();
    }
  }

  async function acceptAiCommit() {
    const state = commitDialog;
    if (!git || state?.phase !== 'ready' || !state.candidate || !state.proposal?.subject.trim()) return;
    setCommitDialog({ ...state, phase: 'committing' });
    const message = `${state.proposal.subject.trim()}${state.proposal.body.trim() ? `\n\n${state.proposal.body.trim()}` : ''}`;
    try {
      const oid = await git.commitCandidate(state.candidate, message, settings.profile);
      closeCommitDialog(false);
      setCommitMessage('');
      setAiErrorNotice(undefined);
      setNotice(`Committed ${oid.slice(0, 8)}.`);
      await refreshGit();
    } catch (error) {
      closeCommitDialog(true);
      setAiErrorNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function cancelAiCommit() {
    closeCommitDialog(true);
    setNotice('AI commit message generation cancelled; no commit was created.');
  }

  function aiCommitUnavailable() {
    closeCommitDialog(true);
    setAiErrorNotice('AI-generated commit message unavailable; no commit was created.');
  }

  function closeCommitDialog(openGit: boolean) {
    commitGenerationController.current?.abort();
    commitGenerationController.current = undefined;
    preparedCommitGenerator.current?.destroy();
    preparedCommitGenerator.current = undefined;
    setCommitDialog(undefined);
    if (openGit) setInspector('git');
  }

  async function refreshWorkspace() {
    if (!workspace) return;
    setEntries(await documentEntries(workspace));
    if (git) {
      setGitStatus(await git.status());
      if (snapshot?.path) setGitBase({ path: snapshot.path, source: await git.readFileAtRef(snapshot.path, 'HEAD').catch(() => '') });
    }
  }

  async function refreshGit() {
    if (!git) return;
    setGitStatus(await git.status());
    setBranches(await git.branches());
    setCurrentBranch(await git.currentBranch());
    setHistory(await git.history(20));
    if (snapshot?.path) setGitBase({ path: snapshot.path, source: await git.readFileAtRef(snapshot.path, 'HEAD').catch(() => '') });
  }
  async function stage(path: WorkspacePath, staged: boolean) {
    if (!git || snapshot?.dirty) { setNotice('Save the open document before changing the Git index.'); return; }
    try { if (staged) await git.unstage(path); else await git.stage(path); await refreshGit(); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }
  async function createCommit() {
    if (!git) return;
    try { const oid = await git.commit(commitMessage, settings.profile); setCommitMessage(''); setNotice(`Committed ${oid.slice(0, 8)}.`); await refreshGit(); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function checkoutBranch(ref: string) {
    if (!git) return;
    if (snapshot?.dirty) { setNotice('Save the open document before switching branches.'); return; }
    try {
      const openPath = snapshot?.path;
      await git.checkout(ref);
      await refreshWorkspace();
      if (openPath) await openFile(openPath);
      setNotice(`Checked out ${ref}.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function createBranch(ref: string) {
    if (!git) return;
    try { await git.createBranch(ref); await refreshGit(); setNotice(`Created branch ${ref}.`); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function renameBranch(from: string, to: string) {
    if (!git) return;
    if (snapshot?.dirty) { setNotice('Save the open document before renaming a branch.'); return; }
    try { await git.renameBranch(from, to); await refreshGit(); setNotice(`Renamed branch ${from} to ${to}.`); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function deleteBranch(ref: string) {
    if (!git || ref === currentBranch || !window.confirm(`Delete local branch ${ref}?`)) return;
    try { await git.deleteBranch(ref); await refreshGit(); setNotice(`Deleted branch ${ref}.`); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function mergeBranch(ref: string) {
    if (!git) return;
    if (snapshot?.dirty) { setNotice('Save the open document before merging.'); return; }
    try {
      const preview = await git.previewMerge(ref);
      if (!preview.clean) { setNotice(`Merge needs manual conflict resolution: ${preview.error ?? 'conflict'}`); return; }
      if (!window.confirm(`Merge ${ref} into ${preview.ours}?`)) return;
      await git.merge(ref, settings.profile);
      await refreshWorkspace();
      if (snapshot?.path) await openFile(snapshot.path);
      setNotice(`Merged ${ref}.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function compareBranch(ref: string) {
    if (!git || !snapshot) return;
    if (snapshot.dirty) { setNotice('Save the open document before starting branch review.'); return; }
    try {
      const [base, compare] = await Promise.all([
        git.readFileAtRef(snapshot.path, 'HEAD'),
        git.readFileAtRef(snapshot.path, ref),
      ]);
      const initial = createReviewDraft(base, compare, await git.fingerprint());
      const attribution = await attributeReviewChanges(git, snapshot.path, ref, initial);
      setReview(createReviewDraft(base, compare, initial.baseFingerprint, attribution));
      setInspector('review');
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function applyReview() {
    if (!review || !snapshot || !workspace || !git) return;
    try {
      if (await git.fingerprint() !== review.baseFingerprint) throw new Error('Repository state changed after this review started. Reopen the comparison.');
      if (await workspace.readFile(snapshot.path) !== review.base) throw new Error('The working file changed after this review started. Reopen the comparison.');
      applySource(materializeReview(review), 'review'); setInspector(undefined); setReview(undefined); setNotice('Review decisions applied to the working document. Save to write them.');
    }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  function navigateComment(threadId: string) {
    if (!snapshot || !comments) return;
    setActiveCommentId(threadId);
    const range = comments.ranges.get(threadId) ?? comments.threads.find((thread) => thread.id === threadId)?.selector;
    if (!range) return;
    setSelection({ from: range.from, to: range.to });
    setLineInput(String(lineAt(snapshot.source, range.from)));
    setGoToLine(undefined);
    window.setTimeout(() => setGoToLine(lineAt(snapshot.source, range.from)), 0);
    setSourceCursorTarget(undefined);
    window.setTimeout(() => setSourceCursorTarget(range.from), 0);
    const block = snapshot.blocks.find((candidate) => range.from >= candidate.from && range.from <= candidate.to);
    if (block) { setScrollOrigin('command'); setScrollAlignment('reveal'); setScrollProgress(0); setScrollTarget(block.id); }
  }

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
    if (match.blockId) { setScrollOrigin('command'); setScrollAlignment('reveal'); setScrollProgress(0); setScrollTarget(match.blockId); }
  }

  function addComment() {
    if (!session || !snapshot || selection.to <= selection.from || !commentBody.trim()) return;
    const selectedBlock = snapshot.blocks.find((block) => selection.from >= block.from && selection.to <= block.to);
    const blockLevel = !selectedBlock || ['frontmatter', 'raw', 'code'].includes(selectedBlock.kind);
    const range = blockLevel && selectedBlock ? { from: selectedBlock.from, to: selectedBlock.to } : selection;
    try {
      const result = createThread(snapshot.source, range, commentBody, settings.profile, { blockLevel });
      applySource(result.source, 'comment'); setActiveCommentId(result.thread.id); setCommentBody(''); setNotice('Comment added to the document.');
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function loadCitations() {
    if (!workspace) return;
    const paths = entries.filter((entry) => entry.kind === 'file' && /\.(?:bib|bibtex)$/i.test(entry.path)).map((entry) => entry.path);
    const provider = new LocalCitationProvider(workspace);
    try { setCitations(await provider.index(paths)); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function exportDocument(format: ExportFormat, destination: 'download' | 'save-as' | 'workspace') {
    if (!snapshot || exportBusy) return;
    const controller = new AbortController();
    exportController.current = controller;
    setExportBusy(true);
    setExportProgress({ format, phase: 'resources', completed: 0, total: exportStepTotal(format), message: 'Starting local export' });
    try {
      let saveHandle: FileSystemFileHandle | undefined;
      if (destination === 'save-as' && 'showSaveFilePicker' in window) {
        saveHandle = await (window as Window & { showSaveFilePicker(options: SaveFilePickerOptions): Promise<FileSystemFileHandle> }).showSaveFilePicker({
          suggestedName: `${fileBasename(snapshot.path)}.${format}`,
          types: [{ description: `${format.toUpperCase()} document`, accept: { [exportMime(format)]: [`.${format}`] } }],
        });
      }
      setNotice(`Preparing ${format.toUpperCase()} locally…`);
      setExportProgress({ format, phase: 'resources', completed: 0, total: exportStepTotal(format), message: 'Collecting document resources' });
      const exportOptions = parseExportOptions(snapshot.source);
      const resources = workspace ? await collectDocumentResources(workspace, snapshot, format, exportOptions, {
        signal: controller.signal,
        onProgress: (progress) => setExportProgress(appExportProgress(format, progress)),
      }) : [];
      const result = await exporter.export(
        { format, source: snapshot.source, filename: snapshot.path, resources, justified: settings.viewerJustified, ...exportOptions },
        { signal: controller.signal, onProgress: (progress) => {
          setNotice(progress.message ?? `Exporting ${format.toUpperCase()}…`);
          setExportProgress(appExportProgress(format, progress));
        } },
      );
      const total = exportStepTotal(format);
      setExportProgress({ format, phase: 'save', completed: total - 1, total, message: exportSaveMessage(destination) });
      if (saveHandle) {
        const writable = await saveHandle.createWritable();
        await writable.write(result.blob);
        await writable.close();
      } else if (destination === 'workspace' && workspace) {
        const parent = snapshot.path.includes('/') ? snapshot.path.slice(0, snapshot.path.lastIndexOf('/') + 1) : '';
        const outputPath = workspacePath(`${parent}${result.filename}`);
        await workspace.writeBytes(outputPath, new Uint8Array(await result.blob.arrayBuffer()));
        await refreshWorkspace();
      } else download(result.blob, result.filename);
      setExportProgress({ format, phase: 'complete', completed: total, total, message: `${result.filename} is ready` });
      setNotice(`${result.filename} is ready${destination === 'workspace' ? ' beside the source' : ''}.`);
    } catch (error) { setExportProgress(undefined); setNotice(error instanceof DOMException && error.name === 'AbortError' ? 'Export cancelled.' : error instanceof Error ? error.message : String(error)); }
    finally { if (exportController.current === controller) exportController.current = undefined; setExportBusy(false); }
  }

  const toggleInspector = (next: Exclude<Inspector, undefined>) => {
    setInspector((current) => current === next ? undefined : next);
    if (next === 'citations') void loadCitations();
    if (next === 'git') void refreshGit();
  };

  const detachViewer = () => {
    const existing = detachedViewerWindow.current;
    if (existing && !existing.closed) { existing.focus(); return; }
    const popup = window.open('', 'markroot-detached-viewer', 'popup=yes,width=1000,height=820,resizable=yes,scrollbars=yes');
    if (!popup) { setNotice('The viewer could not open. Allow pop-ups for Markroot and try again.'); return; }
    const root = prepareDetachedViewerDocument(document, popup.document, snapshot?.path, dark);
    detachedViewerWindow.current = popup;
    setDetachedViewerRoot(root);
    setScrollOrigin('command');
    setScrollAlignment('reveal');
    const handleClose = () => {
      if (detachedViewerWindow.current !== popup) return;
      detachedViewerWindow.current = undefined;
      setDetachedViewerRoot(undefined);
    };
    popup.addEventListener('beforeunload', handleClose, { once: true });
    popup.focus();
  };

  const reattachViewer = () => {
    const popup = detachedViewerWindow.current;
    detachedViewerWindow.current = undefined;
    setDetachedViewerRoot(undefined);
    setScrollOrigin('command');
    setScrollAlignment('reveal');
    if (popup && !popup.closed) popup.close();
  };

  const handleViewerScroll = useCallback((id: string, progress: number) => {
    setSourceCursorTarget(undefined);
    setScrollOrigin('right');
    setScrollAlignment('center');
    setScrollProgress(progress);
    setScrollTarget(id);
  }, []);

  const viewerContent = snapshot ? (rightMode === 'visual'
    ? <VisualEditor snapshot={snapshot} activeBlock={scrollTarget} scrollTarget={scrollOrigin === 'right' ? undefined : scrollTarget} scrollProgress={scrollProgress} scrollAlignment={scrollAlignment} fontFamily={settings.viewerFont} fontSize={settings.viewerFontSize} justified={settings.viewerJustified} onApply={applyVisualBlock} onNavigate={navigateFromRight} onScroll={handleViewerScroll}/>
    : <Preview html={rendered?.html ?? ''} objectUrls={rendered?.objectUrls ?? EMPTY_WARNINGS} warnings={rendered?.warnings ?? EMPTY_WARNINGS} blocks={snapshot.blocks} search={search} regularExpression={regularExpression} activeBlock={scrollTarget} scrollTarget={scrollOrigin === 'right' ? undefined : scrollTarget} scrollProgress={scrollProgress} scrollAlignment={scrollAlignment} anchorTarget={previewAnchor} allowRemoteResources={settings.allowRemoteResources} fontFamily={settings.viewerFont} fontSize={settings.viewerFontSize} justified={settings.viewerJustified} trackChangesBaseHtml={trackChangesOpen ? renderedBaseHtml : undefined} comments={comments} activeCommentId={activeCommentId} onNavigate={navigateFromRight} onSelect={selectFromRight} onCommentActivate={(id) => { setInspector('comments'); navigateComment(id); }} onScroll={handleViewerScroll}/>) : null;

  const viewerToolbar = (detached: boolean) => <div className="pane-title viewer-toolbar">
    <div className="segmented"><button className={rightMode === 'visual' ? 'active' : ''} onClick={() => { setScrollOrigin('command'); setScrollAlignment('reveal'); setRightMode('visual'); }}>Visual</button><button className={rightMode === 'preview' ? 'active' : ''} onClick={() => { setScrollOrigin('command'); setScrollAlignment('reveal'); setRightMode('preview'); }}>Rendered</button></div>
    <button className={settings.viewerJustified ? 'viewer-option active' : 'viewer-option'} onClick={() => updateSettings({ ...settings, viewerJustified: !settings.viewerJustified })} title="Justify viewer text" aria-pressed={settings.viewerJustified}><AlignJustify size={14}/></button>
    {rightMode === 'preview' && <button className={trackChangesOpen ? 'viewer-option active' : 'viewer-option'} disabled={!trackChangesOpen && (gitBase?.path !== snapshot?.path || gitBase?.source === snapshot?.source)} onClick={() => setTrackChangesOpen((open) => !open)} title={trackChangesOpen ? 'Hide tracked changes in both panes' : 'Show tracked changes in both panes'} aria-label={trackChangesOpen ? 'Hide tracked changes in both panes' : 'Show tracked changes in both panes'} aria-pressed={trackChangesOpen}><GitCompare size={14}/></button>}
    <span className="spacer"/>
    <span>{Math.round(settings.viewerFontSize / 17 * 100)}% view · {rendered?.engine ?? 'source model'}</span>
    <button className="viewer-option" onClick={detached ? reattachViewer : detachViewer} title={detached ? 'Return viewer to the main window' : 'Detach viewer to another window'} aria-label={detached ? 'Reattach viewer' : 'Detach viewer'}>{detached ? <Columns2 size={15}/> : <ExternalLink size={15}/>}</button>
  </div>;

  if (!('showDirectoryPicker' in window)) return <main className="unsupported-browser"><BrandMark className="welcome-symbol"/><h1>Markroot needs Chromium desktop</h1><p>This browser cannot grant direct access to a real local folder. Use a current Chromium-based desktop browser over HTTPS or localhost; Markroot does not offer an upload fallback.</p></main>;

  return <><div className={`app ${inspector ? 'with-inspector' : ''}`} style={{ '--files-width': `${settings.filesPaneWidth}px` } as CSSProperties}>
    <header className="topbar">
      <div className="brand" aria-label="Markroot"><BrandMark className="brand-mark"/><strong>Markroot</strong></div>
      <button className="workspace-button" onClick={() => void chooseFolder()}><Files size={16}/><span>{rootName}</span><ChevronRight size={14}/></button>
      <div className="document-title"><FileCode2 size={16}/><span>{snapshot?.path ?? 'Open a Markdown or QMD file'}</span>{snapshot?.dirty && <CircleDot size={13} aria-label="Unsaved"/>}</div>
      <div className="top-actions">
        {snapshot && <button onClick={() => void explicitSave()} title="Save (Ctrl/Cmd+S)"><Save size={17}/></button>}
        <button onClick={() => setFindOpen((open) => !open)} title="Find (Ctrl/Cmd+F)"><Search size={17}/></button>
        <button onClick={() => toggleInspector('comments')} className={inspector === 'comments' ? 'selected' : ''} title="Comments"><MessageSquare size={17}/>{comments?.threads.length ? <small>{comments.threads.length}</small> : null}</button>
        <button onClick={() => toggleInspector('git')} className={inspector === 'git' ? 'selected' : ''} title="Git"><GitBranch size={17}/></button>
        <button onClick={() => toggleInspector('export')} className={inspector === 'export' ? 'selected' : ''} title="Export"><Download size={17}/></button>
        <button onClick={() => toggleInspector('settings')} className={inspector === 'settings' ? 'selected' : ''} title="Settings"><Settings2 size={17}/></button>
      </div>
    </header>

    {findOpen && <div className="findbar"><Search size={15}/><input ref={searchInput} value={search} onChange={(event) => { setSearch(event.target.value); setMatchCursor(-1); }} placeholder="Find in source and rendered view"/><button className={regularExpression ? 'find-option active' : 'find-option'} onClick={() => { setRegularExpression((value) => !value); setMatchCursor(-1); }} title="Use regular expression">.*</button><button className="find-step" disabled={!matches.length} onClick={() => navigateMatch(-1)} title="Previous match">↑</button><button className="find-step" disabled={!matches.length} onClick={() => navigateMatch(1)} title="Next match">↓</button><span>{matches.length} source matches</span><form className="goto-line" onSubmit={(event) => { event.preventDefault(); const line = Number.parseInt(lineInput, 10); if (Number.isFinite(line) && line > 0) { setGoToLine(undefined); window.setTimeout(() => setGoToLine(line), 0); } }}><label>Line</label><input inputMode="numeric" aria-label="Go to line" value={lineInput} onChange={(event) => setLineInput(event.target.value.replace(/\D/g, ''))} placeholder="#"/><button type="submit">Go</button></form><button onClick={() => { setSearch(''); setFindOpen(false); }}><X size={15}/></button></div>}
    {notice && <div className="notice" role="status"><span>{notice}</span><button onClick={() => setNotice(undefined)}><X size={14}/></button></div>}
    {aiErrorNotice && <div className="notice error-notice" role="alert"><CircleAlert size={18}/><span>{aiErrorNotice}</span><button onClick={() => setAiErrorNotice(undefined)} aria-label="Dismiss error"><X size={14}/></button></div>}

    <aside className="files-panel">
      <div className="panel-heading"><span>Workspace</span><div className="panel-heading-actions"><button className={outlineOpen ? 'selected' : ''} disabled={!rendered?.outline?.length} onClick={() => setOutlineOpen((open) => !open)} title="Document outline"><ListTree size={14}/></button><button onClick={() => void refreshWorkspace()} title="Refresh"><RefreshCw size={14}/></button></div></div>
      {outlineOpen && <DocumentOutline items={rendered?.outline ?? []} activeBlock={scrollTarget} maxLevel={settings.outlineDepth} showFigures={settings.outlineShowFigures} onSelect={navigateOutline} onMaxLevelChange={(outlineDepth) => updateSettings({ ...settings, outlineDepth })} onShowFiguresChange={(outlineShowFigures) => updateSettings({ ...settings, outlineShowFigures })} onClose={() => setOutlineOpen(false)}/>}
      {!workspace ? <div className="empty-files"><div className="folder-illustration"><Files size={28}/></div><h2>Open a working folder</h2><p>Markroot reads and writes the folder directly. Nothing is uploaded.</p><button className="primary" onClick={() => void chooseFolder()}>Choose folder</button></div>
      : <WorkspaceTree key={rootName} entries={entries} activePath={snapshot?.path} gitStatus={gitStatus} onOpen={(path) => void openFile(path)} onCopy={(path) => void copyWorkspacePath(path)}/>}
      <div className="side-footer"><button onClick={() => toggleInspector('citations')}><BookOpen size={15}/>Citations</button><span>Local only</span></div>
      <PaneResizer className="files-resizer" label="Resize workspace tree" value={settings.filesPaneWidth} min={180} max={420} keyboardStep={12} onChange={(value, finished) => resizeLayout({ filesPaneWidth: Math.round(value) }, finished)}/>
    </aside>

    <main className={`workspace ${detachedViewerRoot ? 'viewer-detached' : ''}`} ref={workspacePane} style={{ '--source-width': `${settings.sourcePaneRatio * 100}%` } as CSSProperties}>
      {!snapshot ? <div className="welcome"><BrandMark className="welcome-symbol"/><h1>Your local writing workspace</h1><p>Choose a folder, then open a Markdown or QMD file. Source, preview, comments, and Git stay together on this device.</p>{!workspace && <button className="primary" onClick={() => void chooseFolder()}>Open folder</button>}</div>
      : <>
        <section className="pane source-pane"><div className="pane-title"><Code2 size={15}/><span>Source</span><button className={trackChangesOpen ? 'viewer-option active' : 'viewer-option'} disabled={!trackChangesOpen && (gitBase?.path !== snapshot.path || gitBase.source === snapshot.source)} onClick={() => setTrackChangesOpen((open) => !open)} title={trackChangesOpen ? 'Hide tracked changes in both panes' : 'Show tracked changes in both panes'} aria-label={trackChangesOpen ? 'Hide tracked changes in both panes' : 'Show tracked changes in both panes'} aria-pressed={trackChangesOpen}><GitCompare size={14}/></button><span className="spacer"/>{detachedViewerRoot && <><button className="detached-indicator" onClick={() => detachedViewerWindow.current?.focus()} title="Focus the detached viewer"><ExternalLink size={13}/>Viewer detached</button><button className="viewer-option" onClick={reattachViewer} title="Return viewer to this window" aria-label="Reattach viewer"><Columns2 size={15}/></button></>}<span>{settings.sourceFontSize}px · Ln {lineAt(snapshot.source, selection.from)}</span></div><SourceEditor path={snapshot.path} workspacePaths={entries.map((entry) => entry.path)} value={snapshot.source} comparisonBase={gitBase?.path === snapshot.path ? gitBase.source : undefined} showTrackChanges={trackChangesOpen} blocks={snapshot.blocks} search={search} regularExpression={regularExpression} dark={dark} fontFamily={settings.sourceFont} fontSize={settings.sourceFontSize} activeBlock={scrollTarget} scrollTarget={scrollOrigin === 'source' ? undefined : scrollTarget} scrollProgress={scrollProgress} scrollAlignment={scrollAlignment} cursorTarget={sourceCursorTarget} goToLine={goToLine} onChange={applySource} onSelection={selectSource} onScroll={(id, progress) => { setSourceCursorTarget(undefined); setScrollOrigin('source'); setScrollAlignment('center'); setScrollProgress(progress); setScrollTarget(id); }} onSave={() => void explicitSave()} onFind={() => setFindOpen(true)}/></section>
        {!detachedViewerRoot && <><PaneResizer label="Resize source and viewer panes" value={settings.sourcePaneRatio} min={0.25} max={0.75} keyboardStep={0.02} pixelsPerUnit={() => workspacePane.current?.clientWidth ?? 1} onChange={(value, finished) => resizeLayout({ sourcePaneRatio: value }, finished)}/><section className="pane right-pane">{viewerToolbar(false)}<div className="right-scroll">{viewerContent}</div></section></>}
      </>}
    </main>

    {inspector && <aside className="inspector"><div className="inspector-head"><strong>{panelTitle(inspector)}</strong><button onClick={() => setInspector(undefined)}><PanelRight size={16}/></button></div>
      {inspector === 'git' && <GitPanel git={git} error={gitError} status={gitStatus} branches={branches} currentBranch={currentBranch} history={history} dirty={snapshot?.dirty ?? false} message={commitMessage} setMessage={setCommitMessage} onStage={stage} onCommit={createCommit} onRefresh={refreshGit} onCheckout={checkoutBranch} onCreateBranch={createBranch} onRenameBranch={renameBranch} onDeleteBranch={deleteBranch} onMerge={mergeBranch} onCompare={compareBranch}/>}
      {inspector === 'review' && <ReviewPanel draft={review} onDecide={(id, decision) => review && setReview(decideChange(review, id, decision))} onApply={applyReview}/>}
      {inspector === 'comments' && <CommentsPanel
        parsed={comments}
        activeId={activeCommentId}
        selection={selection}
        body={commentBody}
        setBody={setCommentBody}
        replies={replyBodies}
        setReplies={setReplyBodies}
        onAdd={addComment}
        onNavigate={navigateComment}
        onRepair={(id) => { if (snapshot) applySource(recoverOrphan(snapshot.source, id), 'comment'); }}
        onReply={(id) => { if (!snapshot || !replyBodies[id]?.trim()) return; applySource(replyToThread(snapshot.source, id, replyBodies[id]!, settings.profile), 'comment'); setReplyBodies((all) => ({ ...all, [id]: '' })); }}
        onStatus={(id, status) => { if (snapshot) applySource(setThreadStatus(snapshot.source, id, status), 'comment'); }}
        onDelete={(id) => { if (snapshot && window.confirm('Delete this comment thread?')) { applySource(deleteThread(snapshot.source, id), 'comment'); if (activeCommentId === id) setActiveCommentId(undefined); } }}
      />}
      {inspector === 'citations' && <CitationsPanel records={citations} query={citationQuery} setQuery={setCitationQuery}/>}
      {inspector === 'export' && <ExportPanel disabled={!snapshot} busy={exportBusy} progress={exportProgress} onCancel={() => exportController.current?.abort()} onExport={exportDocument}/>}
      {inspector === 'settings' && <SettingsPanel settings={settings} aiModelSetup={aiModelSetup} onChange={updateSettings} onAiCommitSuggestionsChange={updateAiCommitSuggestions}/>}
    </aside>}
  </div>{commitDialog && <CommitProposalDialog phase={commitDialog.phase} progress={commitDialog.progress} proposal={commitDialog.proposal} fileCount={commitDialog.candidate?.paths.length ?? 0} onProposalChange={(proposal) => setCommitDialog((current) => current ? { ...current, proposal } : current)} onAccept={() => void acceptAiCommit()} onRegenerate={() => void regenerateCommitProposal()} onCancel={cancelAiCommit}/>} {detachedViewerRoot && createPortal(<main className="detached-viewer"><div className="detached-viewer-title"><BrandMark className="detached-viewer-mark"/><strong>Markroot</strong><span>{snapshot?.path ?? 'Viewer'}</span></div>{viewerToolbar(true)}<div className="right-scroll">{viewerContent}</div></main>, detachedViewerRoot)}</>;
}

function GitPanel({ git, error, status, branches, currentBranch, history, dirty, message, setMessage, onStage, onCommit, onRefresh, onCheckout, onCreateBranch, onRenameBranch, onDeleteBranch, onMerge, onCompare }: { git: IsomorphicGitRepository | undefined; error: string | undefined; status: readonly GitFileStatus[]; branches: readonly string[]; currentBranch: string | undefined; history: readonly GitCommitSummary[]; dirty: boolean; message: string; setMessage(value: string): void; onStage(path: WorkspacePath, staged: boolean): Promise<void>; onCommit(): Promise<void>; onRefresh(): Promise<void>; onCheckout(ref: string): Promise<void>; onCreateBranch(ref: string): Promise<void>; onRenameBranch(from: string, to: string): Promise<void>; onDeleteBranch(ref: string): Promise<void>; onMerge(ref: string): Promise<void>; onCompare(ref: string): Promise<void> }) {
  const [selectedBranch, setSelectedBranch] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [renamedBranch, setRenamedBranch] = useState('');
  const [diff, setDiff] = useState<{ path: WorkspacePath; text: string }>();
  if (!git) return <div className="panel-empty"><GitBranch size={24}/><p>This folder is not a supported Git repository.</p>{error && <small>{error}</small>}</div>;
  const changed = status.filter((item) => item.state !== 'unmodified');
  const candidates = branches.filter((branch) => branch !== currentBranch);
  const selected = selectedBranch || candidates[0] || '';
  return <div className="inspector-body"><div className="section-label"><span>{currentBranch ? `Branch · ${currentBranch}` : 'Detached HEAD'}</span><button onClick={() => void onRefresh()}><RefreshCw size={13}/></button></div><div className="branch-tools"><select value={selected} onChange={(event) => setSelectedBranch(event.target.value)}>{candidates.map((branch) => <option key={branch}>{branch}</option>)}</select><button disabled={!selected || dirty} onClick={() => void onCheckout(selected)}>Checkout</button><button disabled={!selected || dirty} onClick={() => void onCompare(selected)}><GitCompare size={13}/>Compare</button><button disabled={!selected || dirty} onClick={() => void onMerge(selected)}>Merge</button><button disabled={!selected || dirty} onClick={() => void onDeleteBranch(selected)}>Delete</button></div><div className="branch-create"><input value={newBranch} onChange={(event) => setNewBranch(event.target.value)} placeholder="new-branch"/><button disabled={!newBranch.trim()} onClick={() => { void onCreateBranch(newBranch.trim()); setNewBranch(''); }}>Create</button></div>{currentBranch && <div className="branch-create"><input value={renamedBranch} onChange={(event) => setRenamedBranch(event.target.value)} placeholder={`rename ${currentBranch}`}/><button disabled={dirty || !renamedBranch.trim() || renamedBranch.trim() === currentBranch} onClick={() => { void onRenameBranch(currentBranch, renamedBranch.trim()); setRenamedBranch(''); }}>Rename</button></div>}<div className="section-label"><span>Changes · {changed.length}</span></div>{dirty && <p className="warning">Save the open document before staging.</p>}<div className="change-list">{changed.map((item) => { const staged = item.state === 'staged' || item.state === 'added'; return <div key={item.path}><span className={`status-code ${item.state}`}>{statusLetter(item.state)}</span><button className="path-button" title={`Show diff for ${item.path}`} onClick={() => void git.diff(item.path).then((text) => setDiff({ path: item.path, text }))}>{item.path}</button><button disabled={dirty} onClick={() => void onStage(item.path, staged)}>{staged ? <Undo2 size={13}/> : <Check size={13}/>}</button></div>; })}</div>{diff && <div className="git-diff"><header><span>{diff.path}</span><button onClick={() => setDiff(undefined)}><X size={12}/></button></header><pre>{diff.text}</pre></div>}<label className="field"><span>Commit message</span><textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={3}/></label><button className="primary wide" disabled={!message.trim() || dirty} onClick={() => void onCommit()}><GitCommitHorizontal size={15}/>Commit staged changes</button><div className="section-label history-label"><span>History</span></div><div className="history-list">{history.slice(0, 8).map((entry) => <div key={entry.oid}><code>{entry.oid.slice(0, 7)}</code><span>{entry.message.split('\n')[0]}</span><small>{entry.author.displayName}</small></div>)}</div><p className="microcopy">Local repository only. Markroot never contacts a remote.</p></div>;
}

function ReviewPanel({ draft, onDecide, onApply }: { draft: ReviewDraft | undefined; onDecide(id: string, decision: 'accept' | 'reject'): void; onApply(): void | Promise<void> }) {
  if (!draft) return <div className="panel-empty"><GitCompare size={24}/><p>No branch comparison is open.</p></div>;
  const pending = draft.changes.filter((change) => change.decision === 'pending').length;
  return <div className="inspector-body"><p>{draft.changes.length} tracked change(s). Accept includes the compared branch; reject retains the current branch.</p><div className="review-list">{draft.changes.map((change) => <article key={change.id} className={change.decision}><div className="tracked-text">{change.segments.map((segment, index) => <span key={index} className={segment.kind}>{segment.value || '∅'}</span>)}</div><div className="review-meta"><span>{change.authors.map((author) => author.displayName).join(', ') || 'Unknown author'}</span><div><button className={change.decision === 'accept' ? 'selected' : ''} onClick={() => onDecide(change.id, 'accept')}>Accept</button><button className={change.decision === 'reject' ? 'selected' : ''} onClick={() => onDecide(change.id, 'reject')}>Reject</button></div></div></article>)}</div><button className="primary wide" disabled={pending > 0} onClick={onApply}>Apply reviewed result</button>{pending > 0 && <p className="microcopy">{pending} change(s) still need a decision.</p>}</div>;
}

function CommentsPanel({ parsed, activeId, selection, body, setBody, replies, setReplies, onAdd, onNavigate, onRepair, onReply, onStatus, onDelete }: { parsed: ReturnType<typeof parseComments> | undefined; activeId: string | undefined; selection: SourceRange; body: string; setBody(value: string): void; replies: Record<string, string>; setReplies(value: Record<string, string>): void; onAdd(): void; onNavigate(id: string): void; onRepair(id: string): void; onReply(id: string): void; onStatus(id: string, status: 'open' | 'resolved'): void; onDelete(id: string): void }) {
  return <div className="inspector-body"><div className="selection-chip">Selected range: {selection.from}–{selection.to}</div><label className="field"><span>New comment</span><textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Add a precise note…" rows={3}/></label><button className="primary wide" disabled={selection.to <= selection.from || !body.trim()} onClick={onAdd}><MessageSquare size={15}/>Add comment</button><div className="thread-list">{parsed?.threads.map((thread) => { const orphan = parsed.orphans.includes(thread.id); return <article key={thread.id} className={`${thread.status === 'resolved' ? 'resolved' : ''}${thread.id === activeId ? ' active' : ''}`}><header><button onClick={() => onNavigate(thread.id)}>{orphan ? 'orphan' : thread.status}</button>{orphan && <button onClick={() => onRepair(thread.id)}>Repair</button>}<button onClick={() => onStatus(thread.id, thread.status === 'open' ? 'resolved' : 'open')}>{thread.status === 'open' ? 'Resolve' : 'Reopen'}</button><button onClick={() => onDelete(thread.id)}><X size={13}/></button></header>{thread.messages.map((message) => <div className="message" key={message.id}><strong>{message.author.displayName}</strong><p>{message.body}</p><time>{new Date(message.createdAt).toLocaleString()}</time></div>)}<div className="reply"><input value={replies[thread.id] ?? ''} onChange={(event) => setReplies({ ...replies, [thread.id]: event.target.value })} placeholder="Reply…"/><button onClick={() => onReply(thread.id)}>Send</button></div></article>; })}</div>{parsed?.orphans.length ? <p className="warning">{parsed.orphans.length} thread(s) need anchor repair.</p> : null}</div>;
}

function CitationsPanel({ records, query, setQuery }: { records: readonly CitationRecord[]; query: string; setQuery(value: string): void }) {
  const filtered = records.filter((record) => [record.key, record.title, record.author].some((value) => value?.toLowerCase().includes(query.toLowerCase())));
  return <div className="inspector-body"><label className="search-field"><Search size={14}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search local .bib files"/></label><div className="citation-list">{filtered.map((record) => <article key={`${record.source}:${record.key}`}><code>@{record.key}</code><strong>{record.title ?? 'Untitled reference'}</strong><span>{[record.author, record.year].filter(Boolean).join(' · ')}</span></article>)}</div>{!records.length && <p className="microcopy">No BibTeX entries found in this folder.</p>}</div>;
}

function ExportPanel({ disabled, busy, progress, onCancel, onExport }: { disabled: boolean; busy: boolean; progress: ExportProgressState | undefined; onCancel(): void; onExport(format: ExportFormat, destination: 'download' | 'save-as' | 'workspace'): Promise<void> }) {
  const [destination, setDestination] = useState<'download' | 'save-as' | 'workspace'>('download');
  return <div className="inspector-body"><p>Exports run locally with bundled engines and local document resources. Comments and review markers are removed.</p><label className="field"><span>Destination</span><select disabled={busy} value={destination} onChange={(event) => setDestination(event.target.value as typeof destination)}><option value="download">Browser download</option><option value="save-as">Save As…</option><option value="workspace">Beside source</option></select></label>{(['html', 'docx', 'pdf'] as const).map((format) => <button key={format} className="export-button" disabled={disabled || busy} onClick={() => void onExport(format, destination)}><Download size={16}/><span><strong>{format.toUpperCase()}</strong><small>{format === 'pdf' ? 'Pandoc → Typst WASM' : 'Pandoc WASM'}</small></span></button>)}{progress && <ExportProgress progress={progress} busy={busy} onCancel={onCancel}/>}</div>;
}

function ExportProgress({ progress, busy, onCancel }: { progress: ExportProgressState; busy: boolean; onCancel(): void }) {
  const total = progress.total ?? 1;
  const percent = Math.round(Math.max(0, Math.min(1, progress.completed / total)) * 100);
  const steps = progress.format === 'pdf' ? ['Resources', 'Pandoc', 'Typst', 'Save'] : ['Resources', 'Pandoc', 'Save'];
  return <section className={`export-progress ${busy ? 'running' : 'complete'}`} aria-live="polite">
    <div className="export-progress-heading">{busy ? <RefreshCw className="spin" size={15}/> : <Check size={15}/>}<strong>{progress.format.toUpperCase()} export</strong><span>{percent}%</span></div>
    <div className="export-progress-track" role="progressbar" aria-label={`${progress.format.toUpperCase()} export progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }}/></div>
    <p>{progress.message ?? `Exporting ${progress.format.toUpperCase()}…`}</p>
    <ol>{steps.map((step, index) => <li key={step} className={index < progress.completed || !busy && index === steps.length - 1 ? 'done' : index === progress.completed ? 'active' : ''}><span>{index < progress.completed || !busy && index === steps.length - 1 ? <Check size={10}/> : index + 1}</span>{step}</li>)}</ol>
    {busy && <div className="export-progress-actions"><button className="export-cancel" onClick={onCancel}><X size={13}/>Cancel export</button></div>}
  </section>;
}

function exportStepTotal(format: ExportFormat): number { return format === 'pdf' ? 4 : 3; }

function appExportProgress(format: ExportFormat, progress: ProgressEvent): ExportProgressState {
  const total = exportStepTotal(format);
  const completed = progress.phase === 'complete' ? total - 1 : progress.phase === 'typst' ? 2 : progress.phase === 'pandoc' || progress.phase === 'prepare' ? 1 : 0;
  return { format, phase: progress.phase, completed, total, ...(progress.message ? { message: progress.message } : {}) };
}

function exportSaveMessage(destination: 'download' | 'save-as' | 'workspace'): string {
  return destination === 'workspace' ? 'Saving beside the source' : destination === 'save-as' ? 'Writing selected file' : 'Preparing browser download';
}

function SettingsPanel({ settings, aiModelSetup, onChange, onAiCommitSuggestionsChange }: { settings: MarkrootSettings; aiModelSetup: AiModelSetupState | undefined; onChange(settings: MarkrootSettings): void; onAiCommitSuggestionsChange(enabled: boolean): void }) {
  const fontOptions = <><option value="serif">Source Serif</option><option value="sans">Manrope</option><option value="mono">IBM Plex Mono</option></>;
  return <div className="inspector-body"><div className="theme-picker"><button className={settings.theme === 'light' ? 'active' : ''} onClick={() => onChange({ ...settings, theme: 'light' })}><Sun size={15}/>Light</button><button className={settings.theme === 'dark' ? 'active' : ''} onClick={() => onChange({ ...settings, theme: 'dark' })}><Moon size={15}/>Dark</button><button className={settings.theme === 'system' ? 'active' : ''} onClick={() => onChange({ ...settings, theme: 'system' })}>System</button></div><div className="section-label"><span>Typography</span></div><div className="typography-settings"><label className="field"><span>Source font</span><select value={settings.sourceFont} onChange={(event) => onChange({ ...settings, sourceFont: event.target.value as MarkrootSettings['sourceFont'] })}>{fontOptions}</select></label><label className="field"><span>Source size</span><input type="number" min="12" max="28" value={settings.sourceFontSize} onChange={(event) => onChange({ ...settings, sourceFontSize: boundedFontSize(event.target.value, settings.sourceFontSize) })}/></label><label className="field"><span>Viewer font</span><select value={settings.viewerFont} onChange={(event) => onChange({ ...settings, viewerFont: event.target.value as MarkrootSettings['viewerFont'] })}>{fontOptions}</select></label><label className="field"><span>Viewer size</span><input type="number" min="12" max="28" value={settings.viewerFontSize} onChange={(event) => onChange({ ...settings, viewerFontSize: boundedFontSize(event.target.value, settings.viewerFontSize) })}/></label></div><p className="microcopy">Sizes scale each writing surface proportionally, including spacing and padding. They are display-only and never change exported document typography.</p><label className="check"><input type="checkbox" checked={settings.viewerJustified} onChange={(event) => onChange({ ...settings, viewerJustified: event.target.checked })}/><span>Justify viewer paragraphs</span></label><div className="section-label identity-label"><span>Local identity</span></div><label className="field"><span>Display name</span><input value={settings.profile.displayName} onChange={(event) => onChange({ ...settings, profile: { ...settings.profile, displayName: event.target.value } })}/></label><label className="field"><span>Git email</span><input type="email" value={settings.profile.email ?? ''} onChange={(event) => onChange({ ...settings, profile: { ...settings.profile, email: event.target.value } })}/></label><label className="check"><input type="checkbox" checked={settings.autosave} onChange={(event) => onChange({ ...settings, autosave: event.target.checked })}/><span>Autosave documents</span></label><label className="check"><input type="checkbox" checked={settings.aiCommitSuggestions} onChange={(event) => onAiCommitSuggestionsChange(event.target.checked)}/><span>Generate commit messages with Chrome on-device AI</span></label>{settings.aiCommitSuggestions && aiModelSetup && <AiModelSetupStatus state={aiModelSetup}/>}<p className="microcopy">Enabling this option requests the Gemini Nano download from Chrome. The browser manages it outside this tab’s normal Network requests; inspect <code>chrome://on-device-internals</code> for model status. Only candidate Git diffs are passed to the model, with no cloud fallback.</p><label className="check"><input type="checkbox" checked={settings.allowRemoteResources} onChange={(event) => onChange({ ...settings, allowRemoteResources: event.target.checked })}/><span>Allow remote preview resources</span></label><p className="microcopy">Preferences and your local identity are stored only in this browser.</p></div>;
}

function AiModelSetupStatus({ state }: { state: AiModelSetupState }) {
  const loaded = state.loaded === undefined ? undefined : Math.max(0, Math.min(1, state.loaded));
  const working = state.phase === 'checking' || state.phase === 'downloading';
  return <div className={`ai-model-status ${state.phase}`} role={state.phase === 'unavailable' ? 'alert' : 'status'} aria-live={state.phase === 'unavailable' ? 'assertive' : 'polite'}>
    <div>{working ? <RefreshCw className="spin" size={14}/> : state.phase === 'ready' ? <Check size={14}/> : <X size={14}/>}<strong>{state.phase === 'ready' ? 'Model ready' : state.phase === 'unavailable' ? 'Model unavailable' : state.phase === 'downloading' ? 'Preparing model' : 'Checking support'}</strong>{loaded !== undefined && loaded > 0 && <span>{Math.round(loaded * 100)}%</span>}</div>
    {state.phase === 'downloading' && <div className={`ai-model-progress ${loaded === undefined || loaded === 0 ? 'indeterminate' : ''}`} role="progressbar" aria-label="Chrome on-device AI model download" aria-valuemin={0} aria-valuemax={100} {...(loaded !== undefined && loaded > 0 ? { 'aria-valuenow': Math.round(loaded * 100) } : {})}><span style={loaded !== undefined && loaded > 0 ? { width: `${Math.round(loaded * 100)}%` } : undefined}/></div>}
    <p>{state.message}</p>
  </div>;
}

async function documentEntries(workspace: GuardedWorkspace): Promise<readonly WorkspaceEntry[]> {
  const result: WorkspaceEntry[] = [];
  const visit = async (parent?: WorkspacePath) => {
    for (const entry of await workspace.listFiles(parent)) {
      const name = entry.path.split('/').at(-1)!;
      if (entry.kind === 'directory') {
        if (!['.git', 'node_modules', '.quarto', '_freeze'].includes(name)) { result.push(entry); await visit(entry.path); }
      } else result.push(entry);
    }
  };
  await visit();
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function resolvedDark(theme: MarkrootSettings['theme']): boolean { return theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches); }
function panelTitle(panel: Exclude<Inspector, undefined>): string { return ({ git: 'Local Git', review: 'Track Changes', comments: 'Comments', citations: 'Citations', export: 'Export', settings: 'Settings' })[panel]; }
function statusLetter(status: GitFileStatus['state']): string { return ({ modified: 'M', added: 'A', deleted: 'D', untracked: 'U', staged: 'S', unmodified: '·' })[status]; }
function lineAt(source: string, offset: number): number { return source.slice(0, offset).split('\n').length; }
function boundedFontSize(value: string, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(12, Math.min(28, Math.round(parsed))) : fallback; }
function download(blob: Blob, filename: string): void { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
function revokeArtifact(artifact: RenderArtifact | undefined): void { artifact?.objectUrls?.forEach((url) => URL.revokeObjectURL(url)); }

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: readonly { description: string; accept: Record<string, readonly string[]> }[];
}

async function collectPreviewResources(workspace: GuardedWorkspace | undefined, snapshot: DocumentSnapshot, signal?: AbortSignal): Promise<readonly ExportResource[]> {
  if (!workspace) return [];
  const resources: ExportResource[] = [];
  const seen = new Set<string>();
  for (const match of snapshot.source.matchAll(/!\[(?:[^\[\]]|\[[^\]]*\])*\]\((<[^>]+>|[^\s)>]+)(?:\s+["'][^"']*["'])?\)/g)) {
    const reference = unwrapReference(match[1]!);
    if (/^(?:https?:|data:|blob:|#)/i.test(reference) || seen.has(reference)) continue;
    seen.add(reference);
    try {
      const path = resolveWorkspaceReference(snapshot.path, reference);
      const context = signal ? { signal } : undefined;
      const stat = await workspace.stat(path, context);
      if (stat.kind !== 'file') continue;
      const bytes = await workspace.readBytes(path, context);
      const localFile = new Blob([bytes.slice()], { type: mediaTypeForPath(path) });
      let content = localFile;
      if (isPdfFigurePath(path)) {
        const version = stat.version ?? `${stat.modifiedAt ?? 'unknown'}:${stat.size}`;
        try { content = await renderPdfFigurePreview(localFile, `${path}:${version}`); }
        catch { /* retain the PDF blob so the viewer presents its normal image-unavailable fallback */ }
      }
      if (signal?.aborted) throw signal.reason;
      resources.push({ path: reference, content });
    } catch { /* the preview keeps the unresolved path and renderer warnings remain non-destructive */ }
  }
  return resources;
}

async function collectDocumentResources(workspace: GuardedWorkspace, snapshot: DocumentSnapshot, format: ExportFormat, exportOptions: ReturnType<typeof parseExportOptions>, context?: OperationContext): Promise<readonly ExportResource[]> {
  const sourceReferences = new Set<string>();
  for (const match of snapshot.source.matchAll(/!\[(?:[^\[\]]|\[[^\]]*\])*\]\((<[^>]+>|[^\s)>]+)(?:\s+["'][^"']*["'])?\)/g)) sourceReferences.add(unwrapReference(match[1]!));
  for (const match of snapshot.source.matchAll(/\b(?:bibliography|csl|reference-doc)\s*:\s*["']?([^\s"']+)/gi)) sourceReferences.add(unwrapReference(match[1]!));
  for (const reference of [exportOptions.referenceDocx, exportOptions.htmlTemplate, exportOptions.typstTemplate, ...exportOptions.htmlCss, ...exportOptions.typstTemplatePartials]) {
    if (reference) sourceReferences.add(reference);
  }
  const localReferences = [...sourceReferences].filter((reference) => !/^(?:https?:|data:|blob:|#)/i.test(reference));
  const resources: ExportResource[] = [];
  const added = new Set<string>();
  const add = async (reference: string, path: WorkspacePath) => {
    if (added.has(reference)) return;
    throwIfAborted(context);
    const stat = await workspace.stat(path, context);
    if (stat.kind !== 'file') return;
    const bytes = await workspace.readBytes(path, context);
    const localFile = new Blob([bytes.slice()], { type: mediaTypeForPath(path) });
    const content = format !== 'pdf' && isPdfFigurePath(path)
      ? await abortable(renderPdfFigurePreview(localFile, `export:${path}:${stat.version ?? `${stat.modifiedAt ?? 'unknown'}:${stat.size}`}`), context?.signal)
      : localFile;
    throwIfAborted(context);
    resources.push({ path: reference, content });
    added.add(reference);
  };
  if (!localReferences.length) context?.onProgress?.({ phase: 'resources', completed: 0, total: 0, message: 'No local resources to collect' });
  for (const [index, reference] of localReferences.entries()) {
    context?.onProgress?.({ phase: 'resources', completed: index, total: localReferences.length, message: `Reading resource ${index + 1} of ${localReferences.length}: ${reference}` });
    try {
      await add(reference, resolveWorkspaceReference(snapshot.path, reference));
    } catch { throwIfAborted(context); /* unresolved dependencies are reported by Pandoc */ }
  }
  return resources;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted({ signal });
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Export cancelled.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

function unwrapReference(reference: string): string { return reference.trim().replace(/^<([\s\S]*)>$/, '$1'); }
function mediaTypeForPath(path: string): string {
  const extension = path.split('.').at(-1)?.toLowerCase();
  return ({ avif: 'image/avif', gif: 'image/gif', jpeg: 'image/jpeg', jpg: 'image/jpeg', pdf: 'application/pdf', png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp', bib: 'text/plain', bibtex: 'text/plain', csl: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml' } as Record<string, string>)[extension ?? ''] ?? 'application/octet-stream';
}
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

function fileBasename(path: string): string { return (path.split('/').at(-1) ?? 'document').replace(/\.(?:md|qmd)$/i, ''); }
function exportMime(format: ExportFormat): string { return format === 'html' ? 'text/html' : format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf'; }

async function attributeReviewChanges(git: IsomorphicGitRepository, path: WorkspacePath, ref: string, draft: ReviewDraft): Promise<ReadonlyMap<string, readonly GitCommitSummary['author'][]>> {
  const commits = [...await git.history(100, ref)].reverse();
  const contents = await Promise.all(commits.map((entry) => git.readFileAtRef(path, entry.oid).catch(() => '')));
  const result = new Map<string, readonly GitCommitSummary['author'][]>();
  for (const change of draft.changes) {
    let previous = '';
    for (let index = 0; index < commits.length; index += 1) {
      const current = contents[index] ?? '';
      const insertedHere = Boolean(change.compareText) && current.includes(change.compareText) && !previous.includes(change.compareText);
      const deletedHere = Boolean(change.baseText) && previous.includes(change.baseText) && !current.includes(change.baseText);
      if (insertedHere || deletedHere) result.set(change.id, [commits[index]!.author]);
      previous = current;
    }
  }
  return result;
}
