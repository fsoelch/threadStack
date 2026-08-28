---
description: Startet das vollstaendige Agenten-Team fuer eine neue Anforderung, von Requirements bis zur Praesentation eines getesteten, sicherheitsgepruefften Ergebnisses.
---

Rohanforderung: $ARGUMENTS

Fuehre folgenden Workflow strikt in dieser Reihenfolge aus. Jeder Schritt bekommt
den vollstaendigen Output der vorherigen Schritte als Kontext, nicht nur die
Rohanforderung.

## Schritt 1: Requirements
Rufe @requirements-engineer auf. Warte auf das vollstaendige Ergebnis, bevor du
fortfaehrst. Wenn der requirements-engineer offene Fragen aufwirft, die eine
wesentliche Design- oder Architekturentscheidung beeinflussen wuerden: unterbrich
den Workflow und stelle die Frage an den Menschen, statt mit einer Annahme
fortzufahren.

## Schritt 2: Architektur und UX (parallel)
Starte @architect und @ux-designer parallel, beide mit dem vollstaendigen
Requirements-Output aus Schritt 1 als Eingabe. Beide laufen unabhaengig, greifen
aber auf dieselben Requirements zu.

## Schritt 3: Konsistenzcheck Architektur/UX
Pruefe kurz, ob Architektur und UX-Entwurf zueinander passen (z.B. UX erfordert
Echtzeit-Feedback, Architektur sieht das nicht vor). Bei Widerspruch: kurze
Klaerung zwischen beiden Ergebnissen einholen, bevor Entwickler starten.

## Schritt 4: Freigabe durch den Menschen
Stelle dem Menschen eine kurze Zusammenfassung der geplanten Aenderungen vor, bevor
irgendetwas umgesetzt wird:

### Requirements (Kurzueberblick)
Die wichtigsten Stories/Akzeptanzkriterien aus Schritt 1, in 3-5 Stichpunkten.

### Architektur (Kurzueberblick)
Die wesentlichen Architektur-Entscheidungen und die geplanten Arbeitspakete aus
Schritt 2.

### UX (Kurzueberblick)
Die wesentlichen UX-Entscheidungen/Flows aus Schritt 2.

### UI-Vorschau
Da zu diesem Zeitpunkt noch kein Code existiert (Entwicklung startet erst in
Schritt 5), erstelle zusaetzlich eine visuelle Mockup-Vorschau der neuen/
veraenderten Screens, damit der Mensch die geplante Optik/Struktur nicht nur
textuell, sondern visuell pruefen kann - das vereinfacht die Validierung
gegenueber reinem Lesen der UX-Beschreibung. Nutze dafuer den
mcp__visualize__show_widget-Mechanismus (mockup-Modul, vorher
mcp__visualize__read_me mit modules: ["mockup"] laden) und setze fuer jeden in
Schritt 2 unter "Screens und Komponenten" beschriebenen neuen/veraenderten
Screen ein Mockup um - Layout, Elemente und die relevantesten Zustaende (z.B.
leer/Fehler bei zentralen Screens). Bestehende, unveraenderte Screens werden
nicht neu gemockt. Falls fuer einen Screen kein sinnvolles Mockup moeglich ist
(z.B. rein serverseitige Logik ohne UI-Aenderung), das explizit so vermerken
statt ein leeres/erfundenes Mockup zu zeigen.

Frage danach explizit, ob die Umsetzung wie vorgestellt starten soll. Warte auf eine
eindeutige Freigabe (z.B. "ja", "passt", "go"), bevor du mit Schritt 5 fortfaehrst.
Bei Aenderungswuenschen: kläre, ob requirements-engineer, architect oder ux-designer
erneut ran muessen, und wiederhole die betroffenen Teile aus Schritt 1-3, bevor du
erneut um Freigabe bittest.

## Schritt 5: Parallele Entwicklung + Code-Review je Arbeitspaket
Fuer jedes Arbeitspaket aus der Architektur: starte einen @developer-Subagent,
jeweils in eigenem Worktree (isolation: worktree ist im developer-Agent bereits
gesetzt). Jeder Entwickler bekommt NUR sein zugewiesenes Arbeitspaket plus die
relevanten Schnittstellenvertraege - nicht die kompletten Pakete der anderen.
Beachte Abhaengigkeiten zwischen Paketen aus der Architektur: abhaengige Pakete
starten erst, wenn ihre Voraussetzung fertig ist.

Sobald ein @developer-Subagent sein Arbeitspaket fertig meldet, rufe DIREKT DANACH
- noch im selben Worktree, vor dem Merge - einen @code-reviewer-Subagenten auf das
Ergebnis dieses Pakets auf. Bei Freigabe-Empfehlung "Nein" oder kritischen/hohen
Funden: gib die Funde an denselben @developer-Subagenten (bzw. bei bereits beendetem
Subagenten: neuer @developer-Lauf im selben Worktree) zur gezielten Nachbesserung,
dann erneuter Code-Review. Wiederhole, bis der code-reviewer "Ja" oder "Ja mit
Auflagen" meldet. Erst danach gilt das Arbeitspaket als abschlussbereit fuer
Schritt 6. Unabhaengige Arbeitspakete koennen diesen Entwicklung-Review-Zyklus
parallel zueinander durchlaufen.

## Schritt 6: Merge
Fuehre die Worktrees der Entwickler gemaess der vom architect definierten
Integrations-/Merge-Reihenfolge zusammen. Bei Merge-Konflikten: löse sie anhand
der Schnittstellenvertraege aus Schritt 2, nicht durch Raten.

## Schritt 7: Security Review
Rufe @security-reviewer auf den gemergten Stand auf. Bei kritischen oder hohen
Funden: gib den betroffenen developer-Subagent (in seinem Worktree, falls noch
vorhanden, sonst direkt im gemergten Stand) den Auftrag, gezielt nachzubessern.
Wiederhole den Security Review nach der Nachbesserung.

## Schritt 8: Test
Rufe @tester auf den finalen, sicherheitsgepruefften Stand auf. Bei No-Go:
gib die gemeldeten Bugs an die zustaendigen developer-Subagents zur Behebung,
dann erneuter Testlauf. Wiederhole, bis Go erreicht ist oder ein Blocker vorliegt,
der eine Rueckfrage an den Menschen erfordert.

## Schritt 9: Ergebnispraesentation
Fasse das Gesamtergebnis fuer den Menschen zusammen:

### Zusammenfassung
Was wurde gebaut, in 3-4 Saetzen.

### Requirements
Kurzueberblick der Stories (Link/Verweis auf Details bei Bedarf).

### Architektur- und UX-Entscheidungen
Die wichtigsten Entscheidungen und deren Begruendung.

### Umsetzung
Was implementiert wurde, mit Dateipfaden/Struktur.

### Sicherheitspruefung
Ergebnis des security-reviewer, inkl. behobener Funde.

### Testergebnis
Go/No-Go, Testabdeckung, verbleibende bekannte Einschraenkungen.

### Naechste Schritte / offene Punkte
Was der Mensch noch entscheiden oder pruefen sollte.
