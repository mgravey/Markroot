# Markroot web app

This React/TypeScript app opens local Markdown and Quarto documents in the browser.
Run `pnpm dev` from the repository root to start it, and `pnpm check` before committing.

The app's regression tests use Vitest, React DOM, jsdom and deferred promises to exercise
document loading, saving, preview resources and navigation with delayed I/O:

```sh
pnpm vitest run apps/web/src/hooks/useWorkspaceDocuments.test.ts apps/web/src/hooks/useDocumentSave.test.ts apps/web/src/document-resources.test.ts apps/web/src/App.workspace-links.test.ts
```

- Comment focus-refresh cancellation is independent of explicit document loads. Opening
  another file or reloading after checkout must leave the latest requested document open.
- Saving a clean document verifies disk metadata and content before allowing an AI commit
  candidate. External changes show the existing reload/compare notice and stop preparation.
- Cached image reads outlive individual preview renders. Each render cancels its own wait;
  failed reads are evicted so a later render can retry.
- Workspace links retain their fragments through document loading. Navigation waits for
  that snapshot's preview, decodes fragments like in-document links, and uses Preview's
  DOM anchor lookup, including renderer-provided alias anchors.

Keep optional local reproduction logs and captures in `.review-regression-debug/` (ignored).

Inspector panels, the commit proposal dialog and the visual editor load on demand. Git
loads when connecting a folder; export modules load after an export starts (after the
Save As picker to preserve browser activation). Shared export progress helpers stay
independent of the panel so they cannot pull its UI into the initial bundle.
React, CodeMirror and KaTeX have separate vendor chunks for browser caching; these
are still required by the initial app and are not counted as deferred code.

Keep `base: './'` in Vite: lazy chunks, export workers and `export-smoke.html` must
resolve from both the site root and `/markroot/`. Compare chunk sizes with `pnpm build`;
keep optional bundle reports in `.bundle-analysis/` (ignored).
