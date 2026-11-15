---
name: design-system-patterns
description: Wiederverwendbare UI-Bausteine/Muster in ThreadStack (Web + iOS/macOS), die bei neuen Entwuerfen IMMER zuerst geprueft werden sollten, statt Neues zu bauen
metadata:
  type: project
---

Bestand an wiederverwendbaren Loesungsmustern in ThreadStack, gefunden beim Entwurf
der Ansprechpartner-Erweiterung (2026-09-05). Vor jedem neuen Screen-Entwurf pruefen,
ob eines dieser Muster das Problem bereits loest.

## Web (index.html + public/app.js + public/progress.js)

- **Modal-Grundgeruest**: `.modal-overlay` > `.modal` (`modal-header`/`modal-body`/
  `modal-footer`), Schliessen per `overlayClick(event,'<id>')` + `×`-Button. Alle
  Dialoge folgen diesem Skelett (siehe `contact-modal`, `topic-modal`, `theme-link-modal`).
- **Rich-Text-Editor**: `.rt-wrapper` mit `.rt-toolbar` (id `<feld>-tb`) + `.rt-content`
  (contenteditable, id `<feld>`, `data-placeholder`). `setRT(id, html)`/`getRT(id)` zum
  Lesen/Schreiben. Fuer bereits befuellte Felder gibt es zusaetzlich ein Lese/Bearbeiten-
  Toggle-Muster (`.todo-desc-readview` + `.rt-display` + Stift-Button, siehe Topic-Modal
  `t-desc-*`) – wird genutzt, damit lange Inhalte nicht permanent im Bearbeitungsmodus
  angezeigt werden.
- **Zwischenstand/Fortschritt (TSProgress, `public/progress.js`)**: generisches
  Timeline-Modul fuer chronologische Eintraege zu einem `refType`/`refId`
  (`mountTimeline`, `mountInlineComposer`, `mountReentryCard`). Aktuell nur fuer
  `refType 'todo'|'topic'` validiert (`isValidRefType`). WICHTIG: `renderHead()`
  zeigt die Zeile "➡️ Naechster Schritt" **unconditional**, es gibt noch KEIN Flag,
  um sie zu unterdruecken – das ist bei Wiederverwendung fuer einen dritten refType
  ohne "naechster Schritt"-Konzept ein noetiger Erweiterungspunkt.
- **Theme-Link-Mechanismus** (`theme-link-modal`, `openThemeLinkModal`,
  `doAddThemeLink`/`doRemoveThemeLink`): Zuordnungsdialog "Topic zuweisen" fuer
  Todos/Themen zu Topics (= themes, Schlagwortstruktur). Rendert Toggle-Buttons
  "+ Zuweisen"/"✓ Zugewiesen" pro Topic.
- **`renderThemeItemRow(x)`** (app.js ~3728): Zeilen-Pattern fuer "welche Todos/
  Themen haengen an diesem Topic" – Typ-Badge (`.theme-item-type.type-todo|type-topic`),
  Titel, optionales Meeting-Label, Entfernen-Button (×). Gutes Vorbild fuer jede
  neue "Liste verknuepfter Vorhaben"-Anzeige.
- **Generischer Bestaetigungsdialog**: `#confirm-dialog` + `genericConfirm(title,
  message, confirmLabel, cancelLabel, opts)` (Promise-basiert) bzw. das aeltere
  `confirmCallback`-Pattern (z.B. `confirmDeleteContact`). Loeschbestaetigungen mit
  Seiteneffekt-Hinweis folgen dem Muster "„X" wird geloescht. <Zahl> <Objekt>
  werden mit geloescht/aufgehoben." (siehe Topic-Loeschung, app.js ~3796).
- **Suche**: zentrale Gruppen-Definition `GROUP_DEFS` in app.js (~6812) mit Icon
  (`_SEARCH_ICONS`), Label, Snippet-Erzeugung je Typ. Kontakte sind dort bereits
  als Gruppe `contact`/Label "Kontakte" vorhanden.
