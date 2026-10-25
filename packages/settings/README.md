# Settings

Browser settings, recent projects, workspace identities and recovery drafts live
in the `markroot` IndexedDB database. `setSettingsBackend()` replaces persistence
for tests and embedding; swapping it closes and clears the cached connection.

Registry operations stage writes while comparing directory handles outside IDB
transactions. A short readwrite transaction checks the registry scope's version
and commits all writes together, retrying conflicts even without Web Locks.
The registry scope covers `recent-projects`, `recent-workspace` and `workspace-ids`.
Recovery migrations use a separate pending-session scope. Every set and delete
increments its scope's version; draft and settings saves cannot restart registry
operations. Web Locks and local queues additionally serialize matching operations.

One connection is reused across reads and writes. Version changes, unexpected
closes, errors and blocked opens clear the cache; blocked opens close any late
connection. No persisted settings or draft migration is needed for scoped versions.

Run `pnpm exec vitest run packages/settings/src` for focused regressions and
`pnpm check` from the repository root for the complete validation suite.
