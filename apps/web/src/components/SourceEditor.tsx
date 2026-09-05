import { useEffect, useMemo, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { SearchQuery, setSearchQuery } from '@codemirror/search';
import { Compartment, EditorState, RangeSet, RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, keymap, type DecorationSet } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { DocumentBlock } from '@markroot/document';
import { relativeWorkspaceReference, type SourceRange, type WorkspacePath } from '@markroot/core';
import { isScrollKey, ScrollIntentGate, viewportCenter } from './scroll-sync.js';
import { editorLineChanges, type EditorLineChange, type EditorLineChangeKind } from '../editor-line-changes.js';
import { editorTrackChanges, type EditorTrackChange } from '../editor-track-changes.js';

interface Props {
  path: WorkspacePath;
  workspacePaths: readonly WorkspacePath[];
  value: string;
  comparisonBase?: string | undefined;
  showTrackChanges: boolean;
  blocks: readonly DocumentBlock[];
  search: string;
  regularExpression: boolean;
  dark: boolean;
  fontFamily: 'serif' | 'sans' | 'mono';
  fontSize: number;
  activeBlock?: string | undefined;
  scrollTarget?: string | undefined;
  scrollProgress?: number | undefined;
  scrollAlignment: 'center' | 'reveal';
  cursorTarget?: number | undefined;
  goToLine?: number | undefined;
  onChange(value: string): void;
  onSelection(range: SourceRange): void;
  onScroll(blockId: string, progress: number): void;
  onSave(): void;
  onFind(): void;
}

export function SourceEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const changing = useRef(false);
  const scrollIntent = useRef(new ScrollIntentGate());
  const appearance = useRef(new Compartment());
  const latest = useRef(props);
  const lineChanges = useMemo(() => editorLineChanges(props.comparisonBase, props.value), [props.comparisonBase, props.value]);
  const trackChanges = useMemo(() => props.showTrackChanges ? editorTrackChanges(props.comparisonBase, props.value) : [], [props.showTrackChanges, props.comparisonBase, props.value]);
  latest.current = props;

  useEffect(() => {
    if (!host.current) return;
    const extensions: Extension[] = [
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { latest.current.onSave(); return true; } },
        { key: 'Mod-f', preventDefault: true, run: () => { latest.current.onFind(); return true; } },
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !changing.current) latest.current.onChange(update.state.doc.toString());
        if (update.selectionSet) {
          const selection = update.state.selection.main;
          latest.current.onSelection({ from: selection.from, to: selection.to });
        }
      }),
      EditorView.domEventHandlers({
        paste(event, editor) {
          const pasted = event.clipboardData?.getData('text/plain').trim();
          if (!pasted || pasted.includes('\n')) return false;
          const normalized = pasted.replace(/^\.\//, '');
          const target = latest.current.workspacePaths.find((path) => path === normalized);
          if (!target) return false;
          const selection = editor.state.selection.main;
          const relative = relativeWorkspaceReference(latest.current.path, target);
          const insertion = markdownPathAtCursor(editor.state.doc.toString(), selection.from, relative);
          event.preventDefault();
          editor.dispatch({
            changes: { from: selection.from, to: selection.to, insert: insertion },
            selection: { anchor: selection.from + insertion.length },
            userEvent: 'input.paste',
          });
          return true;
        },
      }),
      activeBlockField,
      lineChangeGutter,
      trackChangesField,
      appearance.current.of(editorAppearance(props.dark, props.fontFamily, props.fontSize)),
    ];
    const editor = new EditorView({ state: EditorState.create({ doc: props.value, extensions }), parent: host.current });
    let frame = 0;
    const onScroll = () => {
      if (!scrollIntent.current.shouldPublish()) return;
      scrollIntent.current.continueScroll();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const viewport = editor.scrollDOM.getBoundingClientRect();
        const position = editor.posAtCoords({ x: viewport.left + Math.min(80, viewport.width / 2), y: viewportCenter(viewport) }) ?? editor.viewport.from;
        const block = latest.current.blocks.find((candidate) => position >= candidate.from && position <= candidate.to) ?? latest.current.blocks.at(-1);
        if (!block) return;
        latest.current.onScroll(block.id, Math.max(0, Math.min(1, (position - block.from) / Math.max(1, block.to - block.from))));
      });
    };
    const beginPointer = () => scrollIntent.current.beginPointer();
    const endPointer = () => scrollIntent.current.endPointer();
    const markWheel = () => scrollIntent.current.markIntent();
    const markKeyboard = (event: KeyboardEvent) => { if (isScrollKey(event)) scrollIntent.current.markIntent(); };
    editor.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    editor.scrollDOM.addEventListener('wheel', markWheel, { passive: true });
    editor.scrollDOM.addEventListener('pointerdown', beginPointer, { passive: true });
    editor.scrollDOM.addEventListener('keydown', markKeyboard);
    window.addEventListener('pointerup', endPointer, { passive: true });
    window.addEventListener('pointercancel', endPointer, { passive: true });
    view.current = editor;
    return () => {
      cancelAnimationFrame(frame);
      editor.scrollDOM.removeEventListener('scroll', onScroll);
      editor.scrollDOM.removeEventListener('wheel', markWheel);
      editor.scrollDOM.removeEventListener('pointerdown', beginPointer);
      editor.scrollDOM.removeEventListener('keydown', markKeyboard);
      window.removeEventListener('pointerup', endPointer);
      window.removeEventListener('pointercancel', endPointer);
      editor.destroy();
      view.current = undefined;
    };
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: appearance.current.reconfigure(editorAppearance(props.dark, props.fontFamily, props.fontSize)) });
  }, [props.dark, props.fontFamily, props.fontSize]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === props.value) return;
    changing.current = true;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: props.value } });
    changing.current = false;
  }, [props.value]);

  useEffect(() => {
    view.current?.dispatch({ effects: setLineChanges.of(lineChanges) });
  }, [lineChanges]);

  useEffect(() => {
    view.current?.dispatch({ effects: setTrackChanges.of(trackChanges) });
  }, [trackChanges]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: props.search, literal: !props.regularExpression })) });
  }, [props.search, props.regularExpression]);

  useEffect(() => {
    const editor = view.current;
    const block = props.blocks.find((candidate) => candidate.id === props.scrollTarget);
    if (editor && block) {
      const progress = Math.max(0, Math.min(1, props.scrollProgress ?? 0));
      const position = Math.min(block.to, block.from + Math.round((block.to - block.from) * progress));
      scrollIntent.current.beginProgrammatic();
      const aligned = props.scrollAlignment === 'center' ? positionCentered(editor, position) : positionVisible(editor, position);
      if (!aligned) {
        editor.dispatch({ effects: EditorView.scrollIntoView(position, { y: 'center' }) });
      }
      requestAnimationFrame(() => scrollIntent.current.endProgrammatic());
    }
  }, [props.scrollTarget, props.scrollProgress, props.scrollAlignment, props.blocks]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || props.cursorTarget === undefined) return;
    const position = Math.max(0, Math.min(props.cursorTarget, editor.state.doc.length));
    scrollIntent.current.beginProgrammatic();
    editor.dispatch({
      selection: { anchor: position },
      ...(positionVisible(editor, position) ? {} : { effects: EditorView.scrollIntoView(position, { y: 'center' }) }),
    });
    editor.focus();
    requestAnimationFrame(() => scrollIntent.current.endProgrammatic());
  }, [props.cursorTarget]);

  useEffect(() => {
    const editor = view.current;
    const block = props.blocks.find((candidate) => candidate.id === props.activeBlock);
    editor?.dispatch({ effects: setActiveBlock.of(block ? { from: block.from, to: block.to } : undefined) });
  }, [props.activeBlock, props.blocks]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || props.goToLine === undefined) return;
    const lineNumber = Math.max(1, Math.min(props.goToLine, editor.state.doc.lines));
    const position = editor.state.doc.line(lineNumber).from;
    scrollIntent.current.beginProgrammatic();
    editor.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) });
    editor.focus();
    requestAnimationFrame(() => scrollIntent.current.endProgrammatic());
  }, [props.goToLine]);

  return <div className="source-editor" ref={host} aria-label="Markdown source editor" />;
}

