# Tester Memory — personly / ThreadStack

## Wiederkehrende Randfaelle, die bei aehnlichen Themes/Todo/Knowledge-Aenderungen zu pruefen sind

- Bei jeder Aenderung an Topic<->Ref-Zuordnungen (theme_links,
  knowledge_topic_links) immer explizit testen: (a) fremde/geloeschte
  Theme-IDs werden verworfen statt Fehler zu werfen (droppedCount), (b)
  Ownership-Pruefung auf der Ziel-Ressource selbst (todo/knowledge), nicht
  nur auf den Theme-IDs, (c) atomarer Ersatz (kein Anhaeufen alter Links
  bei wiederholtem Speichern).
- AI-Features (theme_tagging, digest, cross_meeting, drift) sind per
  Default AUSGESCHALTET und benoetigen zusaetzlich einen konfigurierten
  AI-Provider - "funktioniert nicht automatisch" bei diesen Features ist
  oft kein Bug, sondern fehlende Konfiguration/fehlendes Enablement. Vor
  einer Bug-Einstufung immer pruefen, ob es sich um ein bewusst
  deaktiviertes Feature handelt (siehe ai/settings.js DEFAULT_FEATURES).
- Bei AppState-Netzwerkmethoden, die `try? ... ?? []` nutzen: das
  verschleiert 401/Netzwerkfehler als "leeres Ergebnis" - bei
  Topic-Detail-Screens (Wissen/Todos) besonders relevant, da ein Nutzer
  das nicht von einem tatsaechlich leeren Topic unterscheiden kann.
- iOS "Startrubrik"/"isDefault"-Flags NICHT mit "serverseitig geschuetzt"
  gleichsetzen: bei ThreadStack sind von den 4 Start-Rubriken
  (Zustaendigkeit/Privates/Wichtiges/Sonstiges) NUR "Sonstiges" (Fallback)
  und "Privates" (Datenschutzfilter) tatsaechlich vor Umbenennen/Loeschen
  geschuetzt (label_norm-Check in lib/contacts/routes.js). Ein iOS-Client,
  der pauschal ueber `isDefault == true` das Loeschen sperrt, ist damit
  RESTRIKTIVER als Backend+Web und ein echter Feature-Paritaets-Bug (siehe
  CLAUDE.md "Divergenz ist ein Bug"), kein akzeptables Sicherheitsfeature.
  Immer per direktem API-Aufruf verifizieren, was das Backend WIRKLICH
  erlaubt, bevor man eine clientseitige Sperre als korrekt akzeptiert.
- Node-`--test`-Laeufe gegen server.js haengen oft ueber das Testende
  hinaus (offene `setInterval`-Handles, z.B. Login-Attempt-Cleanup) - der
  Prozess beendet sich nicht von selbst. Beim Redirect in eine Datei ist
  das unproblematisch (per Read pollen, sobald "# tests"/"# pass" auftaucht
  reicht der bisherige Inhalt). Beim Piping durch `| tail -N` dagegen bleibt
  die Ausgabe leer, bis der Prozess wirklich beendet ist (tail wartet auf
  EOF) - fuer eigene Ad-hoc-E2E-Skripte daher IMMER in eine Datei
  umleiten und pollen/killen, nie durch `tail`/`head` pipen.
- `test/helpers.js#loadServer(REPO_ROOT)` liefert `{app, db}` (kein Server-
  Objekt direkt, kein `app.locals.db`) - beim Schreiben eigener Ad-hoc-
  Testskripte gegen server.js immer `const { app, db } = loadServer(...)`
  destrukturieren.
- Server-Vertrag Kontakt-Zustaendigkeiten: `GET/PUT .../assignments/...`
  liefert Objekte mit `contactId` (nicht `id`), Infoblock-Felder heissen
  `bodyHtml`/`excerpt` (nicht `bodyText`). Progress-Eintraege fuer Kontakte
  laufen ueber `POST/GET /api/progress/:refType/:refId/entries` (nicht
  `/api/progress` direkt) - gleicher Envelope wie bei todo/topic.
