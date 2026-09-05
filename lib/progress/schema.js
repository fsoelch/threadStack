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
 * Arbeitspaket B2 (Ansprechpartner-Notizen, ref_type='contact'): zusätzlich
 * werden verwaiste `progress_entries`-Zeilen mit `ref_type='contact'` entfernt,
 * deren Kontakt nicht mehr existiert. `progress_meta` trägt laut Vertrag
 * NIEMALS `ref_type='contact'` (Kontakte haben keinen "nächsten Schritt"),
 * daher gibt es dafür keine zusätzliche DELETE-Klausel. Die Kontakt-Klausel
 * wird nur ausgeführt, wenn die Tabelle `contacts` tatsächlich existiert -
 * das hält bestehende Tests (die eine minimale Test-DB ohne `contacts`
 * aufbauen) unverändert lauffähig, siehe Abschlussbericht.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{entries: number, meta: number}} Anzahl gelöschter Zeilen je Tabelle.
 */
function purgeProgressOrphans(db) {
  const result = { entries: 0, meta: 0 };
  const hasContactsTable = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='contacts'"
  ).get();
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

    if (hasContactsTable) {
      const contactEntriesDel = db.prepare(`
        DELETE FROM progress_entries
        WHERE ref_type='contact' AND ref_id NOT IN (SELECT id FROM contacts)
      `).run();
      result.entries += contactEntriesDel.changes;
    }
  });
  run();
  return result;
}

/**
 * Erweitert den `ref_type`-CHECK von `progress_entries` um `'contact'`
 * (Arbeitspaket B2, Ansprechpartner-Notizen). SQLite kennt kein
 * `ALTER TABLE ... DROP/MODIFY CONSTRAINT`, daher Tabellen-Rebuild in EINER
 * Transaktion: neue Tabelle mit erweitertem CHECK anlegen, Daten kopieren,
 * alte Tabelle droppen, neue umbenennen, alle Indizes neu anlegen.
 *
 * `progress_meta` bleibt bewusst UNVERÄNDERT (weder Schema noch CHECK) - dort
 * landen niemals Kontakt-Einträge, da Kontakte keinen "nächsten Schritt" haben.
 *
 * Idempotent: Kriterium ist, ob der aktuelle CREATE-TABLE-SQL-Text von
 * `progress_entries` bereits `'contact'` enthält - ist das der Fall, ist dies
 * ein No-Op. Setzt voraus, dass `runProgressMigrations(db)` bereits gelaufen
 * ist (Tabelle existiert); falls die Tabelle noch nicht existiert, ist dies
 * ebenfalls ein No-Op (siehe Aufrufreihenfolge im Abschlussbericht).
 *
 * WICHTIG - Trigger-Erhalt (Code-Review-Fund, Hoch #1): `DROP TABLE
 * progress_entries` würde jeden Trigger, der AUF `progress_entries` angelegt
 * ist, STILL (ohne Fehler, ohne Log) mitlöschen. Das ist reihenfolgeabhängig
 * und tritt unabhängig davon auf, ob ein anderes Arbeitspaket (z.B. ein
 * Trigger-Setup, das auf `progress_entries` verweist) VOR oder NACH dieser
 * Migration in Produktion deployt wird. Diese Funktion liest deshalb alle
 * vorhandenen Trigger AUF `progress_entries` vor dem Rebuild aus
 * `sqlite_master` aus und legt sie nach dem RENAME innerhalb DERSELBEN
 * Transaktion wortgleich neu an - das macht sie unabhängig von Triggern AUF
 * `progress_entries` SELBST (nicht vom allgemeineren Fall, siehe naechster
 * Absatz).
 *
 * Ein Trigger AUF EINER ANDEREN Tabelle, dessen Rumpf lediglich
 * `progress_entries` referenziert (z.B. `AFTER INSERT ON todos ... INSERT
 * INTO progress_entries ...`), wird von obiger Trigger-Rekonstruktion nicht
 * erfasst (er steht unter `tbl_name` seiner EIGENEN Tabelle). Ohne
 * `PRAGMA legacy_alter_table=ON` (siehe unten) laesst ein solcher
 * Fremdtrigger den Rebuild empirisch hart mit `SqliteError: no such table:
 * main.progress_entries` scheitern (Code-Review nachgemessen), da SQLite
 * beim RENAME das gesamte Schema neu parst und dabei versucht, den
 * Trigger-Rumpf zu validieren/anzupassen, waehrend `progress_entries`
 * kurzzeitig nicht existiert. Mit `legacy_alter_table=ON` unterbleibt dieser
 * automatische Trigger-Fixup, wodurch auch dieser Fall abgesichert ist
 * (siehe Test). Sollte ein Rebuild dennoch an dieser Stelle scheitern,
 * rollt die Transaktion sauber zurueck - Trigger und Daten bleiben
 * unversehrt, kein Datenverlust, aber ein Startup-Crash bis das Problem
 * behoben ist. Die in `lib/progress/index.js` dokumentierte
 * Reihenfolge-Bedingung ("MUSS vor jeglichem Trigger-Setup laufen, das auf
 * progress_entries verweist") bleibt deshalb weiterhin bindend und dient
 * als zusaetzliche Absicherung, auch wenn `legacy_alter_table=ON` den
 * bekannten Fehlschlagsfall bereits abdeckt.
 *
 * WICHTIG - Fremdschlüssel (Code-Review-Fund, Hoch #2): der Rebuild läuft
 * bewusst mit `PRAGMA foreign_keys=OFF`, da `DROP TABLE` bei aktiven
 * Fremdschlüsseln eine (aktuell nicht existierende, aber potenziell
 * künftige) `ON DELETE CASCADE`-Kindtabelle beim Drop leerräumen würde, ohne
 * dass das auffällt. Sowohl `PRAGMA foreign_keys` als auch `PRAGMA
 * legacy_alter_table` sind innerhalb einer `db.transaction()` ein stiller
 * No-Op, daher liegt das Umschalten BEIDER bewusst AUSSERHALB der
 * Transaktion. Nach dem Rebuild werden beide ursprünglichen Werte
 * wiederhergestellt.
 *
 * WICHTIG - `foreign_key_check` (Code-Review-Fund, Mittel - Nachbesserung):
 * `PRAGMA foreign_key_check(progress_entries)` laeuft INNERHALB derselben
 * Transaktion wie der Rebuild (anders als `PRAGMA foreign_keys` ist das dort
 * KEIN No-Op) und ist bewusst auf `progress_entries` gescopet statt
 * datenbankweit - eine vorbestehende Fremdschluessel-Altlast in einer
 * voellig unverbundenen Tabelle darf die Migration nicht faelschlich
 * scheitern lassen. Weil der Check IN der Transaktion liegt, rollt ein
 * tatsaechlicher Fund die gesamte Migration zurueck (kein bereits
 * committeter Teilzustand, der beim naechsten Start per Idempotenz nie
 * wieder geprueft wuerde).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{migrated: boolean}}
 */
