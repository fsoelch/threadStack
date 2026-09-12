---
name: paket-backup
description: Architekturentscheidungen fuer das DB-Backup/Restore-Feature (Admin, Web) - Referenz fuer kuenftige Datensicherungs-/Restore-Anforderungen
metadata:
  type: project
---

- In-Process-Restore per `ATTACH DATABASE` + tabellenweisem Copy in EINER
  `db.transaction()` auf der bestehenden `db`-Instanz - kein Connection-Swap,
  kein Prozessneustart. Grund: `db` ist in server.js `const` und wird als
  Closure an ~15 Module durchgereicht; ein Reassign wuerde bereits gemountete
  Router mit der alten Referenz zurücklassen. SQLite-Transaktionsgarantie
  (Wurf = kompletter Rollback, nichts committet) macht Restore VOR dem Commit
  automatisch sicher; nur eine nach dem Commit erkannte FK-Inkonsistenz
  braucht einen expliziten Revert-Pfad ueber ein automatisches
  Vor-Restore-Sicherheits-Backup.
- `PRAGMA foreign_keys` kann NICHT innerhalb einer laufenden Transaktion
  umgeschaltet werden (SQLite-Einschraenkung) - OFF/ON gehoeren AUSSERHALB
  der `db.transaction()`-Closure, der eigentliche `foreign_key_check` danach.
- Backup-Metadaten bewusst im Dateinamen kodiert
  (`backup-<manual|auto|prerestore>-YYYYMMDD-HHmmss.sqlite`), KEINE eigene
  DB-Tabelle fuer die Liste - vermeidet Zirkularitaet (Liste waere sonst
  selbst Teil des restaurierten Zustands). Nur Zeitplan/Retention
  (`backup_settings`, Singleton-Zeile) liegt in der Live-DB.
- `better-sqlite3` (bereits Projekt-Dependency) hat eine eingebaute
  Online-Backup-API `db.backup(destPath, opts)` (async, Promise-basiert,
  WAL-sicher ohne App-Lock) - kein `fs.copyFile` auf die rohe .db-Datei
  verwenden (race-anfaellig unter WAL).
- FTS5-Volltextindex (`search_index`) nach Restore NIE schattentabellen-
  kopieren, sondern per extrahierter `rebuildSearchIndex(db)`-Funktion aus
  den Inhaltstabellen neu aufbauen - dieselbe Funktion, die schon die
  Erst-Migration in db/schema.js nutzt (Wiederverwendung statt Duplikation).
- `express-session` lief bisher ohne expliziten `store:` (impliziter
  MemoryStore-Default) - fuer "alle Sitzungen ungueltig machen" (z.B. nach
  Restore) braucht es einen EXPLIZIT instanziierten `new
  session.MemoryStore()` als `store:`-Option, sonst kein Handle zum
  Aufrufen von `.clear()`.
- Datei-basierte Admin-Feature-Pakete (Backup, analog Momentum) spalten sich
  bewaehrt in: Kernmodul (nur lib/<feature>/**), Server-Wiring (nur
  server.js), Web-Frontend (index.html + app.js + neue public/<feature>.js
  /.css) - vermeidet Ueberlappung an den Hotspot-Dateien.
