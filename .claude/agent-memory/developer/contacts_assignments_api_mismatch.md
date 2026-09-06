---
name: contacts-assignments-api-mismatch
description: (BEHOBEN, 2026-09-05) public/contacts.js (W1) nahm fuer die Zustaendigkeits-API andere Response-Formen an als B3 tatsaechlich liefert — Fix + Regressionstests bereits umgesetzt
metadata:
  type: project
---

**Status: behoben (2026-09-05).** Ursprünglich beschrieb dieser Eintrag einen
noch nicht gemergten Formatkonflikt zwischen `public/contacts.js` (W1) und dem
B3-Backend (`lib/contacts/assignments/*`, Branch
`worktree-agent-a4fd34f05621b17d1`). Der B3-Branch wurde inzwischen fertig
integriert; `public/contacts.js` wurde entsprechend angepasst:

- `GET /api/assignments/:refType/:refId` liefert `{ contacts:[{contactId,
  name, role, email, assignedAt}], limit }` — der Zuordnungsdialog
  (`openAssignmentPicker`) entpackt jetzt `res.contacts.map(c => c.contactId)`
  statt eines flachen ID-Arrays.
- `GET /api/contacts/:contactId/assignments` liefert `{ items, page:{limit,
  offset,total,hasMore}, counts:{open,done} }`. `loadAssignments` liest jetzt
  `res.items` statt eines flachen Arrays UND sendet `limit:50` statt
  `limit:100` (B3 validiert 1..50, sonst 400 INVALID_LIMIT).
- Feldname `item.meetingLabel` → `item.meetingTitle` (B3-Projektion liefert
  `meetingTitle`/`meetingId`).

**Warum wichtig (für künftige Formatkonflikt-Situationen):** Ein Review hatte
entdeckt, dass der Prefill-Fehler durch das Formatmismatch STILL fehlschlug
(kein `onError`, kein sichtbarer Hinweis) und "Fertig" danach per
`PUT {contactIds}` ALLE bestehenden Zuordnungen gelöscht hätte (destruktiver
Bug, siehe auch [[assignment-picker-prefill-error-must-be-visible]] falls
dieser Eintrag später angelegt wird). Muster für künftige Fälle: bei einer
"Voll-Ersetzen"-PUT-Semantik (kein Delta-Update) MUSS ein fehlgeschlagenes
Prefill-Laden sowohl `onError` aufrufen als auch die Aktion (hier: "Fertig")
sichtbar/faktisch blockieren, nicht nur den Ladezustand als "leer" interpretieren.

**Wie anwenden:** Falls erneut ein Formatkonflikt zwischen einem Web-Modul und
einem Backend-Arbeitspaket auffällt: zuerst den TATSÄCHLICHEN Branch-Stand des
Backends lesen (nicht nur den ursprünglichen Schnittstellenvertrag), dann
Web-Modul UND zugehörige Tests (Mocks!) in einem Schritt anpassen — sonst
bilden die Tests weiterhin den falschen Vertrag ab und geben falsche
Sicherheit.

**Nachtrag (2026-09-05, Folgereview):** Beim ersten Fix wurde die manuelle
Dev-Testseite `public/contacts-dev.html` vergessen — ihr `TSHost`-Mock bildete
weiterhin das alte flache Format ab, obwohl `contacts.js` schon korrigiert
war. Lehre verallgemeinert: bei einem Formatkonflikt-Fix IMMER alle drei
Stellen in einem Schritt pruefen/anpassen — Produktivmodul, Unit-Test-Mocks
UND jede manuelle Dev-/Test-Harness-Seite (falls vorhanden) — sonst bleibt
genau die Flaeche falsch, die eigentlich als Absicherung gegen diese
Bugklasse dienen soll.

**Nachtrag (2026-09-06, Security-Review HOCH 2):** Derselbe Bugtyp trat noch
viel groesser bei Infoblöcken/Rubriken auf (`lib/contacts/routes.js`):
- `POST/PUT .../info-blocks` erwartet Feld `body`, contacts.js sandte `bodyHtml`.
- `PUT .../info-blocks/reorder` erwartet `orderedIds`, contacts.js sandte `order`.
- `DELETE /contact-categories/:id` erwartet Bestaetigung als Query-Parameter
  `?confirm=true`, contacts.js sandte Body `{force:true}`.
- `GET /contact-categories` liefert `{categories:[...]}`, `GET .../info-blocks`
  liefert `{blocks:[...],categories:[...]}`, `GET /contacts/:id` liefert
  `{contact,infoBlocks,categories,themeLinks}`, `POST/PUT /contact-categories`
  liefert `{category:{...}}` — contacts.js erwartete ueberall flache
  Arrays/Objekte und tarnte den Fehler durch `Array.isArray(x)?x:[]`-Fallbacks
  als harmlosen Leerzustand (Infoblöcke liessen sich in der Praxis gar nicht
  anlegen, alle Tests waren trotzdem gruen, weil die Mocks denselben falschen
  Vertrag abbildeten).
  Fix: `public/contacts.js`, `public/contacts-dev.html`,
  `test/contacts_web_module.test.js`, `test/web_contacts_overview.test.js`
  gleichzeitig korrigiert; alle `Array.isArray(x)?x:[]`-Stellen durch eine
  explizite Formatpruefung ersetzt, die bei Abweichung den bestehenden
  Fehlerpfad (`reportError`/`prefillError`) ausloest statt still leer
  weiterzumachen. Zusaetzlich neue Datei `test/contacts_web_e2e.test.js`
  angelegt: `public/contacts.js` in jsdom, aber `window.TSHost.api` schickt
  echte supertest-Requests gegen den per `loadServer()` geladenen ECHTEN
  server.js (In-Process, kein echter Socket noetig — `agent[method](path)`
  aus supertest reicht) — das ist der einzige verlaessliche Weg, um zu
  pruefen, dass ein Formatkonflikt-Fix nicht nur gegen selbst erfundene
  Mocks, sondern gegen die Realitaet funktioniert.
  Verallgemeinerte Lehre: bei JEDEM Formatkonflikt-Fund reicht es NICHT, nur
  den Server-Code zu lesen und contacts.js/Mocks zu "reparieren" — man MUSS
  parallel mindestens einen End-zu-Ende-Test gegen den echten Server
  schreiben, weil sonst dieselbe Bugklasse (Mock bestaetigt erfundenen
  Vertrag) beim naechsten Review wieder auftritt.
