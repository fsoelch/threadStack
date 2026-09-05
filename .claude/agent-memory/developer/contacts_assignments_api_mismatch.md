---
name: contacts-assignments-api-mismatch
description: public/contacts.js (W1) nimmt fuer die Zustaendigkeits-API andere Response-Formen an als der (Stand 2026-09-05 noch nicht gemergte) B3-Backend-Stand liefert
metadata:
  type: project
---

`public/contacts.js` (Kontakt-Detail-Modul, W1) geht bei der "Ist zustaendig
fuer"-Sektion und beim Zuordnungsdialog (`openAssignmentPicker`) von folgenden
Response-Formen aus:
- `GET /api/contacts/:id/assignments` -> erwartet eine reine Liste (Array) von
  Eintraegen direkt als Body.
- `GET /api/assignments/:refType/:refId` -> erwartet eine reine Liste von
  Kontakt-IDs (Strings) direkt als Body.

Der Backend-Stand fuer die Zustaendigkeits-API liegt (Stand 2026-09-05) auf dem
separaten, noch NICHT in main/den hier bearbeiteten Branch gemergten Branch
`worktree-agent-a4fd34f05621b17d1` (`lib/contacts/assignments/*`, Commit
"fix(contacts): Verifikations-Review-Nachbesserungen B3 ..."). Dort liefern die
Endpunkte tatsaechlich:
- `GET /assignments/:refType/:refId` -> `{ contacts: [{contactId, name, role,
  email, assignedAt}, ...], limit }` (Objekt, keine reine ID-Liste!).
- `GET /contacts/:contactId/assignments` -> `{ items: [...], page: {limit,
  offset, total, hasMore}, counts: {open, done} }` (Objekt, kein reines Array!).

**Warum wichtig:** Sobald der B3-Branch gemergt wird, brechen die o.g.
Annahmen in `public/contacts.js` sowie deren Tests (`test/contacts_web_module.
test.js` mockt die Endpunkte ebenfalls als reine Arrays) still — die UI wuerde
dann leere Listen anzeigen, da `Array.isArray(response)` fehlschlaegt statt
`response.items`/`response.contacts` auszulesen.

**Wie anwenden:** Beim naechsten Merge/Integrationsschritt (vermutlich B4/B5
oder ein eigenes Anpassungspaket) muss `public/contacts.js` (Funktionen
`loadAssignments`, `openAssignmentPicker`) UND die zugehoerigen Tests auf die
tatsaechliche, verschachtelte Response-Form angepasst werden. Nicht
eigenmaechtig vorab "auf Verdacht" anpassen, solange der Backend-Stand nicht
gemergt ist (sonst driften Annahme und Realitaet moeglicherweise erneut
auseinander) - aber beim Merge aktiv pruefen, nicht nur auf gruene Tests
verlassen (die Mocks im W1-Testmodul bilden aktuell den FALSCHEN Vertrag ab).
