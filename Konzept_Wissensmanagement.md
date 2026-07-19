# Konzept: Wissensmanagement für ThreadStack

Stand: Juli 2026 · Entwurf zur Diskussion, noch nicht implementiert

## 1. Zielbild

Topics (Themenbereiche) werden von einer flachen Tag-Liste zu einem **hierarchischen Baum** mit beliebig vielen Ebenen. An jedes Topic (auf jeder Ebene) können **Wissensseiten** (strukturierter Freitext mit Formatierung, Bildern, Links, Anhängen) und **Todos** gehängt werden. Ein übergeordnetes Topic zeigt zusätzlich alles, was an seinen Unter-Topics hängt — mit klarer visueller Herkunftskennzeichnung.

Bestehende Funktionalität (Topics als Kategorie für Themen/Todos, `theme_links`) bleibt vollständig erhalten und wird erweitert, nicht ersetzt.

## 2. Datenmodell

### 2.1 Erweiterung der bestehenden `themes`-Tabelle (additiv)

| Neues Feld | Typ | Bedeutung |
|---|---|---|
| `parent_id` | `TEXT NULL` | FK auf `themes.id` — `NULL` = Wurzel-Topic |
| `sort_order` | `INTEGER NULL` | Manuelle Sortierung der Geschwister-Topics |

Kein Limit für die Tiefe der Hierarchie. Zyklen werden serverseitig beim Verschieben eines Topics verhindert (ein Topic darf nicht unter sich selbst oder seine eigenen Nachfahren gehängt werden).

### 2.2 Neue Tabelle `knowledge_pages`

| Feld | Typ | Bedeutung |
|---|---|---|
| `id` | `TEXT` | Primärschlüssel |
| `user_id` | `TEXT` | Besitzer |
| `title` | `TEXT NOT NULL` | Überschrift (Pflichtfeld) |
| `content` | `TEXT` | Rich-Text-HTML (via `stripUnsafeHtml()` bereinigt) |
| `sort_order` | `INTEGER NULL` | Sortierung innerhalb eines Topics |
| `created_at` | `DATETIME` | |
| `updated_at` | `DATETIME` | |

### 2.3 Neue Tabelle `knowledge_topic_links`

Eine Wissensseite kann an **mehrere** Topics hängen (m:n).

| Feld | Typ | Bedeutung |
|---|---|---|
| `id` | `TEXT` | Primärschlüssel |
| `knowledge_page_id` | `TEXT` | FK auf `knowledge_pages.id` |
| `theme_id` | `TEXT` | FK auf `themes.id` |

### 2.4 Bilder und Anhänge an Wissensseiten

Inline-Bilder werden wie Dateianhänge über die bestehende `attachments`-Tabelle abgelegt (`ref_type = 'knowledge_page'`). Inline-eingebettete Bilder im Editor referenzieren die Attachment-URL statt Base64 — hält die HTML-Payload klein.

### 2.5 Volltextsuche: SQLite FTS5

Neue virtuelle Tabelle `search_index` (FTS5) mit Spalten `ref_type, ref_id, title, body`, synchron gehalten über `INSERT/UPDATE/DELETE`-Trigger auf `themes`, `topics`, `todos`, `contacts` und `knowledge_pages`. Ersetzt die aktuelle LIKE-basierte Suche vollständig — ein gemeinsamer Index für alle durchsuchbaren Ressourcen, inkl. Relevanz-Ranking (`bm25()`).

Migration: `CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(...)`, einmaliger Backfill beim ersten Start nach Update, danach nur noch Trigger-Pflege. Additiv, keine bestehenden Tabellen verändert.

