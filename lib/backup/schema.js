'use strict';
// Additive Migration fuer "DB-Backup & Wiederherstellung" (Admin, Web-only,
// Arbeitspaket B1). Fasst KEINE bestehenden Tabellen an - legt lediglich die
// Singleton-Zeile fuer den Backup-Zeitplan an (`backup_settings`). Die
// Backups selbst sind Dateien im Dateisystem (siehe store.js), nicht in
// dieser Tabelle gelistet - vermeidet Zirkularitaet bei Restore (die Liste
// waere sonst selbst Teil des restaurierten Zustands).
const SETTINGS_ID = 'singleton';

function runBackupMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS backup_settings (
      id              TEXT PRIMARY KEY,
      enabled         INTEGER NOT NULL DEFAULT 0,
      hour            INTEGER NOT NULL DEFAULT 3,
      retention_count INTEGER NOT NULL DEFAULT 14,
      updated_at      TEXT NOT NULL DEFAULT '',
      updated_by      TEXT REFERENCES users(id)
    );
  `);
  const existing = db.prepare('SELECT id FROM backup_settings WHERE id=?').get(SETTINGS_ID);
  if (!existing) {
    db.prepare(
      'INSERT INTO backup_settings(id, enabled, hour, retention_count, updated_at, updated_by) VALUES (?,0,3,14,\'\',NULL)'
    ).run(SETTINGS_ID);
  }
}

module.exports = { runBackupMigrations, SETTINGS_ID };
