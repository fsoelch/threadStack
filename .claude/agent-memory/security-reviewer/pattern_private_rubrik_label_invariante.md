---
name: pattern-private-rubrik-label-invariante
description: Datenschutz-Invarianten im Kontakte-Modul haengen am veraenderbaren Rubrik-LABEL ("Privates"/"Sonstiges") statt an einem stabilen Flag - bei jeder Aenderung dort pruefen
metadata:
  type: project
---

Im Kontakte-Modul (`lib/contacts/*`, `public/contacts.js`) haengen mehrere
Sicherheits-/Datenschutz-Invarianten am **Text-Label** einer Rubrik statt an
einem stabilen Merkmal:

- Snippet-Ausschluss privater Inhalte: `PRIVATE_CATEGORY_LABEL_NORM ===
  'privates'` in `lib/contacts/queries.js#batchContactExtras`.
- Client-seitige Schloss-/Aufklapp-Darstellung: `isPrivateCategory()` in
  `public/contacts.js` (prueft `normLabel(label) === 'privates'`).
- Schutz der Auffangrubrik vor Loeschen/Umbenennen:
  `label_norm === 'sonstiges'` in `lib/contacts/routes.js`.

**Why:** `PUT /api/contact-categories/:id` schuetzt nur "Sonstiges" vor
Umbenennung. Wird "Privates" umbenannt, faellt der Snippet-Filter
ersatzlos aus und bereits erfasste private Texte erscheinen auf der
Kontakt-Uebersichtskarte (empirisch reproduziert 2026-09-06). Eigene
Rubriken mit privatem Charakter ("Privat (Familie)") sind ohnehin nie
geschuetzt. `contacts.search_text`/`search_index` enthalten private Texte
grundsaetzlich (nur eigene Suche, daher akzeptiert).

**How to apply:** Bei jeder Aenderung an Rubriken/Infobloecken pruefen, ob eine
Invariante am Label statt an einem stabilen Feld haengt. Zielbild fuer eine
Behebung: Spalte `is_private` (bzw. eine stabile System-Rolle) auf
`contact_categories`, serverseitig in `serializeCategory` mit ausliefern,
Client stellt auf `cat.isPrivate` um.
