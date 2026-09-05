'use strict';
// Datenmodell für die n:m-Beziehung zwischen Kontakten (Ansprechpartnern)
// und Vorhaben (todos/topics). Arbeitspaket B3 der Kontakte-Erweiterung.
//
// Migration ist idempotent (CREATE TABLE/INDEX IF NOT EXISTS) und kann bei
// jedem Serverstart gefahrlos erneut ausgeführt werden.

function runAssignmentMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_assignments (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      ref_type   TEXT NOT NULL CHECK (ref_type IN ('topic','todo')),
      ref_id     TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(contact_id, ref_type, ref_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ca_ref     ON contact_assignments(ref_type, ref_id);
    CREATE INDEX IF NOT EXISTS idx_ca_contact ON contact_assignments(contact_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ca_user    ON contact_assignments(user_id);
  `);
}

// Entfernt ausschließlich Zuordnungen, deren Kontakt oder Vorhaben nicht
// (mehr) existiert. Wird z.B. periodisch oder nach Datenreparaturen
// aufgerufen; löscht nie "gesunde" Zuordnungen.
function purgeAssignmentOrphans(db) {
  const res = db.prepare(`
    DELETE FROM contact_assignments
    WHERE (ref_type='todo'  AND ref_id NOT IN (SELECT id FROM todos))
       OR (ref_type='topic' AND ref_id NOT IN (SELECT id FROM topics))
       OR contact_id NOT IN (SELECT id FROM contacts)
  `).run();
  return { deleted: res.changes };
}

module.exports = { runAssignmentMigrations, purgeAssignmentOrphans };
