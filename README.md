<img src="apps/web/public/brand/markroot-mark.svg" alt="Markroot rooted-pilcrow logo" width="88" height="88">

# Markroot

Markroot is a fully static, browser-only Markdown and non-executable Quarto workspace. It opens a real local folder through the File System Access API and keeps document contents on the device.

The visual identity uses a rooted pilcrow, with a Lottie-ready After Effects source and SVG/favicon assets documented in [brand/README.md](./brand/README.md).

## Current implementation (0.1 technical preview)

- Chromium directory opening with direct text and binary file access
- Compact-by-default folder tree that emphasizes Markdown/QMD files, mutes unrelated branches, and supports copyable workspace paths with document-relative insertion on paste
- Modular workspace, document, rendering, citation, Git, review, comment, and export packages
- CodeMirror source editing with line numbers, live Git change markers in the gutter, and one synchronized toolbar toggle for word-level tracked changes with green additions and red struck-through deletions in both the source and rendered views
- A source-backed ProseMirror visual editor that edits recognized blocks without rewriting untouched source
- A scholarly rendered view with numbered sections/tables/figures, `.unnumbered` headings, semantic equations, hidden Markdown HTML comments, placed `#refs` bibliographies, securely restored document-relative local images including first-page PDF figures, citations, cross-references, callouts, and figure layouts
- A persistent overlay document outline with two heading levels by default, optional figures, tables, and direct navigation, plus in-view navigation for internal links and unobtrusive Ctrl/Cmd-click DOI access on citations
- Bidirectional block/character navigation, paired active-paragraph highlighting, shared search highlighting, and interaction-owned center-line alignment
- Persistent font-family and display-size controls that proportionally scale each writing surface without affecting export typography, plus optional justified viewer text
- A live detachable visual/rendered viewer for a second window or monitor, with focus and reattach controls
- Persisted drag handles for resizing the file tree and balancing the source and viewer panes
- Intent-locked pane synchronization that continuously follows whichever pane the user scrolls without feedback loops
- Git-tracked YAML comment sidecars keep Markdown clean: one directory per thread and one file per reply, with branch-local resolution history, revision-aware anchors, and automatic migration of legacy embedded comments on save; selections and comment cards work in both source and rendered views
- Direct-folder local Git status/diff, staging, commits, history, branch create/rename/delete, checkout, inline tracked-change branch review with a bold and directly clickable active revision, stable cross-pane navigation after decisions, automatic next-pending navigation, and immediately rendered per-change or bulk decisions; initial review diffing runs off the UI thread, author attribution fills in asynchronously, and accept/reject updates reuse the existing rendered document
- Opt-in Conventional Commit suggestions from Chrome's on-device Gemini Nano model after explicit saves, with editable review, large-diff reduction, and guarded one-click local commits
- Worker-isolated HTML/DOCX export through Pandoc WASM and PDF export through Pandoc-to-Typst plus Typst WASM, including documents and resources stored in nested folders, header-selected DOCX/HTML/Typst templates, and setting-based paragraph justification when no template styling is supplied
- Download, native Save As, and save-beside-source export targets with visible step-by-step progress and cancellation
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

AI commit suggestions additionally require the Chrome Prompt API, compatible desktop hardware, an unmetered connection, and at least 22 GB free on the volume containing the Chrome profile. The feature is disabled by default. Selecting it in Settings immediately asks Chrome to create a local session, which triggers Gemini Nano's browser-managed download when needed and reports preparation progress inline. Chrome API rejections are shown as red errors; a slow download is never treated as a failure based only on elapsed time. This browser component download may not appear in the page's DevTools Network panel; inspect `chrome://on-device-internals` for authoritative model status. Only the candidate Git diff is processed by the on-device model, and Markroot does not use a cloud fallback.

For a browser-level export check during development, open `/export-smoke.html` from the Vite server. It runs HTML, DOCX, and PDF through the same dedicated worker as the application without reading a local folder.

`pnpm build` writes a relocatable static application to `apps/web/dist`. Serve that directory over HTTPS or localhost; opening `index.html` directly does not provide the secure context required by the File System Access API.

## GitHub Pages deployment

The repository includes a GitHub Actions workflow that checks, builds, and deploys `apps/web/dist` whenever `master` is pushed. The static app and its install manifest are configured to work below the `/markroot/` project path.

For `https://www.mgravey.com/markroot/`, create or use a repository named `markroot` under the same GitHub account that owns the GitHub Pages user site for `www.mgravey.com`. In that repository, open **Settings → Pages** and select **GitHub Actions** as the source. Leave the Markroot repository's **Custom domain** field empty: the custom domain belongs to the user site and GitHub applies it to project sites as `/<repository-name>/`. No extra `CNAME` file or DNS record is required for Markroot.

Push `master`, then follow the **Actions → Deploy Markroot to GitHub Pages** run. The workflow can also be started manually with **Run workflow**. See [DOCUMENTATION.md](./DOCUMENTATION.md#github-pages) for the full checklist and troubleshooting notes.

Commit `.markroot/comments/` alongside your documents to share comments across branches. Replies use separate files so concurrent discussions merge cleanly. AI-assisted document commits include the open document’s sidecars; the Git panel also supports staging them manually. See [comment storage](./DOCUMENTATION.md#comments) for the YAML layout and merge behavior.

See [DOCUMENTATION.md](./DOCUMENTATION.md) for architecture, formats, limitations, and test guidance.

## License

Markroot is distributed under GPL-2.0-or-later so a distribution may include Pandoc WASM. See [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
