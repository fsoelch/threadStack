---
name: domain-contacts
description: Wie "Ansprechpartner"/Kontakte in ThreadStack modelliert sind und welche Feature-Luecken gegenueber Todos/Themen bestehen
metadata:
  type: project
---

Kontakte ("Ansprechpartner", DB-Tabelle `contacts`) sind der schwaechst
ausgebaute Objekttyp im Projekt: nur `name`, `role`, `email`, `description`
(ein einziges HTML-Freitextfeld), `sort_order`. Kein Zwischenstand
(`progress_entries` hat CHECK ref_type IN ('todo','topic')), keine Anhaenge
(ALLOWED_REF_TYPES = topic/todo/knowledge_page), nicht stack-faehig
(`/api/stack/push` erlaubt nur topic/todo).

**Why:** Wer bei einer Kontakt-Anforderung von "wie bei Todos" ausgeht, trifft
falsche Annahmen — Kontakte haben fast nichts davon.

**How to apply:** Bei jeder Kontakt-Anforderung explizit pruefen, ob eine
scheinbar "vorhandene" Faehigkeit fuer Kontakte wirklich existiert. Zwei
konkrete, wiederkehrende Luecken, die man als Anforderung mit aufnehmen
sollte:
- `theme_links` akzeptiert serverseitig `ref_type='contact'` (Kontakt →
  "Topic"/`themes`) und der Graph rendert das, aber die Web-UI hat KEINEN
  Weg, so einen Link anzulegen (`openThemeLinkModalFor*` gibt es nur fuer
  Todo und Topic). Lastenheft K02 behauptet die Faehigkeit trotzdem.
- Die iOS-App (`ContactsView.swift`) editiert `description` mit einem
  einfachen `TextEditor` und ruft beim Laden `stripHTML(...)` auf —
  Rich-Text, der im Web erfasst wurde, wird beim Speichern auf iOS
  zerstoert. Divergenz zu den Web-Editoren, laut CLAUDE.md ein Bug.
- Meeting-`participants` ist eine Liste freier Strings, KEIN Fremdschluessel
  auf `contacts`. Es gibt also keine Verknuepfung Kontakt ↔ Meeting/Thema/
  Todo (Stand 2026-09-05 als Anforderung "Zustaendigkeit" beauftragt).

Wichtige Unterscheidung, die Tester/Entwickler sonst verwechseln: eine
Infoblock-Rubrik "Zustaendigkeit" (Freitext am Kontakt) ist etwas anderes
als die echte Datenbeziehung Kontakt ↔ Thema/ToDo.

Siehe auch [[MEMORY]] fuer die vertauschten Begriffe "Thema" vs. "Topic",
[[domain-progress-mechanik]] fuer den erweiterbaren Zwischenstand-Mechanismus.
