'use strict';
// Additive Migration (Arbeitspaket P1, Offline-Modus): Mapping-Tabelle fuer
// idempotente Neuanlage von Todos/Themen per Client-Token. Fasst todos/topics
// nicht an. Muss NACH den Kern-Migrationen laufen (FK auf users).
function runClientIdempotencyMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_create_tokens (
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_token TEXT NOT NULL,
      ref_type     TEXT NOT NULL CHECK (ref_type IN ('todo','topic')),
      ref_id       TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      PRIMARY KEY (user_id, client_token)
    );
    CREATE INDEX IF NOT EXISTS idx_client_create_tokens_created
      ON client_create_tokens(created_at);
  `);
}

// Entfernt Mappings, die aelter als maxAgeDays sind. Liefert die Anzahl.
function purgeExpiredClientTokens(db, { now = () => new Date(), maxAgeDays = 365 } = {}) {
  const cutoff = new Date(now().getTime() - maxAgeDays * 86400000).toISOString();
  return db.prepare('DELETE FROM client_create_tokens WHERE created_at < ?').run(cutoff).changes;
}

module.exports = { runClientIdempotencyMigrations, purgeExpiredClientTokens };
