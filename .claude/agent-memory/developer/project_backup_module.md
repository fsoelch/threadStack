---
name: project-backup-module
description: Implementierungsdetails/Fallstricke des DB-Backup/Restore-Kernmoduls (lib/backup, Arbeitspaket B1) - Referenz fuer Erweiterungen oder aehnliche Restore-Features
metadata:
  type: project
---

- `db.backup(destPath)` (better-sqlite3, bestaetigt vorhanden + async/Promise-
  basiert) statt `fs.copyFile` fuer Backups - WAL-sicher ohne App-Lock.
- SQLite oeffnet Dateien LAZY: `new Database(path, {readonly:true})` wirft
  NICHT bei einer kaputten/Nicht-SQLite-Datei, sondern erst bei der ersten
  echten Abfrage (`PRAGMA integrity_check`) als rohen `SqliteError` ("file is
  not a database"). Validierungscode braucht daher EINEN try/catch um den
  GESAMTEN Pruefblock (Konstruktion + erste Query), nicht nur um `new
  Database(...)` selbst - sonst entkommt der rohe SqliteError der eigenen
  Fehlerklasse.
- `PRAGMA foreign_keys = OFF/ON` ist laut SQLite ein No-Op INNERHALB einer
  laufenden Transaktion (kein Fehler, wirkt aber nicht) - muss AUSSERHALB von
  `db.transaction(fn)()` gesetzt werden, sonst bleibt FK-Erzwingung waehrend
  des Bulk-Copies aktiv und blockiert die Reihenfolge-unabhaengige
  DELETE+INSERT-Strategie.
- Restore-Tabellenkopie (ATTACH + DELETE/INSERT) ist injection-sicher, WEIL
  Tabellennamen aus der (potenziell hochgeladenen) Quelle nur verwendet
  werden, wenn EXAKT derselbe Name auch in der eigenen `main.sqlite_master`
  (fester, anwendungseigener Tabellenname) existiert, UND Spaltenlisten aus
  der Schnittmenge mit den LIVE-Schema-Spalten kommen (nie rohe Fremd-Namen).
  `quoteIdent()` (Anfuehrungszeichen verdoppeln) ist zusaetzliche Tiefen-
  verteidigung, aber die eigentliche Sicherheit kommt aus der Gleichheits-
  pruefung gegen das eigene, feste Schema.
- Express `res.sendFile(absolutePath)` liefert STILLSCHWEIGEND 404 (kein
  Fehler-Log, keine Exception), wenn IRGENDEIN Pfad-Segment - auch eines aus
  `backupsDir`/`DATA_DIR`, nicht nur der Dateiname selbst - mit einem Punkt
  beginnt (`send`-Bibliothek: `dotfiles` default `'ignore'` -> 404 statt
  Fehler). In dieser Sandbox ist `os.tmpdir()` z.B. `.axet-code/tmp`. Bei
  jedem `sendFile()`-Download-Endpunkt, dessen Basisverzeichnis konfigurierbar
  ist (DATA_DIR o.ä.), explizit `{ dotfiles: 'allow' }` setzen, WENN der
  Dateiname bereits anderweitig validiert ist (Allowlist-Regex) - sonst
  bricht der Download in bestimmten Deployment-/Test-Umgebungen unbemerkt.
- Body-Parser-Fehler (z.B. `express.raw()` bei ueberschrittenem `limit`)
  landen NICHT automatisch im eigenen Fehler-Envelope, sondern im generischen
  500er-Handler von server.js (der IMMER 500 zurueckgibt, auch bei
  eigentlich 413). Fuer einen praezisen 413 muss man den body-parser SELBST
  aufrufen (`parser(req,res,(err)=>{...})` statt ihn direkt als Middleware zu
  registrieren) und den Fehler manuell abbilden - siehe
  `lib/backup/routes.js#rawBodyWithLimit`. Ein expliziter Content-Length-
  Vorabcheck VOR dem Parser ist die schnellere erste Verteidigungslinie
  (verhindert unnoetiges Puffern), der Parser-Wrapper fängt den Rest.
