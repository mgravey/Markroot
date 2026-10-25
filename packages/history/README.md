# History

Browser-local undo trees with branches, starred versions, checkpoints and version 1 JSON persistence. Edits use UTF-16 offsets and replay sequentially, including patches composed during pruning.

`UndoTree` caches the current text and tracks a conservative byte estimate per node. Pruning checks the cap without serializing the tree, retains root/forks/current/starred versions, and adds checkpoints when replay reaches `checkpointEvery` or `checkpointBytes`. Protected data can exceed the soft cap; the IndexedDB backend enforces the storage guard.

The document-history hook keeps in-memory undo/redo available after a storage read failure and disables saves for that session. Loaded corrupt or unsupported history can be replaced and saved normally.

Run `pnpm exec vitest run packages/history/src apps/web/src/hooks/useDocumentHistory.test.ts` from the repository root. The regression tests cover capped large documents, exact retained text, replay limits, JSON round-trips, navigation, grouped edits and storage failures. Keep local benchmark artifacts in `.history-perf/`.
