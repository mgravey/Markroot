# Changes

## 0.1.0 - unreleased

- Established the modular pnpm/TypeScript workspace.
- Added direct File System Access and in-memory workspace adapters.
- Added the canonical document session, block mapping, source search, and source-backed visual editing.
- Added safe Markdown preview, citation indexing, embedded comment threads, review drafts, and export contracts.
- Added local isomorphic-git repository operations, including guarded current-branch rename.
- Added the React workspace with dark/light themes, source and visual panes, navigation, search, comments, Git, and export panels.
- Added Web Locks and stale-state guards for direct-folder and Git mutations.
- Isolated sanitized preview HTML in Shadow DOM and consent-gated remote media under a restrictive CSP.
- Added bidirectional block-interpolated scrolling, regex/literal shared find, match stepping, and go-to-line.
- Added Git line-diff viewing, history-based change attribution, stale review rejection, branch deletion, and comment orphan repair.
- Added a cancellable, self-restarting export worker with pinned local Pandoc/Typst WASM, bundled fonts, local dependency collection, and three save destinations.
- Added a browser export smoke harness and fixed offline PDF font registration with bundled Source Serif 4 TrueType bytes.
- Added IndexedDB dirty-document checkpoints with recovery, discard, and save cleanup.
- Added a fixture-backed Markdown/QMD compatibility corpus and an explicit unsupported-browser screen.
- Added semantic MathML equations, numbered figure captions, local figure blob URLs, formatted BibTeX citations, references, cross-reference links, and multi-column figure layouts to the mapped viewer.
- Added independent source/viewer font family and size preferences plus a viewer justification mode.
- Added paired active-paragraph highlighting and click-to-source character placement with visibility-aware, vertically centered reveal.
- Fixed circular pane synchronization that could make the Markdown source jump while scrolling; only user-originated scroll interactions now drive the other pane.
- Replaced the flat document list with an expandable folder tree, added copy-path actions and document-relative path insertion, and fixed nested/local image resolution including `..`, encoded names, spaces, and image MIME types.
- Added Pandoc figure width/height, alignment, alternate text, caption-position handling, runtime image failure placeholders, and collapsible viewer diagnostics for missing local assets.
- Added workspace dependency-boundary and cycle enforcement.
