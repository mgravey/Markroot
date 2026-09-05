# Markroot documentation

## Architecture

Markroot is a pnpm workspace. Every package exposes contracts from its public `src/index.ts`; implementations are composed only by the web application.

| Package | Responsibility |
| --- | --- |
| `@markroot/core` | Errors, revisions, operations, progress, paths, and shared types |
| `@markroot/workspace` | File System Access API and in-memory workspace adapters |
| `@markroot/document` | Canonical source session, block mapping, edits, and search |
| `@markroot/rendering` | Stable mapped preview and pluggable Pandoc engine contract |
| `@markroot/citations` | BibTeX indexing and future resolver boundary |
| `@markroot/git` | Local isomorphic-git operations over the selected folder |
| `@markroot/review` | Word/character changes and accept/reject review drafts |
| `@markroot/comments` | Embedded anchors, thread metadata, replies, and recovery |
| `@markroot/export` | Pandoc HTML/DOCX and Pandoc-to-Typst PDF export |
| `@markroot/settings` | IndexedDB preferences, identities, and recent folder handles |
| `@markroot/web` | React composition root and user interface |

The selected folder is the only repository source of truth. Folder handles, preferences, author profiles, and transient recovery drafts are stored in IndexedDB. A dirty document is checkpointed after edits and offered for recovery when that same workspace path is reopened; the checkpoint is deleted after a successful save or explicit discard. No repository mirror is maintained. Guarded document writes and browser Git mutations use one Web Lock per selected folder; native Git is still outside that lock, so every browser Git mutation performs a last-moment repository fingerprint check.

## Document model

`DocumentSession` owns one source string and revision. Source and visual editors submit revision-guarded range edits. Untouched source is retained byte-for-byte. The visual pane edits recognized prose blocks and treats raw or unsupported blocks as atomic source-backed nodes.

QMD code fences are displayed but never executed. The compatibility layer recognizes Pandoc Markdown, YAML front matter, citations, math, figures, fenced callouts, and common cross-reference labels. Full Quarto CLI execution is intentionally out of scope.

### Compatibility profile

| Construct | Render | Source edit | Visual edit | Round trip |
| --- | --- | --- | --- | --- |
| Prose, headings, lists, quotes, links | yes | yes | yes | lossless outside edited block |
| Code fences and QMD cells | inert | yes | source-backed atomic block | lossless |
| YAML front matter and raw blocks | source-backed | yes | atomic block | lossless |
| Tables, fenced divs, callouts | yes | yes | source-backed block | lossless |
| Math, citations, figures, crossrefs | semantic live view and full export engine | yes | source-backed prose/block | lossless |
| Quarto execution engines | warning only | yes | inert | lossless |

The live view intentionally uses the deterministic mapped renderer while the full Pandoc mapping spike remains a release gate. `PandocDocumentEngine` is available behind the rendering interface, and exports always use Pandoc WASM.

### Viewer and paired navigation

The rendered view uses local KaTeX conversion to semantic MathML for inline and numbered display equations. Sections are numbered hierarchically by default; `number-sections: false` in YAML disables numbering for the document, while a heading such as `# Abstract {.unnumbered}` opts out individually without advancing the counter. Ordinary Markdown HTML comments (`<!-- … -->`) remain editable in source but are hidden from rendered and visual prose; identical syntax inside inline or fenced code remains visible as literal code. The length-preserving masking keeps navigation offsets stable. Pipe tables, captioned Markdown images, and figure panels receive stable table/figure numbering and navigation targets.

Document-relative image paths (including safe `..` segments and URL-encoded filenames) resolve inside the selected folder, and local image bytes are exposed only through typed, revocable blob URLs. Exact Markroot-created blob URLs are temporarily replaced by inert markers during HTML sanitization and restored only onto image elements afterward, so the sanitizer cannot remove valid figures and document-authored blob URLs are not broadly trusted. PDF image references are rendered locally through the bundled PDF.js worker: page one is converted to a bounded high-resolution PNG and then follows the same caption, numbering, sizing, alignment, and navigation path as PNG or SVG figures. The preview is cached by the PDF file version and invalidated after an external change. Figure attributes support `width`, `height`, `fig-align`, `fig-alt`, and top/bottom `fig-cap-location`. Missing, encrypted, or unreadable images become a non-fetching diagnostic placeholder instead of a broken image or an accidental request to the app origin. Local BibTeX records format citations and an on-page references list; year extraction supports braced, quoted, and bare `year` fields plus date-style fields. An empty fenced div written as `::: {#refs}` followed by `:::` is treated as the bibliography insertion point: generated entries replace that block after all citations have been collected, with no extra References heading or end-of-document duplicate. Documents without this placeholder retain the automatic References section at the end. A normal citation click navigates to its bibliography entry. When the BibTeX record has a valid DOI, Ctrl-click or Cmd-click on that citation opens the canonical `https://doi.org/…` address in a new tab; DOI targets are validated before opening without appending a separate icon to citation text. Internal heading, figure, table, equation, and bibliography links scroll within the rendered document and synchronize the source pane. Common `layout-ncol` figure panels and callouts have dedicated presentation.

