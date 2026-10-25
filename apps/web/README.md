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
