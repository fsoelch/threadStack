'use strict';
// Additive Migration für das Zielbild/Fortschrittsverlauf-Feature (Arbeitspaket S1).
//
// Legt ausschließlich NEUE Tabellen/Indizes an (`progress_entries`,
// `progress_meta`). Fasst `todos`/`topics`/`stack_frames` NICHT an, erzeugt
// keine Trigger und keinen `search_index`(FTS)-Eintrag - siehe Vertrag.
//
// `runProgressMigrations(db)` wird SPÄTER von S2 beim Serverstart aufgerufen,
// NACHDEM die Kern-Tabellen (users/todos/topics) bereits existieren (foreign
// keys referenzieren `users`). Innerhalb von S1 wird diese Funktion nur in
// den eigenen Tests gegen eine minimale Test-DB aufgerufen.

function runProgressMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS progress_entries (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ref_type      TEXT NOT NULL CHECK (ref_type IN ('todo','topic')),
      ref_id        TEXT NOT NULL,
      kind          TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','result')),
      source        TEXT NOT NULL DEFAULT 'manual',
      body_html     TEXT NOT NULL DEFAULT '',
      body_text     TEXT NOT NULL DEFAULT '',
      link_frame_id TEXT,
      client_token  TEXT,
      created_at    TEXT NOT NULL,
      edited_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_progress_entries_ref  ON progress_entries(ref_type, ref_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_progress_entries_user ON progress_entries(user_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_progress_entries_token
      ON progress_entries(user_id, client_token) WHERE client_token IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_progress_result_frame
      ON progress_entries(link_frame_id) WHERE kind='result';

    CREATE TABLE IF NOT EXISTS progress_meta (
      ref_type             TEXT NOT NULL CHECK (ref_type IN ('todo','topic')),
      ref_id               TEXT NOT NULL,
      user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      goal                 TEXT NOT NULL DEFAULT '',
      goal_updated_at      TEXT,
      next_step            TEXT NOT NULL DEFAULT '',
      next_step_updated_at TEXT,
      created_at           TEXT NOT NULL,
      PRIMARY KEY (ref_type, ref_id)
    );
  `);
}

/**
 * Defense-in-Depth: entfernt `progress_entries`/`progress_meta`-Zeilen, deren
 * referenziertes Todo/Topic nicht (mehr) existiert. `todos`/`topics` selbst
 * werden nicht angefasst. Wird SPÄTER von S2 beim Serverstart aufgerufen
 * (nachdem alle Kern-Tabellen existieren).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{entries: number, meta: number}} Anzahl gelöschter Zeilen je Tabelle.
 */
function purgeProgressOrphans(db) {
  const result = { entries: 0, meta: 0 };
  const run = db.transaction(() => {
    const entriesDel = db.prepare(`
      DELETE FROM progress_entries
      WHERE (ref_type='todo'  AND ref_id NOT IN (SELECT id FROM todos))
         OR (ref_type='topic' AND ref_id NOT IN (SELECT id FROM topics))
    `).run();
    result.entries = entriesDel.changes;

    const metaDel = db.prepare(`
      DELETE FROM progress_meta
      WHERE (ref_type='todo'  AND ref_id NOT IN (SELECT id FROM todos))
         OR (ref_type='topic' AND ref_id NOT IN (SELECT id FROM topics))
    `).run();
    result.meta = metaDel.changes;
  });
  run();
  return result;
}

/**
 * Redesign "Übersichtlichere Todos und Tasks" (Arbeitspaket S1, 2026-08):
 * entfernt die Spalten `goal`/`goal_updated_at` aus `progress_meta` endgültig
 * (das Zielbild-Feature entfällt, das Ziel ergibt sich fortan aus der
 * Beschreibung). Idempotent: ein zweiter Aufruf ist ein No-Op. Nutzt
 * `ALTER TABLE ... DROP COLUMN` (SQLite ≥ 3.35, im Projekt vorhanden); falls
 * die installierte SQLite-Version das nicht unterstützt, wird die Tabelle in
 * einer Transaktion neu aufgebaut (Rebuild-Fallback).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{migrated: boolean}}
 */
function dropProgressGoal(db) {
  const cols = db.prepare("PRAGMA table_info(progress_meta)").all().map(c => c.name);
  if (!cols.includes('goal') && !cols.includes('goal_updated_at')) {
    return { migrated: false }; // bereits migriert (No-Op)
  }
  try {
    db.exec('ALTER TABLE progress_meta DROP COLUMN goal');
  } catch (_) {
    // Rebuild-Fallback für ältere SQLite-Versionen ohne DROP COLUMN-Support.
    const run = db.transaction(() => {
      db.exec(`
        CREATE TABLE progress_meta_new (
          ref_type             TEXT NOT NULL CHECK (ref_type IN ('todo','topic')),
          ref_id               TEXT NOT NULL,
          user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          next_step            TEXT NOT NULL DEFAULT '',
          next_step_updated_at TEXT,
          created_at           TEXT NOT NULL,
          PRIMARY KEY (ref_type, ref_id)
        );
        INSERT INTO progress_meta_new (ref_type, ref_id, user_id, next_step, next_step_updated_at, created_at)
          SELECT ref_type, ref_id, user_id, next_step, next_step_updated_at, created_at FROM progress_meta;
        DROP TABLE progress_meta;
        ALTER TABLE progress_meta_new RENAME TO progress_meta;
      `);
    });
    run();
    return { migrated: true };
  }
  try { db.exec('ALTER TABLE progress_meta DROP COLUMN goal_updated_at'); } catch (_) { /* bereits weg oder Rebuild lief bereits */ }
  return { migrated: true };
}

module.exports = { runProgressMigrations, purgeProgressOrphans, dropProgressGoal };
