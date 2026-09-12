---
name: domain-momentum
description: Wie "Thema"-Meilensteine bei der Sichtbarer-Fortschritt-Funktion (Erledigt-Moment/Serie/Wochen-Rueckblick) fachlich zu verstehen sind, obwohl das Konzept von "letztem Todo eines Themas" spricht
metadata:
  type: project
---

Das Konzept "Sichtbarer Fortschritt" (Erledigt-Moment, Tages-Serie, Wochen-
Rueckblick-Karte) verwendet den Satz "war dies das letzte offene Todo eines
Themas oder Kontakts" - das liest sich, als haette ein "Thema" mehrere
Kind-Todos. Hat es in ThreadStack aber nicht: "Thema" = DB-Tabelle `topics`
(Meeting-Tagesordnungspunkt), die KEINE Kind-Todos besitzt (siehe [[MEMORY]]
fuer die vertauschten Begriffe "Thema"/"Topic"). Explizit vom Menschen
entschieden (nicht die Themen-Tag-Hierarchie `themes`/`theme_links`):

- **Thema-Meilenstein**: JEDES Abschliessen eines Themas (`topics.done`
  0→1) gilt automatisch als Meilenstein - keine "letztes von mehreren"-
  Zaehlung, weil es keine Kind-Todos gibt.
- **Kontakt-Meilenstein**: echte Zaehlung ueber die bestehende n:m-Tabelle
  `contact_assignments` (ref_type IN ('todo','topic')) - Meilenstein nur
  wenn das gerade erledigte Todo/Thema das letzte noch offene einem Kontakt
  zugewiesene Vorhaben war.

**Why:** Ohne diese Klarstellung baut man versehentlich die Themen-Tag-
Hierarchie (`themes`) in die Meilenstein-Logik ein, obwohl der Mensch explizit
das einzelne Meeting-Thema (`topics`) gemeint hat.

**How to apply:** Bei kuenftigen Formulierungen wie "wenn das letzte X eines
Themas erledigt wird" IMMER zuerst pruefen, ob wirklich eine Mehrfachbeziehung
gemeint ist oder ob (wie hier) "Thema" faktisch ein atomares Einzelobjekt ist,
bei dem die Formulierung nur eine ungenaue menschliche Beschreibung war.

Weitere Namenskonvention: Fuer diese neue Funktion (Streak/Wochen-Rueckblick/
Erledigt-Moment) wurde bewusst der Modulname `momentum` gewaehlt, NICHT
`progress` - `lib/progress/` ist bereits durch den Zwischenstand-Mechanismus
(Fortschrittsverlauf/Notizen an Todos/Themen, siehe [[domain-progress-mechanik]])
belegt. Bei kuenftigen "Fortschritt"-Anforderungen zuerst pruefen, ob
`lib/progress` (Notizen) oder `lib/momentum` (Streak/Meilensteine/Wochen-
Rueckblick) gemeint ist - die deutschen Wortstaemme ueberlappen, die Module
sind komplett unabhaengig.

Weitere Annahme, die sich als Muster wiederholen kann: neue "Serie"/"Streak"-
Funktionen starten in ThreadStack IMMER bei 0 ab Rollout, kein rueckwirkendes
Backfill aus Bestandsdaten - vorhandene `done=1`-Zeilen haben keinen
Abschlusszeitstempel (`completed_at` existierte vor diesem Feature nicht).