The source and right panes share one active block. Moving the source cursor or clicking rendered/visual content highlights that block in both panes. Rendered citations, equations, and figures carry exact source offsets; ordinary prose uses the clicked word and surrounding position to select the nearest source character. Direct clicks leave a paired pane still when the target is already visible and center it only when revealing is necessary.

The source editor applies a dedicated high-contrast color to Markdown link and image destinations. In dark mode, local paths and URLs use a light cyan underline instead of CodeMirror's low-contrast default blue.

Source and viewer font family and size are independent browser preferences. The viewer can additionally justify prose and apply browser hyphenation; the quick justification toggle is also available in the viewer header.

The viewer header can detach the complete visual/rendered surface into a separate browser window for use on another monitor. The detached surface remains part of the same live React document session: mode changes, edits, rendered updates, search marks, active-block highlighting, navigation, center-line scroll synchronization, theme, font, and justification settings continue to update without copying document content or opening a second workspace. While detached, the source pane uses the available main-window width and offers controls to focus the second window or reattach it. Closing the second window also reattaches the viewer state. The detach action must originate from its button so Chromium can apply the normal pop-up permission policy; if blocked, Markroot reports how to retry.

Scroll synchronization is interaction-owned. Wheel, touch, scrollbar, and scrolling-key input in one pane makes that pane the reference; the semantic point under its exact vertical midpoint is placed at the paired pane's midpoint on every animation frame. Alignment clamps naturally near either document boundary. The paired pane's automatic movement never takes ownership in return, and a one-pixel tolerance avoids needless writes when both centers are already aligned.

### Workspace tree and portable paths

The workspace sidebar mirrors the selected folder as an expandable tree while omitting implementation-heavy directories such as `.git`, `node_modules`, `.quarto`, and `_freeze`. Folders start collapsed. Markdown and QMD documents use bold accent text, folders containing either format retain normal emphasis, and unrelated files or branches are muted so writing documents remain easy to scan. Text documents open in the source editor; binary assets remain visible so their paths can be copied. When a copied workspace path is pasted into a document, the source editor rewrites it to the shortest path relative to that document. Paths containing spaces are wrapped in angle brackets when pasted inside a Markdown link or image destination.

The outline button in the workspace header opens a panel over the file tree, preserving horizontal writing space while offering direct document navigation. Selecting an entry keeps the outline open and marks the active block. The default view includes heading levels one and two plus tables; deeper headings and figures can be shown with persistent browser-local controls. Numbering occupies a content-sized column so long hierarchical values push labels instead of overlapping them. The right edge of the tree and the divider between source and viewer are draggable and keyboard-adjustable; their positions are stored with the other browser-local preferences.

## Comments

Prose comments use HTML boundary markers. A selection in either the source editor or rendered document maps to the same source range and can be sent to the Comments panel. Rendered selections account for Markdown formatting before anchors are inserted and take precedence over click-to-source navigation, so focus does not clear a completed selection. The rendered document places compact thread cards in a non-reflowing lane to the right of their anchored text. The lane redistributes the existing page margins instead of changing the document measure, so paragraph wrapping remains identical when comments appear. Hovering or activating a card highlights its mapped range; selecting a card opens the complete thread in the Comments panel. Thread data is stored in a terminal `markroot:threads:v1` HTML comment. Rendering and export remove both forms. Comments in code, YAML, or raw blocks use block-level ranges to avoid changing executable or literal content.

## Security and privacy

- Directory access requires an explicit browser gesture and permission.
- Preview HTML is sanitized and inserted into an isolated Shadow DOM.
- External images are not loaded unless the user enables them for the session.
- A restrictive CSP blocks object/frame/form content and arbitrary script connections.
- QMD code is never executed.
- Optional AI commit suggestions send only the candidate Git diff to Chrome's on-device language model. Repository contents are not sent to a Markroot service or cloud-model fallback.
- There is no analytics, authentication, upload, remote Git, or backend API.

## Git limitations

Version 0.1 targets standard non-bare SHA-1 repositories whose root contains a `.git/` directory. Linked worktrees, SHA-256 repositories, submodule mutation, and symlink checkout are rejected. Save open documents before staging, branch rename, checkout, or merge. Branch create/rename/delete and clean merges are supported; conflict resolution and recursive merge-base edge cases remain a release gate.

The File System Access adapter probes both file and directory handles when determining an entry type. Chromium's expected `TypeMismatchError` from probing `.git` as a file is treated as a signal to probe it as a directory, while genuine permission and I/O errors remain visible in the Git panel.

