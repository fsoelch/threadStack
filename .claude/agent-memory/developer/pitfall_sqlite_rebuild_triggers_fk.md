---
name: pitfall-sqlite-rebuild-triggers-fk
description: SQLite CHECK-constraint table-rebuild migrations (DROP+RENAME) silently drop own triggers, can CASCADE-delete FK children, and crash on foreign triggers referencing the table unless legacy_alter_table=ON; foreign_key_check must be table-scoped and inside the transaction
metadata:
  type: project
---

When extending a `CHECK` constraint on a SQLite table via the standard
table-rebuild pattern (`CREATE TABLE x_new`, `INSERT...SELECT`, `DROP TABLE x`,
`ALTER TABLE x_new RENAME TO x`, recreate indexes — used throughout
`lib/*/schema.js` in this project, e.g. `migrateProgressRefTypeContact` in
`lib/progress/schema.js`), two failure modes are easy to miss in code review:

1. **Triggers ON the rebuilt table are silently dropped.** `DROP TABLE x`
   removes any `CREATE TRIGGER ... ON x` without error or log. Fix: before the
   rebuild, read `SELECT name, sql FROM sqlite_master WHERE type='trigger' AND
   tbl_name='<table>'`, then re-`db.exec(trigger.sql)` each one AFTER the
   `RENAME`, inside the SAME transaction. **Correction (verified 2026-09-05):**
   this only makes the migration independent of triggers ON the rebuilt table
   itself — it does NOT cover a trigger on a DIFFERENT table whose body merely
   *references* the rebuilt table (e.g. `AFTER INSERT ON todos ... INSERT INTO
   progress_entries ...`). That case is a distinct failure mode, see point 3.
   Do not claim "order-independent" in JSDoc/comments without qualifying which
   of the two cases is actually covered — a prior version of this file's
   sibling JSDoc made that overclaim and it was flagged in review.
2. **`DROP TABLE` under `foreign_keys=ON` can CASCADE-delete child rows** in
   any table with `REFERENCES <table>(...) ON DELETE CASCADE`, even if no such
   child table exists yet at the time the migration is written (latent risk
   for future schema additions). Fix: toggle `PRAGMA foreign_keys` OFF/ON
   around the rebuild (see "Why this matters" below for placement), then run
   `PRAGMA foreign_key_check(<table>)` — **scoped to the rebuilt table, not
   database-wide**, and **inside the transaction, not after `run()`/commit**.
   Unscoped + post-commit is a bug: (a) a pre-existing FK violation in an
   unrelated table makes the migration fail for no real reason, and (b) once
   committed, a real violation can't be rolled back — the table is already
   migrated, the process crashes, and on next boot the migration's idempotency
   check makes it a no-op, so the violation is only ever reported once and
   never checked again. Unlike `PRAGMA foreign_keys`, `foreign_key_check`
   is NOT a no-op inside a `db.transaction()` — it works fine there.
3. **A trigger on an UNRELATED table whose body references the rebuilt table
   makes `DROP TABLE`/`RENAME` fail hard** with `SqliteError: no such table:
   main.<table>` (empirically verified, not just theoretical) — SQLite
   re-parses/re-validates the whole schema on rename, and the foreign
   trigger's body briefly points at a table that doesn't exist mid-rebuild.
   The transaction rolls back cleanly (no data loss, no orphaned trigger) but
   the process crashes at startup until fixed. Fix (verified working):
   `PRAGMA legacy_alter_table = ON` around the rebuild, toggled the same way
   as `foreign_keys` (see below) — this suppresses SQLite's automatic
   trigger-body fixup during rename and lets the foreign trigger survive
   untouched. This does NOT replace ordering contracts like "this migration
   must run before any trigger-setup that references this table" documented
   elsewhere (e.g. `lib/progress/index.js`) — keep both: the ordering
   contract as primary defense, `legacy_alter_table=ON` as a safety net.

**Why this matters:** `PRAGMA foreign_keys` AND `PRAGMA legacy_alter_table`
are both silent no-ops when set inside a `db.transaction()` in
better-sqlite3 — both toggles MUST happen outside the transaction, wrapping
it, while the actual rebuild (`CREATE`/`INSERT`/`DROP`/`RENAME`/index
recreation/trigger recreation/scoped `foreign_key_check`) stays inside one
transaction. Use `db.pragma('foreign_keys', { simple: true })` /
`db.pragma('legacy_alter_table', { simple: true })` to read the current
value before toggling, so both can be restored to their original state
afterward in a `finally` block (don't hardcode — respect whatever the caller
had set).

**How to apply:** Any time you review or write a SQLite rebuild-style
migration in this project (`lib/*/schema.js`), check for all of these before
approving: (a) does it capture+restore triggers via `tbl_name` on the
rebuilt table, (b) does it toggle `foreign_keys` OFF around the rebuild and
validate with a table-scoped `foreign_key_check(<table>)` INSIDE the
transaction, (c) if a trigger on another table could plausibly reference the
rebuilt table, does it toggle `legacy_alter_table = ON` around the rebuild
too, and (d) does any JSDoc/comment accurately distinguish "trigger ON this
table" (fully handled by re-creation) from "trigger on another table
referencing this table" (needs `legacy_alter_table`, not just re-creation).
Also prefer plain `CREATE INDEX`/`CREATE UNIQUE INDEX` (no `IF NOT EXISTS`)
inside a rebuild block — right after `DROP TABLE`, none of the table's own
indexes can still exist, so a name collision indicates a real problem (e.g.
collision with an unrelated table's index) that should fail loudly rather
than silently skip index recreation.
