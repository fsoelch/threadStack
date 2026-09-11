---
name: threadstack-sqlite-table-rebuild
description: Pruefpunkte fuer CHECK-/Spalten-Migrationen per SQLite-Tabellen-Rebuild (CREATE new + INSERT SELECT + DROP + RENAME) — was ein gruener Test nicht zeigt
metadata:
  type: project
---

Wenn ein Arbeitspaket einen SQLite-Tabellen-Rebuild schreibt (neue Tabelle, `INSERT
SELECT`, `DROP TABLE`, `ALTER ... RENAME TO`, Indizes neu) — im Bestand z.B. der
Rebuild-Fallback in `lib/progress/schema.js` — diese vier Punkte messen statt lesen.

**Why:** `db.transaction()` schuetzt zwar korrekt vor Teilzustaenden (SQLite kann DDL
transaktional, Rollback nach `DROP TABLE` funktioniert nachweislich). Die realen
Schaeden liegen ausserhalb der Transaktion und sind entweder still oder erst beim
Zusammenspiel mit einem parallelen Arbeitspaket sichtbar. `server.js` setzt
`db.pragma('foreign_keys = ON')`, was zwei davon scharf schaltet.

**How to apply:** Probe-Skript im Scratchpad (Muster siehe [[threadstack-testmuster]]),
je Punkt ein Szenario:

1. **Trigger ON der Tabelle werden vom `DROP TABLE` STILL mitgeloescht** — kein
   Fehler, kein Rueckgabewert, Rebuild meldet Erfolg. Nachgemessen: Trigger vorher
   vorhanden, nachher weg, Folge-Inserts feuern ihn nicht mehr. Steht die
   Trigger-Erstellung eines anderen Pakets hinter einem `if (!exists)`-Guard (das
   uebliche Muster in `db/schema.js`), ist der Verlust dauerhaft.
2. **Trigger auf einer ANDEREN Tabelle, der die gerebuildete Tabelle referenziert,
   laesst den Rebuild hart scheitern**: `SqliteError: error in trigger X: no such
   table: main.<tabelle>` beim `RENAME` (SQLite re-parst dabei das gesamte Schema).
   Rollback ist sauber, aber beim Serverstart ist das ein Startup-Crash.
   Gegenmittel waere `PRAGMA legacy_alter_table = ON` um den Rename herum.
3. **Fremdtabellen mit `REFERENCES <tabelle>(id) ON DELETE CASCADE` werden beim
   `DROP TABLE` STILL leergeraeumt** (foreign_keys=ON => impliziter DELETE feuert
   CASCADE). Nachgemessen: Kindzeilen weg, `PRAGMA foreign_key_check` leer, kein
   Fehler. SQLites eigene 12-Schritt-Anleitung verlangt deshalb `foreign_keys=OFF`
   VOR dem Rebuild — und `PRAGMA foreign_keys` ist innerhalb einer Transaktion ein
   No-Op, der Schalter muss also ausserhalb von `db.transaction()` liegen.
4. **`CREATE INDEX IF NOT EXISTS` beim Wiederanlegen ist im Rebuild-Kontext
   gefaehrlicher als beim Erstsetup**: Indexnamen sind schema-global. Belegt eine
   fremde Tabelle den Namen, wird der Index STILL nicht angelegt (nachgemessen:
   `idx_progress_entries_token` fehlt danach ersatzlos, kein Fehler) — und genau
   dieser UNIQUE-Index ist der DB-seitige Backstop der clientToken-Idempotenz.
   Im Rebuild ist ein blankes `CREATE INDEX` (lautes Scheitern) das richtige.

5. **Beim NACHREVIEW eines Rebuild-Fixes die drei Details pruefen, die ein
   plausibel klingender Fix regelmaessig falsch macht** (alle nachgemessen):
   - `db.pragma('foreign_key_check')` OHNE Tabellenargument prueft die GANZE
     Datenbank. Eine vorbestehende Altlast in einer voellig fremden Tabelle laesst
     die Migration werfen, obwohl der Rebuild sie nicht verursacht hat.
     `foreign_key_check(<tabelle>)` ist tabellenscoped und ignoriert sie.
   - Steht der Check NACH `run()`/dem Commit, ist er nicht rollbackfaehig: die
     Migration ist bereits persistiert, der Wurf ist ein Startup-Crash, und beim
     naechsten Start greift das Idempotenz-Kriterium => stiller No-Op, die
     Verletzung wird NIE wieder geprueft. Der Check muss INNERHALB von
     `db.transaction()` liegen (dort funktioniert er und rollt zurueck) — im
     Gegensatz zu `PRAGMA foreign_keys`, das dort No-Op ist.
   - Der `finally`-Block, der `foreign_keys` zuruecksetzt, deckt Punkt 3 korrekt
     ab (auch bei Fehler und bei Ausgangswert OFF) — das ist erfahrungsgemaess
     der Teil, der stimmt; die Aufmerksamkeit gehoert den zwei Punkten darueber.

JSDoc-Behauptungen ueber SQLite-Verhalten nie ungeprueft uebernehmen: die Aussage
"ein Trigger auf einer anderen Tabelle ist vom Rebuild nicht betroffen, da der Name
nach dem RENAME wieder gueltig ist" klingt plausibel und ist nachgemessen FALSCH
(Punkt 2 oben feuert trotzdem). `PRAGMA legacy_alter_table = ON` um den Rebuild
herum ist als Gegenmittel verifiziert: Rebuild laeuft durch, der Fremdtrigger feuert
danach unveraendert weiter.

Idempotenz eines Rebuilds nicht ueber die Testbehauptung, sondern ueber
`SELECT rootpage FROM sqlite_master` vor/nach dem zweiten Aufruf pruefen — bleibt die
rootpage gleich, war es wirklich ein No-Op. Textbasierte Idempotenz-Kriterien
(`tableRow.sql.includes("'contact'")`) funktionieren, weil `RENAME` den
CREATE-TABLE-Text unveraendert uebernimmt (nur der Tabellenname wird gequotet).