The Git package initializes the standard browser `Buffer` implementation before evaluating isomorphic-git. This satisfies isomorphic-git's index and packed-object readers without Node.js, a backend, or a repository copy.

### AI-assisted explicit-save commits

The browser-local setting `aiCommitSuggestions` is disabled by default. Selecting it immediately calls `LanguageModel.create()` from the checkbox's user activation so Chrome starts downloading Gemini Nano when necessary. Settings shows checking, indeterminate download startup, measured progress, ready, and unavailable states. Only an API availability result or session-creation rejection produces the red error state; elapsed time without a progress event does not abort Chrome's download. Chrome owns this component download outside the page's normal request pipeline, so `chrome://on-device-internals`—rather than the tab's DevTools Network panel—is the diagnostic source of truth.

When enabled, Ctrl/Cmd+S and the toolbar Save action first write the open document and then prepare a commit candidate. Background autosave never starts AI. A candidate contains the current saved version of the open file plus every change that was already staged; unrelated unstaged files are excluded. If the open file has no change relative to `HEAD`, no proposal is shown.

Markroot uses Chrome's `LanguageModel` Prompt API with English structured output to produce an editable Conventional Commit subject and optional body. The dialog reports first-use model-download and generation progress and supports cancellation and regeneration. Oversized diffs are divided by file and hunk, summarized locally in context-sized batches, and hierarchically reduced with bounded work. Model or output failure leaves the successful file save intact, creates no commit, and opens the manual Git panel.

Accepting a proposal rechecks the repository fingerprint and open-file content under the workspace Web Lock, stages the open file, verifies that the resulting staged diff is exactly the candidate summarized by the model, and then commits it. The previous index bytes are restored if validation or staging fails before the commit. Native Git processes do not participate in the browser Web Lock, so the existing last-moment fingerprint limitation still applies.

## Export

HTML and DOCX use the self-hosted Pandoc WASM engine. PDF uses Pandoc-to-Typst followed by the pinned self-hosted Typst compiler WASM and bundled Source Serif 4 TrueType bytes. The font is registered before compiler initialization; Typst webfont containers are not used because the compiler does not recognize them as document fonts. Export runs in a cancellable worker that restarts after a crash. Online Typst package fetching is not used. Local images, bibliographies, and CSL files referenced by the document are passed explicitly to the worker. Because Pandoc WASM exposes a flat temporary filesystem, Markroot assigns collision-free temporary filenames and rewrites only the in-memory export source; nested workspace paths and the saved source remain untouched. PDF figures are rasterized for HTML/DOCX and remain native PDF assets for Typst. Empty Pandoc results are rejected with stderr details rather than downloaded as blank documents. Results may be downloaded, saved through the native Save As picker, or written beside the source.

Export customization follows document YAML when a local file is explicitly selected: `format.docx.reference-doc` for Word styles, `format.html.template` and `format.html.css` for HTML, and `format.typst.template` for the Typst-backed PDF. Explicit template styling is authoritative. Without it, the viewer's paragraph-justification preference is applied to the export: a bundled justified Word reference is selected for DOCX, a scoped paragraph rule is inserted for HTML, and a Typst paragraph rule is inserted for PDF. `format.typst.template-partials` files are collected in preparation for fuller Quarto-compatible composition, but partial replacement remains planned because Markroot runs Pandoc and Typst directly rather than the Quarto CLI. LaTeX `format.pdf.template` files are intentionally not treated as Typst templates.

## Testing

`pnpm check` runs strict type checking, unit tests, and the production build. The fixture suite includes a QMD compatibility corpus. While the Vite development server is running, `/export-smoke.html` performs a browser-level HTML/DOCX/PDF worker check and reports non-empty output sizes. Real-folder and native-Git interoperability must additionally be tested manually in Chromium on a disposable repository before release. AI commit testing requires a current desktop Chrome profile with the Prompt API and Gemini Nano available; test model download, cancellation, regeneration, edited acceptance, unavailable fallback, and stale-candidate rejection.

## Release gates still open

- Repeat the direct `.git` corruption/interruption matrix against native Git on Windows, macOS, and Linux.
- Prove semantic Pandoc source mapping for the complete golden fixture corpus before switching the live renderer from the mapped fallback.
- Extend click-to-source character mapping beyond exact scholarly anchors and word-level prose matching for syntax whose rendered text has no source-text equivalent.
- Expand the visual schema so every declared Pandoc/Quarto construct is structurally editable rather than source-backed.
- Add in-memory three-way conflict resolution and exact per-segment authorship for ambiguous/moved/merged history.
- Run DOCX archive validation and offline PDF text, font, metadata, and pixel-fidelity tests on every supported platform.
- Complete accessibility, storage-pressure, large-packfile, and multi-tab endurance testing.
- Exercise detached-viewer lifecycle, cross-window input, and multi-monitor placement on every supported desktop platform.