const setActiveBlock = StateEffect.define<SourceRange | undefined>();
const activeBlockField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setActiveBlock)) next = blockDecorations(transaction.state.doc, effect.value);
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const setLineChanges = StateEffect.define<readonly EditorLineChange[]>();

class LineChangeMarker extends GutterMarker {
  constructor(readonly kind: EditorLineChangeKind) { super(); }
  toDOM() {
    const marker = document.createElement('span');
    marker.className = `cm-line-change-marker ${this.kind}`;
    marker.title = `${this.kind[0]!.toUpperCase()}${this.kind.slice(1)} line compared with HEAD`;
    return marker;
  }
}

const lineChangeField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(markers, transaction) {
    let next = markers.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setLineChanges)) next = lineChangeMarkers(transaction.state.doc, effect.value);
    return next;
  },
});

const lineChangeGutter = [
  lineChangeField,
  gutter({ class: 'cm-line-change-gutter', markers: (view) => view.state.field(lineChangeField) }),
];

const setTrackChanges = StateEffect.define<readonly EditorTrackChange[]>();

class DeletedTextWidget extends WidgetType {
  constructor(readonly value: string) { super(); }
  eq(other: DeletedTextWidget) { return this.value === other.value; }
  toDOM() {
    const deleted = document.createElement('span');
    deleted.className = 'cm-track-delete';
    deleted.textContent = this.value.replaceAll('\n', ' ↵ ');
    deleted.title = 'Deleted text';
    return deleted;
  }
  ignoreEvent() { return true; }
}

const trackChangesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setTrackChanges)) next = trackChangeDecorations(effect.value);
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function trackChangeDecorations(changes: readonly EditorTrackChange[]): DecorationSet {
  return Decoration.set(changes.map((change) => change.kind === 'insert'
    ? Decoration.mark({ class: 'cm-track-insert', attributes: { title: 'Added text' } }).range(change.from, change.to)
    : Decoration.widget({ widget: new DeletedTextWidget(change.value), side: -1 }).range(change.at)), true);
}

function lineChangeMarkers(document: Text, changes: readonly EditorLineChange[]): RangeSet<GutterMarker> {
  const markers = new RangeSetBuilder<GutterMarker>();
  for (const change of changes) {
    const line = document.line(Math.max(1, Math.min(document.lines, change.line)));
    markers.add(line.from, line.from, new LineChangeMarker(change.kind));
  }
  return markers.finish();
}

function blockDecorations(document: Text, range: SourceRange | undefined): DecorationSet {
  if (!range || range.from >= range.to || range.from > document.length) return Decoration.none;
  const decorations = [];
  let position = Math.max(0, range.from);
  const to = Math.min(range.to, document.length);
  while (position <= to) {
    const line = document.lineAt(position);
    decorations.push(Decoration.line({ class: 'cm-current-block' }).range(line.from));
    if (line.to >= to || line.to >= document.length) break;
    position = line.to + 1;
  }
  return Decoration.set(decorations);
}

function editorTheme(dark: boolean, fontFamily: Props['fontFamily'], fontSize: number): Extension {
  const scale = fontSize / 14;
  return EditorView.theme({
    '&': { height: '100%', fontSize: `${fontSize}px`, backgroundColor: 'transparent' },
    '.cm-scroller': { fontFamily: fontStack(fontFamily), lineHeight: '1.65' },
    '.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
    '.cm-line-change-gutter': { width: `${5 * scale}px` },
    '.cm-line-change-gutter .cm-gutterElement': { display: 'flex', alignItems: 'stretch', padding: '0' },
    '.cm-line-change-marker': { display: 'block', width: `${3 * scale}px`, minHeight: '100%', backgroundColor: 'var(--accent)', borderRadius: `0 ${2 * scale}px ${2 * scale}px 0` },
    '.cm-line-change-marker.modified': { backgroundColor: 'var(--orange)' },
    '.cm-line-change-marker.deleted': { alignSelf: 'flex-start', width: `${4 * scale}px`, minHeight: `${3 * scale}px`, marginTop: `${2 * scale}px`, backgroundColor: 'var(--danger)', borderRadius: `0 ${2 * scale}px ${2 * scale}px 0` },
    '.cm-track-insert': { color: 'var(--accent-strong)', backgroundColor: 'var(--accent-soft)', textDecoration: 'underline', textDecorationColor: 'var(--accent)', textUnderlineOffset: `${2 * scale}px`, borderRadius: `${2 * scale}px` },
    '.cm-track-delete': { color: 'var(--danger)', backgroundColor: 'var(--danger-soft)', textDecoration: 'line-through', textDecorationThickness: `${1.5 * scale}px`, margin: `0 ${1 * scale}px`, padding: `0 ${1.5 * scale}px`, borderRadius: `${2 * scale}px`, whiteSpace: 'pre-wrap' },
    '.cm-content': { padding: `${24 * scale}px ${12 * scale}px ${64 * scale}px` },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--active-line)' },
    '.cm-current-block': { backgroundColor: 'color-mix(in srgb, var(--accent) 9%, transparent)', boxShadow: `inset ${3 * scale}px 0 0 var(--accent)` },
  }, { dark });
}

function editorAppearance(dark: boolean, fontFamily: Props['fontFamily'], fontSize: number): Extension {
  return [
    editorTheme(dark, fontFamily, fontSize),
    syntaxHighlighting(HighlightStyle.define([{
      tag: tags.url,
      color: dark ? '#8fd8ff' : '#075f82',
      textDecoration: 'underline',
    }])),
  ];
}

function positionVisible(editor: EditorView, position: number): boolean {
  const coords = editor.coordsAtPos(position);
  const viewport = editor.scrollDOM.getBoundingClientRect();
  if (!coords) return false;
  const margin = Math.min(48, viewport.height * .12);
  return coords.top >= viewport.top + margin && coords.bottom <= viewport.bottom - margin;
}

function positionCentered(editor: EditorView, position: number): boolean {
  const coords = editor.coordsAtPos(position);
  if (!coords) return false;
  const viewport = editor.scrollDOM.getBoundingClientRect();
  const positionCenter = (coords.top + coords.bottom) / 2;
  return Math.abs(positionCenter - viewportCenter(viewport)) <= 1;
}

function fontStack(font: Props['fontFamily']): string {
  if (font === 'serif') return '"Source Serif 4", Georgia, serif';
  if (font === 'sans') return '"Manrope", system-ui, sans-serif';
  return '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace';
}

function markdownPathAtCursor(source: string, offset: number, path: string): string {
  if (!/\s/.test(path)) return path;
  const lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  return /!?\[[^\]]*\]\([^)]*$/.test(source.slice(lineStart, offset)) ? `<${path}>` : path;
}
