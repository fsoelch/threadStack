'use strict';
// Additive Migration für Rubriken (contact_categories) und Infoblöcke
// (contact_info_blocks) je Ansprechpartner, sowie die additive
// `contacts.search_text`-Spalte (Arbeitspaket B1).
//
// Fasst die BESTEHENDE `contacts`-Tabelle (aus db/schema.js, außerhalb dieser
// Modul-Eigentümerschaft) nur additiv an: ALTER TABLE ... ADD COLUMN nach
// PRAGMA-table_info-Existenzcheck, keine Datenverlust-Pfade.
//
// WICHTIGER HINWEIS ZUR AUSFÜHRUNGSREIHENFOLGE (Vertrag mit B4/B2):
// `progress_entries` (aus lib/progress/schema.js, Arbeitspaket B2) muss NICHT
// zwingend vor `runContactMigrations()` existieren. Existiert die Tabelle zum
// Zeitpunkt des Aufrufs noch nicht (z.B. weil B2s Migration in der
// Aufrufreihenfolge von B4 NACH dieser hier läuft), wird der
// `trg_cnote_*`-Trigger-Block ÜBERSPRUNGEN (kein Crash, keine Exception) -
// `contacts.search_text` enthält in diesem Zwischenzustand dann nur
// Infoblock-Texte, noch keine Kontakt-Notizen. B4 MUSS in diesem Fall
// zusätzlich `ensureContactNoteTriggers(db)` aufrufen, NACHDEM alle
// Migrationen (inkl. B2) gelaufen sind, um das Trigger-Setup nachzuholen und
// `search_text` einmalig um die dann existierenden Kontakt-Notizen zu
// ergänzen. Ein Aufruf von `ensureContactNoteTriggers(db)`, während
// `progress_entries` noch nicht existiert, ist ein sicheres No-Op
// (`{applied:false}`).
const crypto = require('crypto');

function genId() {
  return Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
}

function tableExists(db, name) {
  return !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
}

// Kanonischer Aggregat-Ausdruck für `contacts.search_text`: konkateniert die
// Klartexte aller Infoblöcke eines Kontakts, optional ergänzt um die
// Klartexte aller Kontakt-Notizen (`progress_entries` mit ref_type='contact')
// für denselben Kontakt. `idExpr` ist ein SQL-Ausdruck, der die Kontakt-ID
// liefert (z.B. `new.contact_id` in einem Trigger oder `contacts.id` in einer
// direkten UPDATE-Query) - NIEMALS roher Nutzerinput. Wird von ALLEN
// Triggern/Reindex-Pfaden identisch verwendet, damit es nur eine Quelle der
// Wahrheit für diese Formel gibt.
function searchTextAggregateSql(idExpr, includeNotes) {
  const blocksPart = `COALESCE((SELECT group_concat(b.body_text,' ') FROM contact_info_blocks b WHERE b.contact_id=${idExpr}),'')`;
  if (!includeNotes) return blocksPart;
  const notesPart = `COALESCE((SELECT group_concat(e.body_text,' ') FROM progress_entries e WHERE e.ref_type='contact' AND e.ref_id=${idExpr}),'')`;
  return `${blocksPart} || ' ' || ${notesPart}`;
}

// Trigger auf `contact_info_blocks`, die `contacts.search_text` für den
// betroffenen Kontakt aktuell halten. Immer DROP+CREATE (idempotent), damit
// ein späterer Wechsel von "ohne Notizen" auf "mit Notizen" (siehe
// `ensureContactNoteTriggers`) sauber greift.
function defineInfoBlockTriggers(db, includeNotes) {
  const aggNew = searchTextAggregateSql('new.contact_id', includeNotes);
  const aggOld = searchTextAggregateSql('old.contact_id', includeNotes);
  db.exec(`
    DROP TRIGGER IF EXISTS trg_cib_ai;
    DROP TRIGGER IF EXISTS trg_cib_au;
    DROP TRIGGER IF EXISTS trg_cib_ad;
    CREATE TRIGGER trg_cib_ai AFTER INSERT ON contact_info_blocks BEGIN
      UPDATE contacts SET search_text = (${aggNew}) WHERE id = new.contact_id;
    END;
    CREATE TRIGGER trg_cib_au AFTER UPDATE ON contact_info_blocks BEGIN
      UPDATE contacts SET search_text = (${aggNew}) WHERE id = new.contact_id;
    END;
    CREATE TRIGGER trg_cib_ad AFTER DELETE ON contact_info_blocks BEGIN
      UPDATE contacts SET search_text = (${aggOld}) WHERE id = old.contact_id;
    END;
  `);
}

