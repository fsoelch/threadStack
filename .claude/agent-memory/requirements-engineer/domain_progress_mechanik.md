---
name: domain-progress-mechanik
description: Konkrete Limits, Paging- und Ownership-Regeln des Zwischenstand-Mechanismus - Referenzwerte fuer "wie bei ToDos" formulierte Akzeptanzkriterien
metadata:
  type: project
---

Der Zwischenstand-Mechanismus (`lib/progress/`) ist bewusst ueber injizierte
Dependencies gebaut (`REF_TYPES`, `ownsRef`, `refInfo`, `isRefReadOnly`) und
damit auf weitere Objekttypen erweiterbar, ohne einen zweiten Mechanismus zu
bauen. Erweiterungspunkte fuer einen neuen ref_type: CHECK-Constraint in
`progress_entries`/`progress_meta`, `REF_TYPES` in routes.js, `refInfo()` in
queries.js, `purgeProgressOrphans()`. `ownsRef` (server.js) kennt bereits
contact/theme/knowledge.

Referenzwerte, mit denen sich "gleiche Limits wie bei ToDos" testbar
ausformulieren laesst (statt vage darauf zu verweisen):
- Rohes HTML max. 50000 Zeichen, sanitisierter Text max. 5000 Zeichen
- Naechster Schritt max. 1000 Zeichen; Rohfeld-Grenze 20000 Zeichen
- Paging: default limit 20, erlaubt 1..50, Cursor "<createdAtIso>|<id>",
  Sortierung created_at DESC, id DESC
- Schreib-Rate-Limit: 60 Aenderungen pro 10 Minuten je Nutzer
- Idempotenz ueber (user_id, client_token) - Doppelklick erzeugt keinen
  zweiten Eintrag
- Eintraege mit kind='result' sind nicht editier-/loeschbar
- Ownership: "existiert nicht" und "fremder Owner" liefern IDENTISCH 404
  (keine Existenz-Enumeration) - dieses Muster in Akzeptanzkriterien
  uebernehmen

**Why:** Nutzeranfragen lauten oft "so wie bei ToDos". Ohne diese Zahlen
werden Akzeptanzkriterien unpruefbar, und Entwickler bauen im Zweifel eine
zweite, leicht abweichende Loesung - laut CLAUDE.md ein Bug.

**How to apply:** Bei jeder Anforderung "Notizen/Verlauf/Zwischenstand fuer
<neuer Objekttyp>" zuerst pruefen, ob die Erweiterung dieses Mechanismus
gemeint ist, und die Limits oben als konkrete Akzeptanzkriterien zitieren.

Achtung `topics`: die Tabelle hat KEIN `user_id` - Eigentuemerschaft laeuft
immer ueber `JOIN meetings m ON m.id=t.meeting_id WHERE m.user_id=?`. Jede
Anforderung, die `topics` mit etwas verknuepft, braucht dazu ein eigenes
Akzeptanzkriterium. Siehe [[domain-contacts]].

## "Schlafen bis" (snoozedUntil) als Kurzoption an bestehenden Composern

`snoozedUntil` ist ein reines Datums-/Zeitstempelfeld auf `todos`/`topics`
(`PUT /todos/:id` bzw. `PUT /meetings/:mid/topics/:tid`, Body
`{snoozedUntil}`, Validierung ueber `isValidDate` in server.js). Contacts
haben KEIN snoozedUntil (siehe domain_contacts.md) - eine Anforderung "biete
Schlafen bis auch bei Kontakten an" waere ein Modellwechsel, kein UI-Feature,
und braucht Rueckfrage/Architekturentscheidung statt stiller Annahme.
Der Zwischenstand-Composer (`ComposerInstance` in progress.js) kannte
`snoozedUntil` bisher nur LESEND (Hinweistext "wird als Zwischenstand zur
Ruhephase gefuehrt"), nicht schreibend - "biete X beim Zwischenstand-
Eintragen gleich mit an" ist ein wiederkehrendes Anfrage-Muster fuer genau
diesen Composer (naechster Kandidat waere z.B. "Faellig am").
