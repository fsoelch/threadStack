'use strict';
// Additive Migration für das Archiv-Kernmodul (Arbeitspaket B1, "Meetings
// archivieren statt löschen").
//
// Legt ausschließlich die NEUE Tabelle `archive_state` (inkl. Indizes) an.
// Fasst `meetings`/`topics` NICHT an, erzeugt keine Trigger und keinen
// `search_index`(FTS)-Eintrag.
//
// Bewusst KEIN `CHECK (ref_type IN ('meeting'))`: SQLite kann CHECK-
// Constraints nicht per `ALTER TABLE` erweitern - eine spätere Ausweitung auf
// weitere Entitäten (Todos, Wissensseiten) würde sonst einen Tabellen-Rebuild
// erzwingen. Die Allowlist wird stattdessen in der Anwendungsschicht als
// `ARCHIVABLE_REF_TYPES` (siehe queries.js) erzwungen.
//
// `runArchiveMigrations(db)` wird SPÄTER von B2 beim Serverstart aufgerufen,
// NACHDEM die Kern-Tabellen (users/meetings) bereits existieren (Foreign Key
// referenziert `users`).
function runArchiveMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS archive_state (
      ref_type    TEXT NOT NULL,
      ref_id      TEXT NOT NULL,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      archived_at TEXT NOT NULL,
      PRIMARY KEY (ref_type, ref_id)
    );
    CREATE INDEX IF NOT EXISTS idx_archive_state_user
      ON archive_state(user_id, ref_type, archived_at DESC);
    CREATE INDEX IF NOT EXISTS idx_archive_state_ref
      ON archive_state(ref_type, ref_id);
  `);
}

/**
 * Defense-in-Depth: entfernt `archive_state`-Zeilen, deren referenziertes
 * Meeting nicht (mehr) existiert (kein FK auf `meetings`, da `ref_id`
 * typ-generisch ist - siehe Vertrag). `meetings` selbst wird nicht
 * angefasst. Wird SPÄTER von B2 beim Serverstart aufgerufen (nachdem alle
 * Kern-Tabellen existieren), analog `purgeProgressOrphans`.
 *
 * Aktuell wird ausschließlich `ref_type='meeting'` geprüft (einziger Eintrag
 * in ARCHIVABLE_REF_TYPES). Eine spätere Erweiterung der Allowlist um
 * weitere Referenztypen (z.B. 'todo') MUSS diese Funktion um die passende
 * Existenzprüfung ergänzen (analog `purgeProgressOrphans` in
 * lib/progress/schema.js).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{removed: number}} Anzahl gelöschter Zeilen.
 */
function purgeArchiveOrphans(db) {
  const run = db.transaction(() => {
    return db.prepare(`
      DELETE FROM archive_state
      WHERE ref_type='meeting' AND ref_id NOT IN (SELECT id FROM meetings)
    `).run();
  });
  const result = run();
  return { removed: result.changes };
}

module.exports = { runArchiveMigrations, purgeArchiveOrphans };
