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

The rendered view uses local KaTeX conversion to semantic MathML for inline and numbered display equations. Sections are numbered hierarchically by default; `number-sections: false` in YAML disables numbering for the document, while a heading such as `# Abstract {.unnumbered}` opts out individually without advancing the counter. Pipe tables, captioned Markdown images, and figure panels receive stable table/figure numbering and navigation targets.

Document-relative image paths (including safe `..` segments and URL-encoded filenames) resolve inside the selected folder, and local image bytes are exposed only through typed, revocable blob URLs. Exact Markroot-created blob URLs are temporarily replaced by inert markers during HTML sanitization and restored only onto image elements afterward, so the sanitizer cannot remove valid figures and document-authored blob URLs are not broadly trusted. Figure attributes support `width`, `height`, `fig-align`, `fig-alt`, and top/bottom `fig-cap-location`. Missing or unreadable images become a non-fetching diagnostic placeholder and a collapsible viewer note instead of a broken image or an accidental request to the app origin. Local BibTeX records format citations and an on-page references list; year extraction supports braced, quoted, and bare `year` fields plus date-style fields. A normal citation click navigates to its bibliography entry. When the BibTeX record has a valid DOI, Ctrl-click or Cmd-click on that citation opens the canonical `https://doi.org/…` address in a new tab; DOI targets are validated before opening without appending a separate icon to citation text. Internal heading, figure, table, equation, and bibliography links scroll within the rendered document and synchronize the source pane. Common `layout-ncol` figure panels and callouts have dedicated presentation.

The source and right panes share one active block. Moving the source cursor or clicking rendered/visual content highlights that block in both panes. Rendered citations, equations, and figures carry exact source offsets; ordinary prose uses the clicked word and surrounding position to select the nearest source character. A paired pane is left still while the target remains comfortably visible. If revealing is necessary, the mapped point is centered vertically.

Source and viewer font family and size are independent browser preferences. The viewer can additionally justify prose and apply browser hyphenation; the quick justification toggle is also available in the viewer header.

Scroll synchronization is interaction-owned. Wheel, touch, scrollbar, and scrolling-key input in one pane drives the paired pane; the paired pane's automatic alignment never takes ownership in return. The destination is left untouched while the mapped point is already visible and is centered only when it falls outside the visible margin.

### Workspace tree and portable paths

The workspace sidebar mirrors the selected folder as an expandable tree while omitting implementation-heavy directories such as `.git`, `node_modules`, `.quarto`, and `_freeze`. Folders start collapsed. Markdown and QMD documents use bold accent text, folders containing either format retain normal emphasis, and unrelated files or branches are muted so writing documents remain easy to scan. Text documents open in the source editor; binary assets remain visible so their paths can be copied. When a copied workspace path is pasted into a document, the source editor rewrites it to the shortest path relative to that document. Paths containing spaces are wrapped in angle brackets when pasted inside a Markdown link or image destination.

The outline button in the workspace header opens a temporary panel over the file tree, preserving horizontal writing space while offering direct navigation to every rendered section, figure, and table. The right edge of the tree and the divider between source and viewer are draggable and keyboard-adjustable; their positions are stored with the other browser-local preferences.

## Comments

Prose comments use HTML boundary markers. Thread data is stored in a terminal `markroot:threads:v1` HTML comment. Rendering and export remove both forms. Comments in code, YAML, or raw blocks use block-level ranges to avoid changing executable or literal content.

## Security and privacy

- Directory access requires an explicit browser gesture and permission.
- Preview HTML is sanitized and inserted into an isolated Shadow DOM.
- External images are not loaded unless the user enables them for the session.
- A restrictive CSP blocks object/frame/form content and arbitrary script connections.
- QMD code is never executed.
- There is no analytics, authentication, upload, remote Git, or backend API.

## Git limitations

Version 0.1 targets standard non-bare SHA-1 repositories whose root contains a `.git/` directory. Linked worktrees, SHA-256 repositories, submodule mutation, and symlink checkout are rejected. Save open documents before staging, branch rename, checkout, or merge. Branch create/rename/delete and clean merges are supported; conflict resolution and recursive merge-base edge cases remain a release gate.

## Export

HTML and DOCX use the self-hosted Pandoc WASM engine. PDF uses Pandoc-to-Typst followed by the pinned self-hosted Typst compiler WASM and bundled Source Serif 4 TrueType bytes. The font is registered before compiler initialization; Typst webfont containers are not used because the compiler does not recognize them as document fonts. Export runs in a cancellable worker that restarts after a crash. Online Typst package fetching is not used. Local images, bibliographies, and CSL files referenced by the document are passed explicitly to the worker. Results may be downloaded, saved through the native Save As picker, or written beside the source.

## Testing

`pnpm check` runs strict type checking, unit tests, and the production build. The fixture suite includes a QMD compatibility corpus. While the Vite development server is running, `/export-smoke.html` performs a browser-level HTML/DOCX/PDF worker check and reports non-empty output sizes. Real-folder and native-Git interoperability must additionally be tested manually in Chromium on a disposable repository before release.

## Release gates still open

- Repeat the direct `.git` corruption/interruption matrix against native Git on Windows, macOS, and Linux.
- Prove semantic Pandoc source mapping for the complete golden fixture corpus before switching the live renderer from the mapped fallback.
- Extend click-to-source character mapping beyond exact scholarly anchors and word-level prose matching for syntax whose rendered text has no source-text equivalent.
- Expand the visual schema so every declared Pandoc/Quarto construct is structurally editable rather than source-backed.
- Add in-memory three-way conflict resolution and exact per-segment authorship for ambiguous/moved/merged history.
- Run DOCX archive validation and offline PDF text, font, metadata, and pixel-fidelity tests on every supported platform.
- Complete accessibility, storage-pressure, large-packfile, and multi-tab endurance testing.
