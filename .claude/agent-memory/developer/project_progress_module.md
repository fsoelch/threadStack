---
name: project-progress-module
description: Structure/conventions of the shared Zwischenstand ("progress") mechanism in lib/progress/ (ThreadStack) and how ref_type is extended
metadata:
  type: project
---

ThreadStack has ONE generic "Zwischenstand"/Fortschrittsverlauf mechanism in
`lib/progress/` (schema.js, queries.js, routes.js, sanitize.js, index.js) used by
multiple domain object types via a generic `ref_type` discriminator column on
`progress_entries` (and `progress_meta`, which only supports a subset of ref_types).
Originally `ref_type IN ('todo','topic')`; extended to add `'contact'` in
Arbeitspaket B2 (Ansprechpartner-Notizen) — CLAUDE.md's "Wiederverwendung vor
Neuentwicklung" principle means new domain objects that need a note/history
feature should extend this ref_type allowlist rather than build a parallel system.

**Why relevant:** SQLite has no `ALTER TABLE ... DROP/MODIFY CONSTRAINT`, so
extending a `CHECK (ref_type IN (...))` requires a full table-rebuild migration
(new table with wider CHECK, `INSERT...SELECT`, `DROP`, `RENAME`, recreate all
indexes) wrapped in one transaction. The established idempotency criterion for
such migrations in this codebase: check whether `sqlite_master.sql` text for the
table already contains the new literal (e.g. `'contact'`) — if yes, no-op.

**How to apply:** Ownership is split: `lib/progress/*` (schema/queries/routes) is
developer-package territory; the actual DB wiring call happens in `server.js`
(owned by a separate/later arbeitspaket, e.g. "B4"). Migration order matters and
must be documented via comments: `runProgressMigrations(db)` → any ref_type-CHECK
extension migration → any trigger setup that references `progress_entries` (a
trigger created before the rebuild would be dropped along with the old table).
`progress_meta` intentionally does NOT get every new ref_type (e.g. contacts have
no "next step" concept) — check the specific contract per ref_type rather than
assuming symmetry across `progress_entries` and `progress_meta`.
