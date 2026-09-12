'use strict';
// Additive Migration für "Sichtbarer Fortschritt" (Erledigt-Moment,
// Tages-Serie, Wochen-Rückblick-Karte), Arbeitspaket M1.
//
// Modulname bewusst `momentum`, NICHT `progress` - `lib/progress/` ist
// bereits durch den Zwischenstand-Mechanismus (Fortschrittsverlauf/Notizen)
// belegt (siehe .claude/agent-memory/requirements-engineer/domain_momentum.md).
//
// Fasst die BESTEHENDEN Tabellen `todos`/`topics` (aus db/schema.js, außerhalb
// dieser Modul-Eigentümerschaft) nur additiv an: ALTER TABLE ... ADD COLUMN
// nach PRAGMA-table_info-Existenzcheck, keine Datenverlust-Pfade - identisches
// Muster zu `lib/contacts/schema.js` (`contacts.search_text`).
//
// `runMomentumMigrations(db)` wird vom Wiring-Paket (M2) beim Serverstart
// aufgerufen, NACHDEM die Kern-Tabellen (users/todos/topics/meetings) bereits
// existieren.
const crypto = require('crypto');

function genId() {
  return Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function runMomentumMigrations(db) {
  if (!hasColumn(db, 'todos', 'completed_at')) {
    db.exec("ALTER TABLE todos ADD COLUMN completed_at TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, 'topics', 'completed_at')) {
    db.exec("ALTER TABLE topics ADD COLUMN completed_at TEXT NOT NULL DEFAULT ''");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_todos_momentum_completed ON todos(user_id, completed_at);
    CREATE INDEX IF NOT EXISTS idx_todos_momentum_created ON todos(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_topics_momentum_completed ON topics(completed_at);

    CREATE TABLE IF NOT EXISTS momentum_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      completion_toast_enabled INTEGER NOT NULL DEFAULT 1,
      streak_enabled INTEGER NOT NULL DEFAULT 1,
      weekly_review_enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS momentum_pause_days (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pause_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (user_id, pause_date)
    );

    CREATE TABLE IF NOT EXISTS momentum_milestones (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('topic','contact')),
      ref_id TEXT NOT NULL,
      name TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_momentum_milestones_user ON momentum_milestones(user_id, occurred_at DESC);
  `);
}

// Entfernt ausschließlich Pausentage/Meilenstein-Einträge, deren Nutzer nicht
// (mehr) existiert - Defense-in-Depth analog `purgeArchiveOrphans` (die
// Fremdschlüssel mit ON DELETE CASCADE räumen das im Normalfall bereits über
// die Datenbank auf, solange `foreign_keys=ON` aktiv ist).
function purgeMomentumOrphans(db) {
  const a = db.prepare('DELETE FROM momentum_pause_days WHERE user_id NOT IN (SELECT id FROM users)').run();
  const b = db.prepare('DELETE FROM momentum_milestones WHERE user_id NOT IN (SELECT id FROM users)').run();
  const c = db.prepare('DELETE FROM momentum_settings WHERE user_id NOT IN (SELECT id FROM users)').run();
  return { removed: a.changes + b.changes + c.changes };
}

module.exports = { runMomentumMigrations, purgeMomentumOrphans, genId };
