---
name: threadstack-review-konventionen
description: ThreadStack-spezifische Konventionen und Stolperfallen, die bei jedem Code-Review von Backend-Arbeitspaketen zu pruefen sind
metadata:
  type: project
---

Beim Review von ThreadStack-Backend-Modulen sind diese Bestandsmuster die Referenz,
gegen die neue Arbeitspakete auf Konsistenz geprueft werden.

**Why:** Das Projekt ist ueber mehrere Arbeitspakete gewachsen und hat an einzelnen
Stellen bereits divergierende Loesungen (zwei Fehler-Envelope-Stile, drei Varianten
desselben SQL-Platzhalter-Helpers). CLAUDE.md verbietet explizit das Bauen einer
zweiten, parallelen Loesung. Ohne aktives Gegenpruefen wandert diese Divergenz mit
jedem Paket weiter.

**How to apply:** Vor der Bewertung eines neuen Moduls jeweils gegen den Bestand
greppen:

- **Fehler-Envelope:** `fail(res, status, code, msg, extra)` in server.js. Der
  Kommentar direkt darueber erklaert `code` als UPPER_SNAKE_CASE fuer verbindlich.
  Die AI-/Link-Endpunkte in server.js weichen mit lowercase-Codes davon ab — beide
  Stile existieren. Neue Module muessen sich fuer *einen* entscheiden und duerfen
  nicht innerhalb desselben Moduls mischen.
- **Helper-Injection statt Nachbau:** Submodule bekommen geteilte Helfer per
  Kontext-Objekt injiziert (`module.exports = function exportRoutes(app, ctx)` mit
  `const { db, requireAuth, fail, apiBase } = ctx`). Baut ein Paket stattdessen eine
  lokale Kopie von `fail`/Rate-Limiter, ist das ein Wiederverwendungs-Fund, auch wenn
  der Envelope zufaellig identisch ist.
- **Polymorphe ref_type/ref_id-Linktabellen** (`theme_links`, `stack_frames`) sind das
  Vorbild fuer neue n:m-Tabellen. Wichtig: die Konvertierung topic<->todo in server.js
  (`/topics/:id/move`, `/todos/:id/move`) legt eine *neue* Zeile mit neuer ID an und
  loescht die alte; bestehende Links werden per `UPDATE ... SET ref_type=?, ref_id=?`
  mitgezogen. Jede neue ref_type/ref_id-Tabelle braucht denselben Migrations-Hook,
  sonst gehen Verknuepfungen bei der Konvertierung still verloren.
- **Rate-Limiting:** In-Memory-Sliding-Window nach dem Muster
  `export/index.js#checkExportRate` bzw. `checkLinkFetchRate` in server.js. Alle
  Varianten bereinigen abgelaufene Keys nie — die Map waechst pro Nutzer unbegrenzt.
  Bei neuen, als wiederverwendbar deklarierten Limitern ist das ein Fund, nicht nur
  eine Uebernahme des Bestandsmusters. **Achtung bei der Nachbesserung:** Agenten
  "beheben" das typischerweise, indem sie das gefilterte Timestamp-Array auch im
  429-Zweig zurueckschreiben und ein `if (filtered.length === 0) map.delete(key)`
  ergaenzen. Beides ist wirkungslos: das Array ist ohnehin durch `max` begrenzt, und
  im 429-Zweig gilt immer `filtered.length >= max >= 1`, der delete-Zweig ist also
  toter Code. Das Leck ist die *Anzahl der Keys*, nicht die Arraylaenge — echte Fixes
  brauchen einen periodischen Sweep oder Loeschen im Erlaubt-Zweig. Immer per
  Probe-Skript `map.size` nach vielen verschiedenen Keys + Fensterablauf messen.
- **`UPDATE OR IGNORE` + anschliessendes `DELETE` als Move-/Migrations-Hook** (Muster
  fuer polymorphe ref_type/ref_id-Tabellen, um UNIQUE-Kollisionen aufzuloesen) hat
  einen stillen Datenverlust-Footgun: ist `from` identisch zu `to`, aktualisiert das
  UPDATE die Zeilen auf sich selbst und das nachfolgende DELETE loescht sie
  vollstaendig — mit `{moved: n}` als Rueckgabe. Bei jeder solchen `move*`-Funktion
  den Identitaetsfall gezielt durchspielen und einen Guard einfordern.
- **Ownership:** `ownsRef(uid, refType, refId)` existiert bereits in server.js und
  deckt topic/todo/contact/theme/knowledge ab — Neuimplementierungen sind unnoetig.
