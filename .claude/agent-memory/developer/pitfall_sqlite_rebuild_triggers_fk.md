---
name: pitfall-sqlite-rebuild-triggers-fk
description: SQLite CHECK-constraint table-rebuild migrations (DROP+RENAME pattern) silently drop triggers and can CASCADE-delete FK children unless explicitly guarded
metadata:
  type: project
---

When extending a `CHECK` constraint on a SQLite table via the standard
table-rebuild pattern (`CREATE TABLE x_new`, `INSERT...SELECT`, `DROP TABLE x`,
`ALTER TABLE x_new RENAME TO x`, recreate indexes — used throughout
`lib/*/schema.js` in this project, e.g. `migrateProgressRefTypeContact` in
`lib/progress/schema.js`), two failure modes are easy to miss in code review:

1. **Triggers on the rebuilt table are silently dropped.** `DROP TABLE x`
   removes any `CREATE TRIGGER ... ON x` without error or log. Fix: before the
   rebuild, read `SELECT name, sql FROM sqlite_master WHERE type='trigger' AND
   tbl_name='<table>'`, then re-`db.exec(trigger.sql)` each one AFTER the
   `RENAME`, inside the SAME transaction. This makes the migration
   order-independent regardless of whether another package's trigger-setup
   code runs before or after this migration in production.
2. **`DROP TABLE` under `foreign_keys=ON` can CASCADE-delete child rows** in
   any table with `REFERENCES <table>(...) ON DELETE CASCADE`, even if no such
   child table exists yet at the time the migration is written (latent risk
   for future schema additions). Fix: toggle `PRAGMA foreign_keys` OFF/ON
   around the rebuild, then run `PRAGMA foreign_key_check` afterward (throws
   an Error if it returns any rows).

**Why this matters:** `PRAGMA foreign_keys` is a silent no-op when set inside
a `db.transaction()` in better-sqlite3 — the toggle MUST happen outside the
transaction, wrapping it, while the actual rebuild (`CREATE`/`INSERT`/`DROP`/
`RENAME`/index recreation/trigger recreation) stays inside one transaction.
Use `db.pragma('foreign_keys', { simple: true })` to read the current value
before toggling, so it can be restored to its original state afterward
(don't hardcode ON — respect whatever the caller had set).

**How to apply:** Any time you review or write a SQLite rebuild-style
migration in this project (`lib/*/schema.js`), check for both of these before
approving: (a) does it capture+restore triggers via `tbl_name` on the
rebuilt table, and (b) does it toggle `foreign_keys` OFF around the rebuild
and validate with `foreign_key_check` afterward. Also prefer plain
`CREATE INDEX`/`CREATE UNIQUE INDEX` (no `IF NOT EXISTS`) inside a rebuild
block — right after `DROP TABLE`, none of the table's own indexes can still
exist, so a name collision indicates a real problem (e.g. collision with an
unrelated table's index) that should fail loudly rather than silently
skip index recreation.
