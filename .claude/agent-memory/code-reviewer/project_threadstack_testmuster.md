---
name: threadstack-testmuster
description: Wie Tests in ThreadStack gebaut sind und welche zwei Luecken dabei systematisch auftreten
metadata:
  type: project
---

Tests laufen ueber `node --test --test-force-exit test/*.test.js` mit `supertest`
(einzige devDependency) und better-sqlite3 `:memory:`.

**Why:** Weil Arbeitspakete isoliert in Worktrees entstehen, bauen developer-Agenten
regelmaessig einen eigenen Test-Harness mit handgeschriebenem In-Memory-Schema, statt
gegen server.js zu testen. Das ist fuer die Isolation notwendig, erzeugt aber zwei
wiederkehrende blinde Flecken, die ein gruener Testlauf nicht sichtbar macht.

**How to apply:** Bei jedem Arbeitspaket mit eigenem Harness gezielt pruefen:

1. **Harness-Schema gegen das echte Schema in server.js diffen.** Der Harness laesst
   Spalten weg, die es real gibt (z.B. `todos.is_private`, `topics.is_todo`), und
   erfindet Spalten, die es real *nicht* gibt. Jede erfundene Spalte bedeutet, dass
   der zugehoerige Test eine Fiktion verifiziert.
2. **Die in `index.js` exportierte Vertragsflaeche gegen die Tests greppen.** Getestet
   wird typischerweise nur, was ueber HTTP-Routen erreichbar ist. Die direkt
   exportierten Funktionen fuer das *nachfolgende* Arbeitspaket bleiben oft komplett
   ungetestet — und genau dort haengt der naechste Agent dran.

3. **Tests, die eine Schutz-Invariante NUR im Positivfall pruefen, zementieren oft
   genau den Bug.** Wiederkehrendes Muster: ein Test belegt "Schutz greift bei
   Nutzung", ein zweiter belegt "ohne Nutzung ist Loeschen erlaubt" — die
   Folgeoperation, die den geloeschten Fallback dann braucht, wird nie getestet.
   Bei jeder Schutz-/Fallback-Regel die Folgeoperation NACH dem erlaubten
   Grenzfall selbst durchspielen.

3. **Bei jsdom-Frontend-Harnessen (`makeDom` + `window.fetch`-Mock): der Router
   zementiert die URLs.** Matcht der Mock auf `/api/...`, ist ein gruener Lauf kein
   Beleg dafuer, dass die Pfade im Deployment stimmen (siehe BASE_PATH in
   [[threadstack-web-module-konventionen]]). Ebenso antwortet der Mock oft
   unkonditional mit dem gewuenschten Fehlerstatus (z.B. 409) — dann ist getestet,
   dass die UI reagiert, nicht dass der Request die Bedingung ueberhaupt ausloesen
   kann. Immer zusaetzlich den *gesendeten Request-Body* gegen den angenommenen
   Endpunkt-Vertrag pruefen.

5. **`HandlerCallBox` mit nur `wasCalled` ist bei REST-Ressourcen wertlos.** Die
   in `ContactAPITests.swift` eingefuehrte Box (iOS, `KnowledgeMockURLProtocol`,
   siehe [[threadstack-ios-konventionen]]) wird in Folgetests kopiert und dann fuer
   Aussagen wie "kein zusaetzlicher PUT" benutzt. Laden (GET) und Commit (PUT)
   laufen bei diesen APIs aber ueber DENSELBEN Pfad — `wasCalled`/`lastPath` sind
   also schon durch den Ladeversuch erfuellt, ein durchgerutschter PUT bliebe
   unbemerkt. Verlangen: `callCount` und `methods: [String]` (aus
   `req.httpMethod`) und Assertions darauf. Ausserdem wird die Box samt
   `requestBodyJSON` je Testdatei `private` dupliziert, mit der zirkulaeren
   Begruendung "das Original ist private" — beide Dateien gehoeren demselben
   Arbeitspaket, das ist ein CLAUDE.md-Verstoss und die Kopien divergieren bereits.
   Nachbesserung dazu: `ThreadStackTests/TestNetworkHelpers.swift` haelt jetzt
   `makeMockAppState`/`mockJSONData`/`requestBodyJSON`/`HandlerCallBox` EINMAL.
   Die Namen `makeAppState`/`jsonData` sind dort NICHT nutzbar: sie existieren
   file-private in `KnowledgeAPITests`, `ArchiveTests`, `ProgressAPITests`,
   `ProgressComposerTests`, `ProgressIntegrationTests`, `ProgressStoreTests`,
   `SummaryStoreTests` — ein internal Pendant kollidiert modulweit. Die
   Umbenennung ist also berechtigt und kein Ausweichen. `HandlerCallBox` ist
   allerdings `@unchecked Sendable` OHNE Synchronisation; das traegt nur, solange
   die Tests sequenziell je einen Request absetzen.