- **Reorder-Pattern ist aktuell NUR Drag&Drop** (`.drag-handle`, `⠿`) fuer Todos/
  Themen/Meetings – es gibt noch KEIN tastaturbedienbares Verschieben irgendwo im
  Projekt. Bei neuen NFR-7-pflichtigen Sortierfunktionen kann dieses Muster NICHT
  einfach kopiert werden, sondern braucht zusaetzlich Buttons/Tastaturkommandos.

## iOS/macOS (ThreadStackApp/ThreadStack/ThreadStack/*.swift)

- **`DescriptionEditorSheet.swift` / `DescriptionRichTextEditor`**: die "richtige"
  native Rich-Text-Loesung (kapselt `KnowledgeEditorController` + `KnowledgeEditorWebView`
  + `KnowledgeEditorToolbar`, per WKWebView an denselben Web-Editor-Kern angebunden).
  Ersetzt bei Todo/Topic bereits den fruehesten Klartext-Bug (`stripHTML` in einem
  reinen `TextEditor`). **`ContactsView.swift`/`ContactFormView` hat genau diesen
  Bug noch** (`description = stripHTML(c.description)` in einen `TextEditor`) – jede
  Kontakt-Rich-Text-Flaeche (Infoblock-Inhalt, Notizen) muss stattdessen die
  `DescriptionRichTextEditor`-Familie verwenden, kein dritter Editor-Pfad.
- **`ProgressTimelineView.swift` / `ProgressEntryEditorSheet.swift` /
  `ProgressEntryComposerView.swift`**: natives Gegenstueck zu TSProgress, ebenfalls
  generisch ueber `refType: String` (kein Enum) parametrisiert – erleichtert
  Erweiterung auf einen neuen refType wie "contact".
- **`KnowledgeTopicPickerSheet.swift`**: Mehrfachauswahl-Sheet (checkbare Zeilen,
  Suche, "Neues Topic anlegen" inline, `Set<String>` Selection) – wird bereits von
  Wissen UND Todo genutzt, um Topics (=themes) zuzuordnen. Ist das native Pendant
  zum Web-`theme-link-modal` und das strukturelle Vorbild fuer jedes neue native
  Mehrfachauswahl-Sheet (z.B. Kontakt-Zuordnung).

## Terminologie-Falle (wichtig fuer Formulierungen)

Im Projekt bedeuten "Topic" (= `themes`, frei verschlagwortbare Struktur, Web-Begriff)
und "Thema" (= `topics`, Tagesordnungspunkt eines Meetings) verschiedene Dinge und
werden von Nutzern leicht verwechselt. Jede neue UI-Formulierung/jeder neue Dialogtitel
muss explizit machen, welches der beiden gemeint ist (z.B. nie nur "zuordnen" ohne
Objekt zu benennen).

## Offline-/Status-Bausteine iOS (entdeckt 2026-11-15, Offline-Entwurf)

- Einziger bestehender Offline-Hinweis: `GraphView.offlineBanner` (HStack wifi.slash + Text caption + "Erneut versuchen", `.thinMaterial`, `DS.radiusM`). Neue Offline-Statusleiste soll diesen vereinheitlichen, nicht daneben eine zweite Optik bauen.
- Kontakt-Sheets nutzen je `@State isOffline` + `isTransportFailure(error)` (Extensions.swift) + "Erneut versuchen" - lokales Muster pro Sheet; `friendlyAssignmentErrorMessage` ist geteilt.
- `ToastOverlayView`/`state.showToast` = transienter Hinweis; `.errorAlert` = Alert. Badges: `dueBadge` (TodosView) und `ProgressBadgeView` (Icon+Text-Capsule, Farbe nie allein) sind Vorbild fuer Status-Badges.
- Abmelden existiert doppelt (ContentView macOS-Menue ~79 und iOS menuButton ~228), beide `Task { try? await state.logout() }` - jede Logout-Aenderung (Warnung) muss beide Stellen treffen. iOS: NavigationSplitView + `.refreshable`; macOS: Sidebar-Kopf mit Refresh-Button.
