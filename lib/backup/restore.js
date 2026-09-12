'use strict';
// Restore-Logik fuer DB-Backups (Arbeitspaket B1). Laeuft IM LAUFENDEN
// PROZESS auf der bestehenden `db`-Instanz (kein Connection-Swap, kein
// Serverneustart) - `db` wird in server.js als `const` an ueber ein Dutzend
// Module durchgereicht; ein Reassign wuerde bereits gemountete Router mit
// der alten Referenz zuruecklassen (siehe Architektur-Entscheidung).
//
// Sicherheitsgarantie: `validateBackupFile` ruehrt die Live-DB NIE an und
// laeuft IMMER vor jeder Aenderung. Der eigentliche Datenuebertrag laeuft in
// EINER `db.transaction()` - wirft sie, ist automatisch NICHTS committet
// (SQLite-Transaktionsgarantie). Nur eine ERST NACH dem Commit erkannte
// FK-Inkonsistenz (foreign_key_check) braucht einen expliziten Revert-Pfad
// ueber das automatisch VOR dem Restore erstellte Sicherheits-Backup.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createBackup } = require('./store');

const REQUIRED_TABLES = ['users', 'meetings', 'todos', 'topics', 'themes'];

class RestoreValidationError extends Error {
  constructor(reason) {
    super(`Ungültige Backup-Datei: ${reason}`);
    this.code = 'RESTORE_VALIDATION_FAILED';
    this.reason = reason;
  }
}

// Security-Review-Fund (Hoch): frueher meldete der Revert-Pfad unten IMMER
// `reverted:true`, sobald ein Revert-VERSUCH stattfand - auch wenn dieser
// zweite Kopiervorgang selbst fehlschlug (z.B. Sicherheits-Backup-Datei
// waehrend des Laufs entfernt). Damit koennte ein Admin faelschlich glauben,
// die Live-DB sei wieder im urspruenglichen Zustand, obwohl sie tatsaechlich
// im fehlerhaften Zwischenzustand des gescheiterten Restores verharrt.
// `dbState` unterscheidet daher DREI, nicht zwei Faelle:
// - 'unchanged': Haupttransaktion selbst warf (automatischer Rollback durch
//   SQLite) - Live-DB ist unveraendert wie vor dem Restore-Versuch.
// - 'reverted': Haupttransaktion committete etwas Fehlerhaftes
//   (foreign_key_check schlug an), der anschliessende Revert-Versuch auf
//   das automatische Vor-Restore-Backup war TATSAECHLICH erfolgreich.
// - 'needs_manual_recovery': wie oben, aber der Revert-Versuch selbst
//   scheiterte ebenfalls - die Live-DB enthaelt den fehlerhaften
//   Zwischenzustand, KEINE automatische Korrektur moeglich. `reverted`
//   bleibt als abwaertskompatibles boolesches Feld erhalten (nur bei
//   dbState==='reverted' true), `preRestoreBackup` benennt die Datei, aus
//   der ein Mensch mit Serverzugriff manuell wiederherstellen muesste.
class RestoreFailedError extends Error {
  constructor(dbState, preRestoreBackupFilename) {
    const messages = {
      unchanged: 'Wiederherstellung fehlgeschlagen. Es wurde keine Änderung vorgenommen.',
      reverted: 'Wiederherstellung fehlgeschlagen und automatisch zurückgesetzt.',
      needs_manual_recovery: 'Wiederherstellung UND die automatische Rücksicherung sind fehlgeschlagen. Die Datenbank muss manuell aus dem Sicherheits-Backup wiederhergestellt werden.',
    };
    super(messages[dbState] || messages.unchanged);
    this.code = 'RESTORE_FAILED';
    this.dbState = dbState;
    this.reverted = dbState === 'reverted';
    this.preRestoreBackup = preRestoreBackupFilename || null;
  }
}