## 3. REST-API-Erweiterung

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/themes/tree` | Vollständiger Topic-Baum (verschachtelt oder flach mit `parentId`) |
| `PUT` | `/themes/:id/move` | Topic unter neues Parent verschieben (inkl. Zyklus-Check) |
| `PUT` | `/themes/reorder` | Geschwister-Topics sortieren |
| `DELETE` | `/themes/:id?cascade=true\|false` | Löschen mit Nutzerentscheidung: kaskadierend oder Unter-Topics hochstufen |
| `GET` | `/themes/:id/knowledge?includeDescendants=true` | Wissensseiten des Topics, optional inkl. Unter-Topics |
| `GET` | `/themes/:id/todos?includeDescendants=true` | Todos des Topics, optional inkl. Unter-Topics |
| `GET` | `/knowledge` | Alle Wissensseiten (global), filterbar per `?themeId=` |
| `POST` | `/knowledge` | Wissensseite anlegen (`title`, `content`, `themeIds[]`) |
| `PUT` | `/knowledge/:id` | Wissensseite bearbeiten |
| `DELETE` | `/knowledge/:id` | Wissensseite löschen |
| `PUT` | `/knowledge/:id/themes` | Topic-Verknüpfungen einer Wissensseite setzen |
| `GET` | `/search?q=...` | Erweiterte Volltextsuche über FTS5, liefert Treffer über alle Ressourcentypen inkl. Topic-Pfad |

## 4. Löschverhalten (nutzergesteuert)

Beim Löschen eines Topics mit Unter-Topics erscheint ein Bestätigungsdialog mit zwei Optionen (Radio-Auswahl, kein Default vorausgewählt):

- **„Alles löschen"** — Topic, alle Unter-Topics, deren Wissensseiten und die Verknüpfungen werden entfernt. Todos und Themen selbst bleiben erhalten (nur ihre Verknüpfung zum Topic entfällt), da sie eigenständige Objekte sind.
- **„Unter-Topics eine Ebene hochstufen"** — Unter-Topics werden an das Elternteil des gelöschten Topics gehängt (bzw. zur Wurzel, falls das gelöschte Topic bereits Wurzel war). Nichts geht verloren.

Der Dialog zeigt vorab die Anzahl betroffener Unter-Topics und Wissensseiten, damit die Entscheidung informiert getroffen werden kann.

## 5. Navigation (Web-App)

**Kombination aus Baum + Breadcrumbs** (Variante C):

- **Seitenleiste**: Ausklappbarer Topic-Baum analog zum bestehenden Meetings-Bereich; Ein-/Ausklappen pro Knoten, aktueller Knoten hervorgehoben. Drag & Drop zum Verschieben eines Topics unter ein anderes Parent (nutzt bestehendes Drag & Drop-Pattern).
- **Detailansicht**: Breadcrumb-Pfad oben (`Softwareentwicklung › Frontend › React`), jedes Segment klickbar. Darunter zwei Sektionen: **Wissen** und **Todos**, jeweils mit Einträgen aus dem Topic selbst sowie (standardmäßig eingeblendet, ausblendbar) aus allen Unter-Topics.
- **Herkunftskennzeichnung**: Jeder vererbte Eintrag (aus einem Unter-Topic) trägt ein kleines Badge mit dem Namen des Unter-Topics, farblich abgesetzt — analog zu den bestehenden Theme-Chips. Direkt zugehörige Einträge bleiben ohne Badge.
- **Globale Wissens-Ansicht**: Neuer Menüpunkt „Wissen" in der Seitenleiste (auf Ebene von Todos/Themen), zeigt alle Wissensseiten mit Topic-Filter-Dropdown (inkl. Baum-Auswahl) und Sortierung — unabhängig vom Baum direkt erreichbar.

## 6. Editor-Erweiterung (gemeinsam für alle Bereiche)

Der bestehende eigene `contenteditable`-Editor (`initRtToolbar`, `rtCmd`, `getRT`, `setRT`) wird erweitert statt ersetzt — **ein Editor für Themen, Todos, Contacts und neu Wissensseiten**:

- **Tabellen**: Einfügen/Zeilen/Spalten via Toolbar-Button, Basis-`<table>`-HTML, minimal stylebar (kein Merge von Zellen in V1)
- **Bilder**: Upload direkt im Editor (Drag & Drop oder Button), landet als Attachment, wird als `<img src="…">` referenziert
- **Links**: bereits vorhanden, bleibt
- **Farben**: bereits vorhanden (Textfarbe), Ergänzung um Hintergrundfarbe für Tabellenzellen
- `stripUnsafeHtml()`-Allowlist wird um `table/thead/tbody/tr/td/th` und `img` (mit `src`-Validierung gegen eigene Attachment-URLs) erweitert

Damit profitieren auch bestehende Themen/Todos/Contacts-Beschreibungen von Tabellen und Bildern, ohne zwei Editor-Erfahrungen im Produkt zu haben.

## 7. Native App (iOS/macOS)

- **TopicsView** wird zu einer Baum-Navigation erweitert (`OutlineGroup` bzw. rekursive `DisclosureGroup`), analog zum Web-Verhalten
- Neue `KnowledgeView` / `KnowledgePageDetailView` mit `Text(htmlAttributedString(...))` für die Anzeige; da iOS keinen eigenen Rich-Text-Editor hat, werden Wissensseiten **auf iOS nur gelesen**, Bearbeitung erfolgt vorerst nur über die Web-App (analog zur bestehenden Einschränkung bei anderen Rich-Text-Feldern)
- Herkunfts-Badges bei vererbten Todos/Wissensseiten analog zu den bestehenden Theme-Chips
- Push/Pop auf den Stack bleibt unverändert; Wissensseiten werden **nicht** auf den Stack gelegt (kein „aktiver Arbeitskontext"-Charakter)

## 8. Phasenplan

| Phase | Umfang |
|---|---|
| **1 — Datenmodell & Hierarchie** | `parent_id`/`sort_order` auf `themes`, Baum-API, Verschieben, Lösch-Dialog mit Nutzerentscheidung |
| **2 — Wissensseiten (Web)** | `knowledge_pages`-Tabelle, CRUD-API, Editor-Erweiterung (Tabellen, Bilder), globale Wissens-Ansicht, Detailansicht mit Vererbung |
| **3 — Navigation & Vererbung** | Baum-Sidebar, Breadcrumbs, Herkunfts-Badges für vererbte Todos/Wissen |
| **4 — Volltextsuche** | FTS5-Index, Trigger, Umstellung der bestehenden Suche (⌘K) auf FTS5 mit Ranking |
| **5 — Native App** | Baum-Navigation, `KnowledgeView` (read-only), Herkunfts-Badges |

## 9. Offene Punkte für später (bewusst nicht in diesem Konzept)

- Versionshistorie von Wissensseiten (Undo/Rückblick auf frühere Stände)
- Verschieben von Wissensseiten zwischen Topics per Drag & Drop (V1: nur über Formular)
- Volltextsuche mit Snippet-Highlighting im Ergebnis (V1: nur Treffer + Pfad)