function migrateProgressRefTypeContact(db) {
  const tableRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='progress_entries'"
  ).get();
  if (!tableRow || !tableRow.sql) return { migrated: false }; // Tabelle existiert noch nicht.
  if (tableRow.sql.includes("'contact'")) return { migrated: false }; // bereits migriert.

  // Trigger AUF progress_entries würden von DROP TABLE stillschweigend
  // mitgelöscht - vor dem Rebuild auslesen, nach dem RENAME wortgleich neu
  // anlegen (siehe JSDoc oben, Hoch #1).
  const existingTriggers = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='progress_entries'"
  ).all();

  // PRAGMA foreign_keys UND PRAGMA legacy_alter_table sind innerhalb einer
  // Transaktion jeweils ein stiller No-Op - Umschalten MUSS außerhalb der
  // Transaktion erfolgen (siehe JSDoc oben, Hoch #2 bzw. Nachbesserung).
  const priorForeignKeys = db.pragma('foreign_keys', { simple: true });
  const priorLegacyAlterTable = db.pragma('legacy_alter_table', { simple: true });
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  try {
    const run = db.transaction(() => {
      db.exec(`
        CREATE TABLE progress_entries_new (
          id            TEXT PRIMARY KEY,
          user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          ref_type      TEXT NOT NULL CHECK (ref_type IN ('todo','topic','contact')),
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
        INSERT INTO progress_entries_new
          (id,user_id,ref_type,ref_id,kind,source,body_html,body_text,link_frame_id,client_token,created_at,edited_at)
          SELECT id,user_id,ref_type,ref_id,kind,source,body_html,body_text,link_frame_id,client_token,created_at,edited_at
          FROM progress_entries;
        DROP TABLE progress_entries;
        ALTER TABLE progress_entries_new RENAME TO progress_entries;

        CREATE INDEX idx_progress_entries_ref  ON progress_entries(ref_type, ref_id, created_at DESC);
        CREATE INDEX idx_progress_entries_user ON progress_entries(user_id, created_at DESC);
        CREATE UNIQUE INDEX idx_progress_entries_token
          ON progress_entries(user_id, client_token) WHERE client_token IS NOT NULL;
        CREATE UNIQUE INDEX idx_progress_result_frame
          ON progress_entries(link_frame_id) WHERE kind='result';
      `);
      for (const trigger of existingTriggers) {
        db.exec(trigger.sql);
      }

      // Gescopet auf progress_entries (nicht datenbankweit) und INNERHALB
      // der Transaktion, damit ein tatsaechlicher Fund die gesamte Migration
      // zurueckrollt statt nach dem Commit ungeprueft crashen zu lassen
      // (Code-Review-Fund, Mittel - siehe JSDoc oben).
      const violations = db.pragma('foreign_key_check(progress_entries)');
      if (violations && violations.length) {
        const err = new Error(
          'migrateProgressRefTypeContact: foreign_key_check meldet Inkonsistenzen nach dem progress_entries-Rebuild'
        );
        err.violations = violations;
        throw err;
      }
    });
    run();
  } finally {
    db.pragma(`foreign_keys = ${priorForeignKeys ? 'ON' : 'OFF'}`);
    db.pragma(`legacy_alter_table = ${priorLegacyAlterTable ? 'ON' : 'OFF'}`);
  }

  return { migrated: true };
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

module.exports = {
  runProgressMigrations,
  purgeProgressOrphans,
  dropProgressGoal,
  migrateProgressRefTypeContact,
};