6. **Aus `View` extrahierte "reine Logik"-Funktionen sind oft Ein-Zeilen-Wrapper
   (`!flag`, `a != nil && !b`), deren Tests tautologisch sind.** Sie belegen den
   Datenverlust-Fix NICHT — der sitzt in der AUFRUFSTELLE im View, die von
   Swift-Testing nicht erreicht wird. Vertretbar als Doku-Anker und weil es der
   Projektkonvention (`TodoSaveTarget`) folgt, aber die Aufrufstelle muss dann
   per Code-Lesen verifiziert werden; ein gruener Testlauf ersetzt das nicht.

Behauptungen aus dem Abschlussbericht (N+1-Freiheit, Alles-oder-nichts, Idempotenz)
lassen sich mit einem kleinen Probe-Skript direkt nachmessen, z.B. `db.prepare`
temporaer wrappen und Statements zaehlen. Das ist schneller und belastbarer als
reines Code-Lesen. Worktrees unter `.claude/worktrees/` haben KEIN eigenes
`node_modules` (Stand 2026-09-06 nachgeprueft — eine frueher hier notierte
gegenteilige Annahme war falsch); `npm test` funktioniert dort nur, weil Node beim
Aufloesen nach oben laeuft. Ein Probe-Skript im Scratchpad braucht daher:
devDependencies (`supertest`) per absolutem Pfad aus
`/Users/Florian.Soelch/ownCloud/Projekte/personly/node_modules`, Pruefling/`test/helpers` per absolutem
Pfad aus dem Worktree. Das ist sauberer, als eine Datei im Worktree anzulegen und
wieder loeschen zu muessen.

**Injizierte Hooks/Module lassen sich nach dem Serverstart per Monkeypatch der
Modul-Exporte pruefen.** server.js loest `progress.deleteForRefs` /
`assignments.contactsForRefs` erst zur AUFRUFZEIT auf der Modul-Instanz auf. Nach
`loadServer()` genuegt also `require('<wt>/lib/progress').deleteForRefs = () => {
throw ... }`, um Fehlerpfade in Hooks und N+1-Gegenproben (echte Implementierung in
eine Schleife pro Ref wickeln) real durchzuspielen — ohne Code im Worktree zu aendern.

Jeder Probe-Fall braucht eine **Gegenprobe**, sonst belegt ein PASS nichts: dass ein
Fix wirkt, zeigt erst der danebengestellte Nachbau des alten Verhaltens, der
fehlschlaegt (z.B. Rebuild mit `foreign_keys=ON` raeumt CASCADE-Kinder nachweislich
leer, mit dem Fix ueberleben sie). Fehlerpfade lassen sich verlaesslich ueber eine
Indexnamen-Kollision erzwingen, wenn der Rebuild `CREATE INDEX` ohne `IF NOT EXISTS`
nutzt — damit sind `finally`-Block und Rollback in einem Durchgang messbar.

**Baseline des Testlaufs (Stand 2026-09, vor jedem Urteil neu gegenpruefen):**
`test/progress_web_helpers.test.js` -> "badgeHtml: Fortschritts-Badge-Markup" schlaegt
DETERMINISTISCH auch auf `main` ohne das Arbeitspaket fehl (kein Flake, vorbestehend):
Ursache ist ein hart kodiertes `lastEntryAt` gegen ein `\d+ Tagen`-Regex, das mit
fortschreitendem Datum zu "vor N Wochen" kippt. Die berichteten "2 fails" sind dabei
IMMER derselbe Test (Elterntest + Subtest werden getrennt gezaehlt) — nicht als zwei
unabhaengige Fehler durchgehen lassen. Die von developer-Agenten berichteten
Gesamtzahlen (pass/fail) stimmen erfahrungsgemaess nicht exakt; selbst nachzaehlen.
`test/progress_integration.test.js`, `test/stack_pop.test.js` und
`test/snooze_validation.test.js` flaken dagegen nur unter Parallellast des
Gesamtlaufs und sind isoliert gruen. Konsequenz: einen einzelnen zusaetzlichen
Fehlschlag NIE aus einem Lauf heraus bewerten — den Gesamtlauf 2-3x wiederholen
und die betroffene Datei isoliert nachfahren; nur was reproduziert, ist ein Fund. Der Gesamtlauf dauert
knapp eine Minute — im Hintergrund starten und mit `until grep -q "^EXIT=" log` warten.

**Die GESAMTZAHL gelaufener Tests schwankt von Lauf zu Lauf** (2026-09-06 gemessen:
1026 / 966 / 1019 bei identischem Stand, 89 Testdateien). Ursache ist
`--test-force-exit` im `npm test`-Skript (unveraendert seit `7e615db`, projektweit,
kein Arbeitspaket-Problem): der Lauf wird abgeschnitten, ganze Dateien bzw. Teile
davon reportet der Runner nie. Ein gruener Lauf belegt also NICHT, dass alle Tests
gelaufen sind. Konsequenz fuer Reviews: nie nur auf pass/fail schauen, sondern per
`grep -o "ok [0-9]* - <Testname>"` gezielt nachweisen, dass die Tests des geprueften
Arbeitspakets in JEDEM Lauf tatsaechlich ausgefuehrt wurden.

Siehe auch [[threadstack-review-konventionen]].
