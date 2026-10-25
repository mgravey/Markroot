# Markroot packages

The browser workspace packages keep their existing public APIs. Run `pnpm check`
from the repository root for boundaries, ESLint, TypeScript, Vitest, and production
build validation. Focused regression tests live next to each implementation.

## Persistence and compatibility guarantees

- **workspace:** fallback directory moves traverse raw File System Access handles,
  including names omitted by `listFiles()`. Copy failures leave the source intact;
  overwrite moves stage the complete source before removing the destination.
  `remove()` delegates recursive deletion directly to the raw directory handle.
- **git:** mutations check for an existing index lock, write a unique owner token,
  verify it after writing, and remove it only after confirming ownership. File
  System Access has no exclusive create or atomic compare-and-delete, so a native
  Git race remains between these checks and writes/removals. Browser Web Locks
  serialize cooperating Markroot operations. Adapter writes with incoming modes
  and chmod update synthetic executable bits before checkout builds the index;
  ordinary content writes retain the current mode and unlink forgets it.
- **settings:** workspace identity lookup and registration share a Web Lock when
  available and one IndexedDB readwrite transaction regardless of Web Lock support.
  Pending requests keep that transaction alive while `isSameEntry()` completes.
  The existing `setSettingsBackend()` seam remains supported, with operations
  serialized per custom backend in-process. Recovery loads claim and migrate a
  legacy name-keyed draft only when no id-keyed draft supplied the result; deletion
  removes only the requested key.
- **comments:** immutable event files carry `seq = 1 + max(known seq)` per thread.
  Folding uses sequence, timestamp, and event id. Unsequenced intermediate events
  form an initial timestamp-ordered history; legacy `thread.yaml` remains the
  initial state. Concurrent branches can add equal sequences deterministically,
  and deletion tombstones always win.
- **citations:** LaTeX typography is decoded only for display metadata. DOI, URL,
  and eprint values retain punctuation after trimming and outer-brace removal.
  Optional `url` and `eprint` metadata fields are additive API extensions.
- **rendering:** Unicode primary heading ids retain collision-aware legacy ASCII
  and `mr-section-N` alias spans. Aliases are allocated after primary ids, so they
  cannot rename a primary heading. Both ids resolve internal links and supported
  `@sec-...` cross-references; aliases carry source offsets for preview navigation.
  Cached blocks recalculate fallback positions and aliases for the whole document.
  `Preview.tsx` already resolves spans by DOM id, so no app change is required.

Package-local diagnostic captures may be stored in `.package-regression-debug/`
without entering version control.