// Trigger auf `progress_entries` (nur, wenn diese Tabelle existiert - siehe
// Modul-Kommentar oben) - halten `contacts.search_text` bei Kontakt-Notizen
// (ref_type='contact') aktuell.
function defineNoteTriggers(db) {
  const aggNew = searchTextAggregateSql('new.ref_id', true);
  const aggOld = searchTextAggregateSql('old.ref_id', true);
  db.exec(`
    DROP TRIGGER IF EXISTS trg_cnote_ai;
    DROP TRIGGER IF EXISTS trg_cnote_au;
    DROP TRIGGER IF EXISTS trg_cnote_ad;
    CREATE TRIGGER trg_cnote_ai AFTER INSERT ON progress_entries WHEN new.ref_type='contact' BEGIN
      UPDATE contacts SET search_text = (${aggNew}) WHERE id = new.ref_id;
    END;
    CREATE TRIGGER trg_cnote_au AFTER UPDATE ON progress_entries WHEN new.ref_type='contact' OR old.ref_type='contact' BEGIN
      UPDATE contacts SET search_text = (${aggNew}) WHERE new.ref_type='contact' AND id = new.ref_id;
      UPDATE contacts SET search_text = (${aggOld}) WHERE old.ref_type='contact' AND old.ref_id <> new.ref_id AND id = old.ref_id;
    END;
    CREATE TRIGGER trg_cnote_ad AFTER DELETE ON progress_entries WHEN old.ref_type='contact' BEGIN
      UPDATE contacts SET search_text = (${aggOld}) WHERE id = old.ref_id;
    END;
  `);
}

function dropNoteTriggersIfAny(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_cnote_ai;
    DROP TRIGGER IF EXISTS trg_cnote_au;
    DROP TRIGGER IF EXISTS trg_cnote_ad;
  `);
}

// Ersetzt die von db/schema.js beim allerersten FTS5-Setup angelegten
// `trg_search_contacts_ai/au` (die dortige Definition speist den alten
// `description`-Wortlaut in den Suchtext ein) durch eine Fassung, die
// stattdessen `search_text` verwendet (das nach der Beschreibungs-Migration
// die einzige Quelle für Freitext-Inhalte eines Kontakts ist). Nur
// anzuwenden, wenn `search_index` (FTS5) bereits existiert - db/schema.js
// bleibt unverändert (außerhalb dieser Modul-Eigentümerschaft), siehe
// Abschlussbericht/offener Punkt.
function defineSearchContactsTriggers(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_search_contacts_ai;
    DROP TRIGGER IF EXISTS trg_search_contacts_au;
    CREATE TRIGGER trg_search_contacts_ai AFTER INSERT ON contacts BEGIN
      INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('contact', new.id, new.user_id, new.name,
        COALESCE(new.role,'') || ' ' || COALESCE(new.email,'') || ' ' || COALESCE(new.search_text,''));
    END;
    CREATE TRIGGER trg_search_contacts_au AFTER UPDATE ON contacts BEGIN
      DELETE FROM search_index WHERE ref_type='contact' AND ref_id=old.id;
      INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('contact', new.id, new.user_id, new.name,
        COALESCE(new.role,'') || ' ' || COALESCE(new.email,'') || ' ' || COALESCE(new.search_text,''));
    END;
  `);
  // `trg_search_contacts_ad` (reines DELETE FROM search_index, ohne
  // description-Bezug) bleibt unverändert aus db/schema.js gültig.
}