- Das oben beschriebene Datei-Level-Timeout (offene Handles) betrifft
  laut Stichprobe 2026-09-07 NICHT nur Ad-hoc-Skripte, sondern auch die
  regulaeren `node --test <datei>`-Laeufe selbst: einzelne Testdateien mit
  echtem Server (contacts_web_e2e.test.js, progress_integration.test.js,
  progress_list_embed.test.js, snooze_validation.test.js, todo_themes.test.js)
  zeigen ALLE Subtests gruen, aber der Datei-Wrapper selbst timet aus
  (auch bei 60s). Per `git stash` bestaetigt: bereits OHNE jede Aenderung
  reproduzierbar - kein Bug eines einzelnen Features, sondern ein
  Environment-weites Teardown-Problem. Vorgehen: IMMER auf einzelne
  Subtest-Ergebnisse (ok/not ok, "# pass"/"# fail") schauen, nicht auf den
  Datei-Wrapper-Status; ein "not ok - test/<datei>.test.js" mit
  `failureType: 'testTimeoutFailure'" bei sonst 100% gruenen Subtests ist
  kein Go/No-Go-Blocker.
- `badgeHtml`/`formatRelative`-Tests in progress_web_helpers.test.js
  (z.B. "normaler Zustand: 📈-Icon...") nutzen ein FIXES ISO-Testdatum
  gegen das ECHTE `Date.now()` zur Laufzeit - mit fortschreitendem
  Systemdatum wird die erwartete Regex ("vor \d+ Tagen") irgendwann falsch
  ("vor 3 Wochen" statt "vor 3 Tagen"). Vorbestehend, unabhaengig von
  eigenen Aenderungen (per `git stash` verifizierbar) - nicht als eigenen
  Bug melden, sondern als bekannten Kalibrierungs-Fund im Testbericht
  vermerken.

## Backup/Restore-Feature (2026-09-12) — wiederkehrende Pruefpunkte fuer aehnliche Scheduler-Features
- Stundengenaue "zu Uhrzeit X automatisch"-Scheduler nach dem ai/jobs.js-
  Muster (30s-Catch-up-Tick nach Prozessstart) holen einen verpassten Lauf
  NUR nach, wenn der Prozess INNERHALB DERSELBEN STUNDE neu startet - ein
  Neustart NACH Ablauf der konfigurierten Stunde (aber noch am selben Tag)
  wird NICHT nachgeholt, da `tickOnce` strikt `now.getHours() === settings.
  hour` prueft. Bei einer woertlichen Anforderung "verpasster Lauf desselben
  Tages wird nachgeholt" ist das eine tatsaechliche Luecke gegenueber dem
  Wortlaut - aber ein bewusst wiederverwendetes, bereits im Projekt
  etabliertes Scheduler-Verhalten (identisch zu ai/jobs.js), kein neuer Bug.
  Empirisch verifiziert per manuellem tickOnce()-Aufruf mit einer Uhrzeit
  NACH der konfigurierten Stunde. Als bekannte Einschraenkung im Testbericht
  vermerken, nicht als Go/No-Go-Blocker werten, wenn das Muster bewusst
  aus einem bestehenden Vorbild uebernommen wurde.
- Bei Backup/Restore-artigen Features gezielt den REALISTISCHEN Fehlerfall
  pruefen (z.B. Backup-Zielverzeichnis read-only via `fs.chmodSync(dir,
  0o500)`), nicht nur den Fall "Zielpfad existiert als Datei statt
  Verzeichnis" - letzterer erzeugt ein irreführendes `EEXIST` bereits bei
  `fs.mkdirSync(dir,{recursive:true})` und wuerde SELBST BEREITS
  FUNKTIONIERENDE Endpunkte (z.B. die Liste laden) als "kaputt" erscheinen
  lassen, obwohl das nur an der unrealistischen Testkonstruktion liegt.
- Nebenlaeufigkeits-ACs ("zweiter gleichzeitiger Request wird abgelehnt")
  brauchen einen ECHTEN parallelen Request (`Promise.all([...])` gegen den
  wirklichen Router), nicht nur einen Unit-Test des zugrundeliegenden Locks
  - Race-Bedingungen beim Zusammenspiel von Middleware-Reihenfolge (Rate-
  Limit-Check vs. Lock-Erwerb) fallen sonst nicht auf.

## Einklappbare "Mehr"-Gruppe ToDos-Nav (2026-09-17)
- Alle AC der beiden Stories (Web + iOS/macOS) gepruft: automatisiert
  (8 Node-Tests test/todos_nav_group.test.js, 6 Swift-Tests
  SidebarMoreGroupTests.swift) + manuell ergaenzt (Doppel-Toggle kehrt zu
  eingeklappt zurueck, Streak-Hinweis-Punkt bei momentumStreak). Go.
- Persistenz ueber echten Seiten-Reload ist mit jsdom nicht 1:1 testbar
  (jede neue JSDOM-Instanz hat eigenen localStorage) - nur Lesen/Schreiben
  desselben Storage-Keys innerhalb einer Session wird automatisiert
  geprueft. Kein Bug, inhärente Grenze des Testansatzes bei aehnlichen
  ts.*-localStorage-Flags im Projekt.

## Offline-Modus iOS + Sync-Server (2026-11-16)
- Ad-hoc-Server-E2E: `DATA_DIR=<tmp> PORT=.. BASE_PATH=/ node server.js` druckt das
  Admin-Initialpasswort in den Log (nicht in Berichte uebernehmen); curl mit
  `-b cj -H 'Content-Type: application/json'` in einer Funktion kapseln (unquotierte
  $J-Variablen lieferten leere Antworten). Rate-Limit-Test: 120/10min je Nutzer
  fuer POST /todos + /topics, 429 traegt Retry-After + code rate_limited.
- Offline-Swift-Tests (~890 Testfaelle) laufen ~9 Min im iOS-Volllauf; Zaehler stockt
  zwischendurch, ist kein Hang. Nur SummaryAPITests-Baseline-Fehler trat auf.
- Lokale Snooze-Erinnerung fuer Offline-Todos (NotificationScheduler-Singleton) ist
  nicht unit-getestet - nur Code-Review/manuell pruefbar.
