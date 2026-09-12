---
name: paket-momentum
description: Paketschnitt und Vertragsentscheidungen fuer das Sichtbarer-Fortschritt-Feature (Streak/Erledigt-Moment/Wochen-Rueckblick), als Vorbild fuer aehnlich gelagerte "kleines neues Modul + Wiring in Hotspot-Dateien"-Features
metadata:
  type: project
---

Fuer "Sichtbarer Fortschritt" (`lib/momentum/`) wurde der Hotspot-Paketschnitt
aus [[paketschnitt-hotspot-dateien]] konsequent angewendet: 5 Pakete
(M1 Kernmodul, M2 server.js-Wiring, M3 public/momentum.js Fachlogik,
M4 app.js/index.html-Wiring, M5 komplett iOS). Zusaetzliche, uebertragbare
Entscheidungen:

- **Bestehende Route liefert neues Feld statt neuer Extra-Request**: Die
  Erledigt-Moment-Bestaetigung braucht sofortiges Feedback nach dem Abhaken.
  Statt eines zweiten Requests (`GET /momentum/overview` direkt nach dem
  PUT) wurde vertraglich festgelegt, dass die BESTEHENDEN Routen
  `PUT /todos/:id` und `PUT /meetings/:mid/topics/:tid` (Paket M2) ein
  zusaetzliches, rein additives `momentum`-Feld in ihre JSON-Antwort
  einbetten (`{ weeklyCompletedCount, milestones: [...] }`), befuellt durch
  einen Funktionsaufruf in `lib/momentum` (Paket M1). Das ist non-breaking
  fuer alle bestehenden Konsumenten dieser Routen (zusaetzliches Feld wird
  von altem Code ignoriert) und vermeidet eine Race Condition zwischen
  "Todo abgehakt" und "Wochenzaehler neu laden".
- **Migration einer NEUEN Spalte auf einer BESTEHENDEN Kern-Tabelle
  (`todos`/`topics`) gehoert trotzdem ins Feature-Modul**, nicht nach
  `db/schema.js` - Vorbild ist NICHT nur `lib/archive` (neue Tabelle), sondern
  explizit `lib/contacts/schema.js` (`ALTER TABLE contacts ADD COLUMN
  search_text`), das dasselbe additive Muster auf einer fremden Tabelle
  bereits vormacht.
- **Modulname bewusst NICHT `progress`** (siehe [[domain-momentum]] im
  requirements-engineer-Memory) - `lib/progress/` ist bereits durch den
  Zwischenstand-Mechanismus belegt. Bei jedem neuen "Fortschritt"-Feature
  zuerst diese Namenskollision pruefen, bevor ein Modulname festgelegt wird.
- **Zeitzone kommt vom Client, nicht vom Server**: fuer "aktiver Tag"/
  "Wochengrenze" wurde bewusst EIN Query-Parameter (`utcOffsetMinutes`,
  Ganzzahl -1440..1440) statt eines gespeicherten Nutzer-Zeitzonen-Felds
  gewaehlt, weil Reisen/Zeitzonenwechsel sonst zu falschen historischen
  Berechnungen fuehren wuerden. Jede Anfrage bucketed serverseitig neu.