/**
 * Idempotente additive Migration: legt `contact_categories` und
 * `contact_info_blocks` an, ergänzt `contacts.search_text`, und
 * richtet/aktualisiert alle zugehörigen Trigger ein. Mehrfacher Aufruf ist
 * sicher (keine Duplikate, keine Fehler).
 * @param {import('better-sqlite3').Database} db
 */
function runContactMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_categories (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label       TEXT NOT NULL,
      label_norm  TEXT NOT NULL,
      is_default  INTEGER NOT NULL DEFAULT 0,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT '',
      UNIQUE(user_id, label_norm)
    );
    CREATE INDEX IF NOT EXISTS idx_contact_categories_user ON contact_categories(user_id, sort_order, created_at);

    CREATE TABLE IF NOT EXISTS contact_info_blocks (
      id                     TEXT PRIMARY KEY,
      user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_id             TEXT NOT NULL REFERENCES contacts(id)            ON DELETE CASCADE,
      category_id            TEXT NOT NULL REFERENCES contact_categories(id)  ON DELETE RESTRICT,
      body_html              TEXT NOT NULL DEFAULT '',
      body_text              TEXT NOT NULL DEFAULT '',
      sort_order             INTEGER NOT NULL DEFAULT 0,
      is_legacy_description  INTEGER NOT NULL DEFAULT 0,
      created_at             TEXT NOT NULL,
      updated_at             TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cib_contact  ON contact_info_blocks(contact_id, category_id, sort_order, created_at);
    CREATE INDEX IF NOT EXISTS idx_cib_category ON contact_info_blocks(category_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cib_legacy ON contact_info_blocks(contact_id) WHERE is_legacy_description=1;
  `);

  const cols = db.prepare('PRAGMA table_info(contacts)').all();
  const hadSearchText = cols.some((c) => c.name === 'search_text');
  if (!hadSearchText) {
    db.exec("ALTER TABLE contacts ADD COLUMN search_text TEXT NOT NULL DEFAULT ''");
  }

  const includeNotes = tableExists(db, 'progress_entries');
  defineInfoBlockTriggers(db, includeNotes);
  if (includeNotes) {
    defineNoteTriggers(db);
  } else {
    dropNoteTriggersIfAny(db);
  }
  const hasSearchIndex = tableExists(db, 'search_index');
  if (hasSearchIndex) {
    defineSearchContactsTriggers(db);
  }

  // Einmaliger Reindex: nur wenn `search_text` in DIESEM Lauf neu hinzugefügt
  // wurde. Das erneute Schreiben aller Zeilen feuert (falls vorhanden) direkt
  // `trg_search_contacts_au` und hält damit `search_index` konsistent mit der
  // neuen Formel (ohne `description`) - kein separater Reindex-Schritt nötig.
  if (!hadSearchText) {
    const expr = searchTextAggregateSql('contacts.id', includeNotes);
    db.exec(`UPDATE contacts SET search_text = (${expr})`);
  }
}

// Reindexiert `search_index` für ALLE Kontakte anhand der aktuellen
// `trg_search_contacts_au`-Formel (name/role/email/search_text). Nötig, weil
// bereits vorhandene `search_index`-Zeilen ggf. noch mit der ALTEN, von
// db/schema.js beim FTS5-Erststart angelegten Formel (die den alten
// `description`-Wortlaut einspeist) geschrieben wurden, bevor der Override
// (`defineSearchContactsTriggers`) nachgeholt werden konnte.
//
// Schreibt bewusst KEINE eigene, zweite Formel (Code-Review-Fund "Niedrig
// #1": vormals ein eigenständiger DELETE+INSERT-Ausdruck, der die
// `trg_search_contacts_au`-Formel duplizierte). Stattdessen ein No-Op-UPDATE
// je Zeile - das feuert `trg_search_contacts_au` (muss NACH
// `defineSearchContactsTriggers(db)` aufgerufen werden) und schreibt
// `search_index` so mit der EINEN, dort gepflegten Formel neu.
function reindexSearchContacts(db) {
  db.exec(`UPDATE contacts SET search_text = search_text`);
}

/**
 * Holt zwei Dinge idempotent nach, falls sie beim ersten Lauf von
 * `runContactMigrations()` übersprungen wurden:
 * 1. Den `search_index`-Trigger-Override (`defineSearchContactsTriggers`),
 *    falls `search_index` zum Zeitpunkt des ersten Laufs noch nicht
 *    existierte (Code-Review-Fund "Mittel") - inkl. einmaligem Reindex, damit
 *    bereits mit der ALTEN Formel geschriebene `search_index`-Zeilen korrigiert
 *    werden.
 * 2. Das Trigger-Setup für Kontakt-Notizen (`progress_entries` mit
 *    ref_type='contact'), falls `progress_entries` zu dem Zeitpunkt noch
 *    nicht existierte.
 * Sicheres No-Op für Teile, deren Voraussetzung weiterhin fehlt. Idempotent -
 * mehrfacher Aufruf ist unschädlich (führt lediglich wiederholt denselben
 * Rescan/Reindex aus).
 * @param {import('better-sqlite3').Database} db
 * @returns {{applied: boolean}} `applied` bezieht sich weiterhin (Vertrag)
 *   auf die Kontakt-Notizen-Trigger, NICHT auf den search_index-Override.
 */
function ensureContactNoteTriggers(db) {
  if (tableExists(db, 'search_index')) {
    defineSearchContactsTriggers(db);
    reindexSearchContacts(db);
  }
  if (!tableExists(db, 'progress_entries')) {
    return { applied: false };
  }
  defineInfoBlockTriggers(db, true);
  defineNoteTriggers(db);
  // Backfill: alle Kontakte einmalig neu aggregieren, damit bereits
  // vorhandene Kontakt-Notizen rückwirkend in die Suche einfließen (falls
  // `runContactMigrations()` zuvor ohne `progress_entries` gelaufen ist).
  // Dieses UPDATE feuert (falls `search_index` existiert und
  // `defineSearchContactsTriggers` weiter oben bereits gesetzt wurde)
  // bereits selbst `trg_search_contacts_au` und hält damit `search_index`
  // aktuell - ein zusätzlicher expliziter `reindexSearchContacts(db)`-Lauf
  // an dieser Stelle wäre reine Doppelarbeit (Code-Review-Fund "Niedrig #2").
  const expr = searchTextAggregateSql('contacts.id', true);
  db.exec(`UPDATE contacts SET search_text = (${expr})`);
  return { applied: true };
}

/**
 * Defense-in-Depth: entfernt `theme_links`-Zeilen mit ref_type='contact',
 * deren referenzierter Kontakt nicht (mehr) existiert. Rührt weder
 * `contacts` noch `theme_links` selbst (Tabellen-Struktur) an. Sicheres
 * No-Op, falls `theme_links` nicht existiert.
 * @param {import('better-sqlite3').Database} db
 * @returns {{themeLinks: number}}
 */
function purgeContactOrphans(db) {
  if (!tableExists(db, 'theme_links')) return { themeLinks: 0 };
  const result = db.prepare(
    `DELETE FROM theme_links WHERE ref_type='contact' AND ref_id NOT IN (SELECT id FROM contacts)`
  ).run();
  return { themeLinks: result.changes };
}

module.exports = {
  runContactMigrations,
  ensureContactNoteTriggers,
  purgeContactOrphans,
  // Für Tests/Diagnose exportiert (kein Teil des B4-Vertrags, aber nützlich
  // um die Aggregat-Formel isoliert zu prüfen statt sie zu duplizieren).
  searchTextAggregateSql,
  genId,
};