- **PUT = Teil-Update, projektweit.** JEDER PUT in server.js (meetings, todos,
  knowledge, contacts, themes) destrukturiert mit Defaults aus der Bestandszeile:
  `const { title = t.title, ... } = req.body`. Ein neues Modul, das bei PUT
  Vollstaendigkeit verlangt, ist ein stiller Breaking Change der oeffentlichen API
  (Feld weglassen -> 400 oder stilles Leeren). Bei jedem neuen PUT-Endpunkt gegen
  diese Konvention pruefen.
- **Trigger aus db/schema.js duerfen von Modulen per DROP+CREATE ueberschrieben
  werden.** Der gesamte FTS5-/`trg_search_*`-Block in db/schema.js liegt in
  `if (!ftsExists)` und laeuft nach dem Erstsetup NIE wieder — ein Modul-Override
  wird also durch normale Serverstarts nicht zurueckgesetzt. Praezedenzfall im
  Bestand: die `content_text`-Migration ueberschreibt `trg_search_knowledge_*`
  genauso. Solche Overrides sind kein Fund. Die reale Gefahr ist die
  Aufrufreihenfolge beim Wiring: laeuft die Modul-Migration VOR
  `runCoreMigrations`, existiert `search_index` noch nicht, der Override wird
  uebersprungen und db/schema.js legt danach die alte Fassung an — stille
  Degradation. Immer pruefen, ob das Modul dafuer einen nachholbaren
  `ensure*Triggers()`-Pfad anbietet.
- **`ensure*Default*`-Helfer sind "nur wenn gar nichts da"-idempotent** (typisch:
  `if (count > 0) return;`). Jeder Code, der danach eine EINZELNE Default-Zeile per
  Label/Name nachschlaegt und ungeprueft `.id` liest, crasht mit 500, sobald der
  Nutzer diese eine Zeile umbenannt oder geloescht hat. Das ist ein wiederkehrendes
  Muster — bei jeder `ensure*` + `getXByLabel` + `.id`-Kette gezielt den
  Umbenannt-/Geloescht-Pfad durchspielen.

- **Nachbesserungs-Reviews: "defensiver Fallback" wird typischerweise nur an EINER
  von mehreren gleichartigen Stellen ergaenzt.** Wiederkehrendes Muster: die
  HTTP-Route bekommt einen echten Fallback (Ersatzzeile anlegen/verwenden), die
  Migrations-/Batch-Variante desselben Gedankens behaelt eine abweichende Semantik
  (Zeile ueberspringen, Zaehler hochsetzen, Daten liegenlassen) — und die
  Commit-Message behauptet trotzdem Paritaet ("weicht jetzt wie X aus"). Bei jedem
  neuen `getOrCreate*`-/Fallback-Helfer daher: alle Stellen greppen, die dasselbe
  Problem loesen, und die Behauptungen der Commit-Message per Probe-Skript
  nachmessen statt zu glauben. Ursache ist oft, dass der Helfer als Closure IM
  Router-Factory liegt und die Migration ihn technisch gar nicht erreichen kann —
  dann gehoert er in die Query-Schicht.
- **Reindex-/Nachhol-Pfade duplizieren gern die Trigger-Formel.** Ein
  `reindexX()`-Helfer, der `DELETE FROM search_index ...` + `INSERT ... SELECT`
  mit derselben Spaltenformel wie der Trigger schreibt, ist eine zweite Quelle der
  Wahrheit. Eleganter und driftfrei: ein No-Op-`UPDATE tabelle SET spalte = spalte`
  — der AFTER-UPDATE-Trigger reindexiert dann selbst. Ausserdem pruefen, ob der
  Reindex pro Aufruf mehrfach laeuft (Backfill-UPDATE feuert die Trigger bereits).
- **Client-Token-Idempotenz gibt es in zwei Auspraegungen.** `lib/client-idempotency`
  (Mapping-Tabelle `client_create_tokens`, `parseClientToken` lehnt Nicht-Strings ab)
  fuer Todos/Themen; `lib/progress` (Spalte `progress_entries.client_token`, eigenes
  Parsing in routes.js mit `String(raw)`-Koerzierung, Fehlercode klein geschrieben
  `invalid_client_token`) fuer Zwischenstaende. Seit Paket P1 teilen sie nur
  `CLIENT_TOKEN_RE`. Wer eine dritte Stelle mit Client-Token baut oder progress
  anfasst: auf `parseClientToken` vereinheitlichen, nicht eine dritte Variante bauen.
- **Kommentarbloecke in server.js gehoeren zum direkt folgenden Statement.** Neue
  Mounts/Migrationen werden gern zwischen einen bestehenden `// ── X ──`-Block und
  dessen Statement eingeschoben (z.B. `${A}/sync` unter den Archiv-Kommentar). Bei
  jedem server.js-Diff die Einfuegestelle mit Kontext lesen.

Siehe auch [[threadstack-testmuster]] und [[threadstack-sqlite-table-rebuild]].
