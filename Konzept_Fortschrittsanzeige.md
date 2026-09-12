# Konzept: Sichtbarer Fortschritt für ThreadStack

Stand: 11. September 2026 · Entwurf zur Uebergabe an das Feature-Team, noch nicht implementiert.
Kombiniert die Konzepte 1 (Wochen-Rueckblick-Karte), 3 (Sanfte Tages-Serie) und 4 (Erledigt-Moment)
aus der Konzept-Uebersicht "Sichtbarer Fortschritt" (Artifact vom 11.09.2026).

## 1. Zielbild

Nutzer sollen regelmaessig sehen, was sie an Todos tatsaechlich bewegt haben - nicht als
Punkte-/Level-System wie in klassischen Gamification-Apps, sondern als ehrlicher Spiegel der
eigenen Arbeit an Themen und Kontakten. Das Feature besteht aus drei Bausteinen, die
zusammenwirken, aber unabhaengig abschaltbar/anpassbar bleiben:

1. **Erledigt-Moment** - sofortiges, dezentes Feedback beim Abhaken eines Todos.
2. **Sanfte Tages-Serie** - ein Streak-Zaehler fuer Tage mit Aktivitaet, ausdruecklich ohne
   Angst-Mechanik (keine "Serie stirbt gleich"-Eskalation, geplante Pausen sind vorgesehen).
3. **Wochen-Rueckblick-Karte** - eine woechentliche Zusammenfassung aus erfassten/abgeschlossenen
   Todos, abgeschlossenen Themen und der aktuellen Serie.

Ausdruecklich **kein** Ziel dieses Konzepts: Punkte/Levels/Badges, Baesten-/Ranglisten,
Vergleich mit anderen Nutzern, KI-generierte Texte (das waere der separat vorgeschlagene,
hier nicht enthaltene "Monats-Brief"). Der Ton bleibt ruhig und bestaetigend, nie mahnend.

## 2. Baustein: Erledigt-Moment

- **Ausloeser:** Ein Todo wird als erledigt markiert.
- **Reaktion:** Eine kurze, nicht-blockierende Bestaetigung (kein Modal, kein Klick zum
  Wegklicken noetig) mit einem laufenden Wochenzaehler, z. B. "Erledigt - diese Woche: 7".
- **Meilenstein-Fall:** War dies das letzte offene Todo eines Themas oder Kontakts, faellt die
  Bestaetigung deutlicher aus (z. B. "Thema 'Serverumzug' ist jetzt komplett abgeschlossen").
- **Einstellbarkeit:** Muss sich in den Nutzereinstellungen abschalten lassen - Risiko: bei sehr
  aktiven Nutzern (viele Abhak-Vorgaenge pro Sitzung) kann das sonst als Rauschen empfunden werden.
- **Nicht enthalten:** Konfetti/grosse Animationen, Sound, Vibration.

## 3. Baustein: Sanfte Tages-Serie

- **Aktiver Tag:** Ein Kalendertag zaehlt als aktiv, sobald der Nutzer mindestens ein Todo neu
  erfasst **oder** mindestens ein Todo abgeschlossen hat (Zeitzone des Nutzers massgeblich).
- **Serie:** Anzahl aufeinanderfolgender aktiver Tage. Anzeige unaufdringlich (z. B. kleine Zahl
  im Dashboard/Header), keine Push-Notifications, die vor drohendem Serienverlust warnen.
- **Geplante Pausen:** Nutzer kann Tage im Voraus als "Pause" markieren (z. B. Urlaub); solche
  Tage unterbrechen die Serie nicht, auch ohne Aktivitaet.
- **Ungeplante Luecke:** Ein nicht als Pause markierter Tag ganz ohne Aktivitaet setzt die Serie
  auf 0 zurueck - ohne dramatische Darstellung ("verloren"-Screen o. ae.), einfach ein neuer Start
  ab dem naechsten aktiven Tag.
- **Bewusst kein** Vorrat an "Freeze-Tokens", kein Countdown, keine Erinnerungs-Eskalation am
  Abend eines sonst inaktiven Tages - das war der Hauptkritikpunkt an klassischen Streak-Systemen
  und soll hier vermieden werden.

## 4. Baustein: Wochen-Rueckblick-Karte

- **Rhythmus:** Einmal woechentlich, automatisch generiert (z. B. Sonntagabend oder ein vom
  Nutzer waehlbarer Wochentag), ohne Zutun des Nutzers.
- **Inhalt:**
  - Anzahl neu erfasster Todos in der Woche
  - Anzahl abgeschlossener Todos in der Woche
  - Themen/Kontakte, die in dieser Woche vollstaendig abgeschlossen wurden (falls vorhanden)
  - Aktuelle Tage-Serie (siehe Baustein 3)
- **Darstellung:** Eigene Karte/Ansicht, an geeigneter Stelle im Dashboard; ob mit Verlauf
  vergangener Wochen, ist eine offene Frage (siehe unten).
- **Kein KI-Text noetig** - rein zahlenbasierte Aggregation, um das Feature schlank zu halten.

## 5. Zusammenspiel

Der Erledigt-Moment liefert das sofortige Signal bei jeder einzelnen Handlung. Jede Handlung
(Erfassen oder Abschliessen) traegt zugleich zum aktiven Tag der Serie bei. Am Ende der Woche
fasst die Rueckblick-Karte beides zusammen: wie viele Erledigt-Momente es gab, welche Themen
dadurch abgeschlossen wurden, und wie lang die aktuelle Serie ist. Die drei Bausteine teilen sich
damit dieselbe Datengrundlage (Todos: Erfassungszeitpunkt, Abschlusszeitpunkt, Zugehoerigkeit zu
Thema/Kontakt), ohne dass ein Baustein zwingend von einem anderen abhaengt - jeder soll auch
einzeln abschaltbar sein.

## 6. Offene Fragen fuer das Requirements-Engineering

- Gilt "aktiver Tag" pro Nutzerkonto oder muesste zwischen privaten und geteilten/Team-Kontexten
  unterschieden werden (falls ThreadStack das inzwischen kennt)?
- Wie viele geplante Pausentage darf ein Nutzer im Voraus markieren, und wie weit im Voraus?
- Soll die Wochen-Rueckblick-Karte einen Verlauf vergangener Wochen zeigen, oder immer nur die
  aktuelle Woche?
- Wo genau erscheinen Erledigt-Moment-Bestaetigung und Wochen-Rueckblick-Karte in der bestehenden
  Navigation (Dashboard, eigener Bereich, Teil einer bestehenden Ansicht)?
- Muss die Serie fuer Bestandsnutzer rueckwirkend aus vorhandenen Todo-Zeitstempeln berechnet
  werden, oder startet sie bei 0 ab Rollout-Datum?
- Soll es eine Kappung geben, ab wie vielen Erledigt-Moment-Bestaetigungen pro Sitzung die
  Anzeige automatisch stumm geschaltet wird, um Rauschen bei sehr aktiven Nutzern zu vermeiden?
