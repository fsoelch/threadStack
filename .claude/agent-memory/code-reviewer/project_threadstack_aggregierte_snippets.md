---
name: threadstack-aggregierte-snippets
description: Server-aggregierte Textauszuege ueber Rubriken/Kategorien mit unterschiedlicher Vertraulichkeit - warum clientseitige Schutzpruefungen dort strukturell nicht tragen
metadata:
  type: project
---

Wenn der Server einen EINZIGEN aggregierten Klartextauszug (`snippet`, `excerpt`,
`preview`) ueber mehrere Kindzeilen konkateniert, die unterschiedliche
Vertraulichkeitsstufen haben koennen, kann kein clientseitiger Filter das mehr
reparieren — die Rubrik-Zuordnung des einzelnen Textstuecks ist im aggregierten
String nicht mehr enthalten.

**Why:** Konkret in `lib/contacts/queries.js#batchContactExtras`: alle
`contact_info_blocks.body_text` eines Kontakts werden rubrikunabhaengig
zu einem 280-Zeichen-Snippet gejoint, inkl. Rubrik "Privates".
`public/contacts.js#contactBadgesHtml` versucht das defensiv abzufangen, kann
aber nur den Fall "ALLE Rubriken sind privat" erkennen (`categories.every(
isPrivateCategory)`). Bei gemischten Rubriken landet der private Text
ungefiltert auf der Uebersichtskarte. Nachgemessen (2026-09-06, Worktree W2):
zwei Infobloecke "Zustaendigkeit" + "Privates" -> `GET /api/contacts` liefert
`snippet: "Region Nord, Budgetfreigaben Scheidung, zwei Kinder"`, und
`renderContactsView()` rendert das sichtbar in `.contact-card-badges`, ohne
dass der Kontakt geoeffnet wird.

**How to apply:**

- Bei JEDEM neuen aggregierten Auszugsfeld pruefen: gibt es unter den
  aggregierten Zeilen eine Kategorie/Flag mit abweichender Sichtbarkeit? Wenn
  ja, MUSS der Ausschluss in der SQL-Query stehen (`WHERE c.is_private = 0`
  bzw. Label-Ausschluss), nicht im Renderer.
- Ein Kommentar der Form "die Ausschlusspflicht dafuer liegt beim Server"
  in einem Frontend-Modul ist ein starkes Signal, dass genau dieser Ausschluss
  serverseitig FEHLT — immer gegenpruefen statt zu glauben.
- Reproduktion geht schnell ueber `test/helpers.js` (`setupEnv`/`loadServer`/
  `login`) + supertest gegen den echten Endpunkt; der Envelope von
  `GET /contact-categories` ist `{categories:[...]}`, Infobloecke werden mit
  `{categoryId, body}` (NICHT `bodyHtml`) angelegt.
- Zweitwirkung nicht vergessen: sobald ein Host das Feld zusaetzlich in einen
  lokalen Such-Haystack aufnimmt (`matchesContact` in `app.js` nahm `c.snippet`
  auf), wird der vertrauliche Text zusaetzlich durchsuchbar. Beim Bewerten
  beide Flaechen nennen.
- Gegenprobe immer mitliefern: der "nur private Rubrik"-Fall wird korrekt
  unterdrueckt — das belegt, dass der Guard existiert und trotzdem zu eng ist.

Siehe auch [[threadstack-web-module-konventionen]] und
[[threadstack-review-konventionen]].
