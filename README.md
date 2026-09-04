# Markroot

Markroot is a fully static, browser-only Markdown and non-executable Quarto workspace. It opens a real local folder through the File System Access API and keeps document contents on the device.

## Current implementation (0.1 technical preview)

- Chromium directory opening with direct text and binary file access
- Expandable folder tree with copyable workspace paths and document-relative path insertion on paste
- Modular workspace, document, rendering, citation, Git, review, comment, and export packages
- CodeMirror source editing with line numbers, syntax highlighting, find, regex search, go-to-line, and guarded save
- A source-backed ProseMirror visual editor that edits recognized blocks without rewriting untouched source
- A scholarly rendered view with semantic equations, numbered figures/captions, document-relative local images, Pandoc figure sizing/alignment/caption placement, citations, references, cross-references, callouts, tables, and figure layouts
- Bidirectional block/character navigation, paired active-paragraph highlighting, shared search highlighting, and visibility-aware centered reveal
- Persistent font-family and font-size controls for both panes, plus optional justified viewer text
- Intent-locked pane synchronization that keeps automatic viewer alignment from moving the source editor back
- Embedded, Git-friendly comment threads
- Local Git status/diff, staging, commits, history, branch create/rename/delete, checkout, branch review, and clean-merge preview through isomorphic-git
- Worker-isolated HTML/DOCX export through Pandoc WASM and PDF export through Pandoc-to-Typst plus Typst WASM
- Download, native Save As, and save-beside-source export targets
- Browser-only settings, local author profiles, and IndexedDB crash-recovery drafts
- Light and dark themes

Markroot deliberately does not execute QMD code cells, upload files, provide accounts, or connect to Git remotes.

This is not yet a production release. Native-Git interoperability, the full Pandoc/QMD fixture matrix, conflict review, and PDF fidelity still require the release-gate testing listed in [DOCUMENTATION.md](./DOCUMENTATION.md).

## Development

Requirements: Node.js 22+ and pnpm 11+.

```sh
pnpm install
pnpm dev
pnpm check
```

Open the local HTTPS/localhost URL in a Chromium desktop browser. Firefox and Safari do not currently expose the required directory picker API.

For a browser-level export check during development, open `/export-smoke.html` from the Vite server. It runs HTML, DOCX, and PDF through the same dedicated worker as the application without reading a local folder.

`pnpm build` writes a relocatable static application to `apps/web/dist`. Serve that directory over HTTPS or localhost; opening `index.html` directly does not provide the secure context required by the File System Access API.

See [DOCUMENTATION.md](./DOCUMENTATION.md) for architecture, formats, limitations, and test guidance.

## License

Markroot is distributed under GPL-2.0-or-later so a distribution may include Pandoc WASM. See [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