// Prueft Integritaet + Kompatibilitaet einer Backup-Datei, OHNE die Live-DB
// anzuruehren. Oeffnet die Datei standalone read-only und schliesst sie
// wieder - kein ATTACH, kein Zugriff auf `db`.
//
// SQLite oeffnet Dateien lazy: eine Datei, die gar keine SQLite-Datenbank
// ist, wirft NICHT beim `new Database(...)`-Konstruktor, sondern erst bei
// der ersten tatsaechlichen Abfrage (hier `PRAGMA integrity_check`) einen
// rohen `SqliteError` ("file is not a database") - deshalb umschliesst EIN
// try/catch den gesamten Pruefblock, nicht nur die Konstruktion.
function validateBackupFile(filePath) {
  if (!fs.existsSync(filePath)) throw new RestoreValidationError('Datei nicht gefunden.');
  let testDb;
  try {
    testDb = new Database(filePath, { readonly: true });
  } catch (_) {
    throw new RestoreValidationError('Datei ist keine gültige SQLite-Datenbank.');
  }
  try {
    let integrity;
    try {
      integrity = testDb.pragma('integrity_check');
    } catch (_) {
      throw new RestoreValidationError('Datei ist keine gültige SQLite-Datenbank.');
    }
    const ok = Array.isArray(integrity) && integrity.length === 1 && integrity[0].integrity_check === 'ok';
    if (!ok) throw new RestoreValidationError('Integritätsprüfung fehlgeschlagen.');

    const tables = new Set(
      testDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    );
    for (const required of REQUIRED_TABLES) {
      if (!tables.has(required)) throw new RestoreValidationError(`Tabelle "${required}" fehlt.`);
    }
  } finally {
    testDb.close();
  }
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// Kopiert jede Tabelle, die SOWOHL in der angehaengten Quelle ALS AUCH im
// aktuellen Live-Schema existiert, komplett (DELETE + INSERT) von der Quelle
// in `main`. Tabellennamen kommen zwar aus `sqlite_master` der angehaengten
// (potenziell von aussen hochgeladenen) Datei, werden aber NUR verwendet,
// wenn exakt derselbe Name auch in `main.sqlite_master` (dem FESTEN,
// anwendungseigenen Schema) existiert - ein Angreifer kann also nie einen
// eigenen, injizierten Tabellennamen einschleusen. Spaltenlisten werden
// zusaetzlich auf die Schnittmenge mit den LIVE-Schema-Spalten begrenzt
// (nie rohe Quell-Spaltennamen uebernehmen). `quoteIdent` ist zusaetzliche
// Verteidigung in der Tiefe.
function copyAllTables(db) {
  const liveTableNames = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_index%'")
      .all().map((r) => r.name)
  );
  const sourceTables = db.prepare(
    "SELECT name FROM restore_src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_index%'"
  ).all().map((r) => r.name);

  const copy = db.transaction(() => {
    for (const t of sourceTables) {
      if (!liveTableNames.has(t)) continue;
      const liveCols = db.prepare(`PRAGMA table_info(${quoteIdent(t)})`).all().map((c) => c.name);
      const sourceCols = new Set(
        db.prepare(`PRAGMA restore_src.table_info(${quoteIdent(t)})`).all().map((c) => c.name)
      );
      const cols = liveCols.filter((c) => sourceCols.has(c));
      if (!cols.length) continue;
      const colList = cols.map(quoteIdent).join(',');
      const qt = quoteIdent(t);
      db.prepare(`DELETE FROM main.${qt}`).run();
      db.prepare(`INSERT INTO main.${qt}(${colList}) SELECT ${colList} FROM restore_src.${qt}`).run();
    }
  });
  copy();
}

// Fuehrt den eigentlichen Datenuebertrag von `sourcePath` nach `db` (main)
// durch. `PRAGMA foreign_keys` kann laut SQLite NICHT innerhalb einer
// laufenden Transaktion umgeschaltet werden - deshalb liegt OFF/ON bewusst
// AUSSERHALB der `db.transaction()`-Closure.
function applyRestoreTransaction(db, sourcePath) {
  db.pragma('foreign_keys = OFF');
  try {
    db.prepare('ATTACH DATABASE ? AS restore_src').run(sourcePath);
    try {
      copyAllTables(db);
    } finally {
      db.prepare('DETACH DATABASE restore_src').run();
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/**
 * @param {import('better-sqlite3').Database} db laufende Live-DB-Instanz
 * @param {object} opts
 * @param {string} opts.sourcePath absoluter Pfad zur zu ladenden Backup-Datei
 * @param {string} opts.backupsDir Verzeichnis fuer das automatische Vor-Restore-Backup
 * @param {(db: import('better-sqlite3').Database) => void} opts.rebuildSearchIndex
 * @param {() => Date} [opts.now]
 * @returns {Promise<{preRestoreBackup: string, reverted: boolean}>}
 */
async function restoreFromFile(db, { sourcePath, backupsDir, rebuildSearchIndex, now = () => new Date() }) {
  validateBackupFile(sourcePath); // wirft VOR jeder Aenderung an der Live-DB.

  const preRestoreBackup = await createBackup(db, { backupsDir, type: 'prerestore', now });
  const preRestorePath = path.join(backupsDir, preRestoreBackup.filename);

  try {
    applyRestoreTransaction(db, sourcePath);
  } catch (_) {
    // Die Transaktion selbst ist automatisch zurückgerollt (SQLite-Garantie)
    // - nichts wurde committet, die Live-DB ist unverändert wie zuvor.
    throw new RestoreFailedError('unchanged');
  }

  const violations = db.pragma('foreign_key_check');
  if (violations && violations.length) {
    let revertSucceeded = false;
    try {
      applyRestoreTransaction(db, preRestorePath);
      rebuildSearchIndex(db);
      revertSucceeded = true;
    } catch (revertErr) {
      // Der urspruengliche Restore-Fehler wird unten ohnehin gemeldet -
      // dieser Log-Eintrag dokumentiert zusaetzlich, dass auch der
      // Rueckrollversuch selbst fehlschlug (siehe dbState-Erklaerung oben).
      console.error('[backup] Revert nach fehlgeschlagenem Restore ist selbst fehlgeschlagen:', revertErr && revertErr.message);
    }
    throw new RestoreFailedError(revertSucceeded ? 'reverted' : 'needs_manual_recovery', preRestoreBackup.filename);
  }

  rebuildSearchIndex(db);
  return { preRestoreBackup: preRestoreBackup.filename, reverted: false };
}

module.exports = {
  validateBackupFile,
  restoreFromFile,
  RestoreValidationError,
  RestoreFailedError,
};
