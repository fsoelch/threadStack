# Handoff: ThreadStack UI Redesign — Variante A "Refined Dark"

## Überblick

Dieses Paket beschreibt das vollständige UI-Redesign der ThreadStack Web-App.
Ziel: das bestehende Interface modernisieren, ohne die Funktionalität oder Codestruktur grundlegend zu verändern. Die Änderungen sind evolutionär und direkt in `index.html` umsetzbar.

## Über die Design-Dateien

Die beiliegende `ThreadStack UI Redesign.html` ist ein **High-Fidelity-Designreferenz-Prototyp** — kein Produktionscode. Die Aufgabe besteht darin, die darin gezeigte Variante A pixelgenau in die bestehende `index.html` zu übertragen: CSS-Variablen ersetzen, Schrift tauschen, Strukturänderungen umsetzen. Nicht den HTML-Code des Prototypen kopieren.

## Fidelity

**High-Fidelity.** Alle Farben, Abstände, Radii, Schriftgrößen und Zustände (hover, active, done, snoozed) sind exakt spezifiziert. Der Entwickler soll das Layout pixel-präzise nachbauen.

---

## Strukturelle Änderungen (wichtigste Neuerungen)

### 1. Navbar entfernen — in Sidebar integrieren

**Aktuell:**
```
<nav class="navbar">          ← dunkle Leiste mit Logo + User
  <div class="layout">
    <aside class="sidebar">   ← dunkle Sidebar
    <main class="main">
```

**Neu:**
```
<div class="layout">
  <aside class="sidebar">     ← Logo + New-Button + User am unteren Rand
  <div class="main-wrapper">
    <div class="topbar">      ← neue schlanke 52px-Leiste (Breadcrumb + AI-Badge)
    <main class="main">
```

Die `navbar`-Klasse und der `#admin-btn` in der Navbar entfallen. Das Logo, der Benutzername und das User-Menü wandern in die Sidebar. Der `--nav-h: 56px` Token wird auf `0` gesetzt oder entfernt.

### 2. Neue Topbar (52px, hell)

Ersetzt die dunkle Navbar im Main-Bereich:
- Hintergrund: `#FFFFFF`
- Border-bottom: `1px solid #E8E7E2`
- Höhe: `52px`
- Links: Breadcrumb (`Meetings › Meeting-Titel`)
- Rechts: AI-Badge (nur sichtbar wenn AI aktiv)

### 3. Emoji → SVG-Icons

Alle Emoji in der UI (💬 🔍 🤖 👥 🔑 📧 ⎋ ✓ etc.) durch inline SVG-Linien-Icons ersetzen. Empfohlene Quelle: **Lucide Icons** (https://lucide.dev) — konsistenter 1.5px-Stroke, 24×24 Viewbox. Im Code auf 12–16px skalieren.

---

## Design Tokens — CSS-Variablen Ersatz

Folgenden Block direkt als Ersatz für den bestehenden `:root {}` in `index.html` verwenden:

```css
:root {
  /* Sidebar – dark */
  --sb-bg:      #0D0F11;
  --sb-border:  #191C1F;
  --sb-hover:   rgba(255,255,255,.045);
  --sb-active:  rgba(29,111,232,.15);
  --sb-active-border: rgba(29,111,232,.25);
  --sb-text:    #687280;
  --sb-title:   #E8EDF3;
  --sb-muted:   #30383F;

  /* Main – light */
  --bg:         #F5F5F2;
  --card:       #ffffff;
  --card2:      #F9F9F7;
  --border:     #E8E7E2;
  --border-md:  #EEEEE9;
  --text:       #111210;
  --text-muted: #5A5850;
  --text-light: #9A9890;

  /* Brand – Blau statt Indigo */
  --primary:        #1D6FE8;
  --primary-dark:   #1560CC;
  --primary-light:  #EBF2FD;
  --primary-glow:   rgba(29,111,232,.10);

  /* Status */
  --green:       #14A87C;
  --green-light: #F0FDF8;
  --green-ring:  #BBF7D0;
  --red:         #E74848;
  --red-light:   #FEF2F2;
  --amber:       #F0A020;
  --amber-light: #FFFBEB;

  /* Layout */
  --sb-w:  252px;
  --nav-h: 0px;       /* Navbar entfernt */
  --r:     8px;       /* war: 12px */
  --r-lg:  12px;      /* war: 16px */

  /* Shadows */
  --shadow-xs: 0 1px 2px rgba(16,22,30,.05), 0 0 0 1px rgba(16,22,30,.06);
  --shadow-sm: 0 2px 6px rgba(16,22,30,.08), 0 1px 2px rgba(16,22,30,.05);
  --shadow-md: 0 6px 20px rgba(16,22,30,.12), 0 2px 6px rgba(16,22,30,.06);
  --shadow-lg: 0 16px 40px rgba(16,22,30,.16), 0 4px 12px rgba(16,22,30,.08);
  --shadow-xl: 0 24px 56px rgba(16,22,30,.20), 0 8px 16px rgba(16,22,30,.08);
}
```

---

## Schrift

**Entfernen:**
```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
```

**Ersetzen durch:**
```css
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=DM+Mono:wght@400;500&display=swap');
```

**Body font-family:**
```css
body {
  font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
}
```

**DM Mono** für alle Datums- und numerischen Anzeigen:
- `.meeting-item-sub` (Datum + Anzahl offen in der Sidebar)
- `.meta-chip` mit Datum
- `.result-date`
- `.snooze-info`
- `.due-badge`

```css
.meeting-item-sub,
.result-date,
.snooze-info,
.due-badge {
  font-family: 'DM Mono', monospace;
}
```

---

## Typografie-Scale

| Verwendung | Größe | Gewicht | Letter-Spacing |
|---|---|---|---|
| Meeting-Titel (Detail) | 22px | 700 | -0.04em |
| Modal-Überschrift | 17px | 700 | -0.025em |
| Karten-Titel / `.topics-header h2` | 14–15px | 700 | -0.02em |
| Thema-Titel `.topic-title` | 14px | 600 | -0.015em |
| Fließtext / Beschreibung | 14px | 400 | -0.01em |
| Sidebar Meeting-Name | 13px | 500–600 | 0 |
| Sekundärtext / `.text-muted` | 12–13px | 400 | 0 |
| Pills / Badges | 11–11.5px | 600 | 0 |
| Section-Labels (uppercase) | 10px | 700 | 0.10em |
| Datum/Meta (DM Mono) | 11–11.5px | 400 | 0 |

**Basis-Schriftgröße:** 14px (war: 14px — bleibt, aber Inter → DM Sans macht es subjektiv größer/moderner)

---

## Komponenten-Spezifikation

### Sidebar

```
Breite:           252px
Hintergrund:      #0D0F11
Rechter Rand:     1px solid #191C1F

Logo-Bereich (top):
  Padding:        18px 14px 14px
  Border-bottom:  1px solid #191C1F
  Logo-Icon:      29×29px, border-radius:8px, background:#1D6FE8
  Logo-Text:      15px / 700 / #E8EDF3 / letter-spacing:-0.025em

Neues-Meeting-Button:
  Padding:        9px
  Background:     #1D6FE8
  Border-radius:  8px
  Font:           13px / 600 / white
  Icon + Text Lücke: 6px

Suchfeld:
  Background:     rgba(255,255,255,.055)
  Border:         1px solid rgba(255,255,255,.07)
  Border-radius:  7px
  Padding:        7px 10px
  Icon-Farbe:     #3E4650
  Placeholder:    #3A434E

Nav-Items (Todos/Themen):
  Padding:        7px 10px
  Border-radius:  7px
  Icon-Container: 24×24px, border-radius:6px
  Todos-Icon-bg:  rgba(20,185,129,.17), icon: #14B87E
  Themen-Icon-bg: rgba(124,58,237,.17), icon: #9B7FE8
  Label:          13px / 500 / #6E7882

Section-Label "Meetings":
  Font:           10px / 700 / #2E3540 / uppercase / letter-spacing:0.10em
  Padding:        10px 20px 4px

Meeting-Listeneintrag (normal):
  Padding:        8px 10px
  Border-radius:  7px
  Name:           13px / 500 / #687280
  Sub:            11px / DM Mono / #30383F

Meeting-Listeneintrag (aktiv):
  Background:     rgba(29,111,232,.15)
  Border:         1px solid rgba(29,111,232,.25)
  Border-radius:  8px
  Name:           13px / 600 / #E8EDF3
  Sub:            11px / DM Mono / #404D5C

User-Bereich (bottom):
  Padding:        10px 14px
  Border-top:     1px solid #191C1F
  Avatar:         26×26px, border-radius:50%, background:#1D6FE8
  Label:          12.5px / 500 / #5E6870
```

### Topbar (neu, ersetzt Navbar)

```
Höhe:             52px
Hintergrund:      #FFFFFF
Border-bottom:    1px solid #E8E7E2
Padding:          0 24px
Position:         sticky top:0, z-index:20

Breadcrumb:
  "Meetings":     12.5px / 400 / #B0B0A8
  Trennzeichen:   Chevron-Icon / #D0D0C8
  Aktuelle Seite: 12.5px / 600 / #1A1918

AI-Badge (rechts, nur sichtbar wenn AI aktiv):
  Padding:        4px 10px
  Border-radius:  6px
  Background:     rgba(29,111,232,.07)
  Border:         1px solid rgba(29,111,232,.12)
  Icon + Text:    Sparkle-Icon + "AI" / 11px / 700 / #1D6FE8
```

### Meeting-Header-Card

```
Background:       white
Border:           1px solid #E8E7E2
Border-radius:    12px
Overflow:         hidden
Margin-bottom:    14px

Accent-Stripe (oben):
  Höhe:           3px
  Farbe:          var(--primary), opacity:.7

Body-Padding:     20px 22px

Titel:            22px / 700 / #111210 / letter-spacing:-0.04em
Beschreibung:     13px / 400 / #8A8880 / line-height:1.5
Margin nach Desc: 12px

Meta-Chips:
  Padding:        3px 9px
  Border-radius:  100px
  Background:     #F3F2EE
  Border:         1px solid #E5E4DF
  Font:           11.5px / 500 / #686660
  Gap zwischen Chips: 5px

Aktions-Buttons (rechts):
  "Bearbeiten":   padding 6px 12px, border 1px solid #E5E4DF, bg white,
                  border-radius:7px, 12.5px / 400 / #686660
  "+ Thema":      padding 6px 12px, bg #1D6FE8, border:none,
                  border-radius:7px, 12.5px / 600 / white
```

### Topics-Section

```
Background:       white
Border:           1px solid #E8E7E2
Border-radius:    12px
Overflow:         hidden

Header:
  Padding:        13px 20px
  Border-bottom:  1px solid #EEEEE9
  Titel:          14px / 700 / #111210 / letter-spacing:-0.02em
  Count-Badge:    padding 1px 8px, border-radius:100px, bg #EEEEE9,
                  11px / 600 / #888880
  Suchfeld:       bg #F4F4F1, border 1px solid #E8E7E2, border-radius:6px,
                  padding 5px 10px, width:158px

Gruppen-Header (OFFEN / ERLEDIGT):
  Padding:        9px 20px 4px
  Label:          10px / 700 / uppercase / letter-spacing:0.10em
  OFFEN-Farbe:    #1D6FE8
  ERLEDIGT-Farbe: #14A87C
  Linie:          flex:1, height:1px, background:#EEEEE9

Topic-Card (offen):
  Padding:        12px 20px
  Border-bottom:  1px solid #F3F3EF
  Left-Accent:    3px, background:#BABCD4 (open), position absolute
  Status-Kreis:   17×17px, border-radius:50%, border 1.5px solid #BABCD4
  Titel:          14px / 600 / #111210 / letter-spacing:-0.015em
  Beschreibung:   12px / 400 / #9A9890 / line-height:1.5
  "Als erledigt": padding 4px 8px, border 1px solid #E8E7E2, bg white,
                  border-radius:5px, 11px / 400 / #888880
  Mehr-Button:    drei Punkte SVG, color:#C0BEB8

Topic-Card (erledigt):
  Background:     #FAFDFB
  Left-Accent:    3px, background:#14A87C
  Status-Kreis:   17×17px, border-radius:50%, background:#14A87C, Checkmark-SVG white
  Titel:          14px / 600 / #ABABAB / line-through / text-decoration-thickness:1.5px
  Sub-Text:       12px / #C8C6C2

Topic-Card (schlafend):
  Background:     #F8FAFC (leicht blau-grau)
  Left-Accent:    3px, background:#94A3B8 (!)
  Status-Kreis:   border 1.5px solid #94A3B8, Schlaf-Icon
  Titel:          color var(--text-muted)
```

### Buttons

```css
/* Primär */
.btn-primary {
  background: #1D6FE8;
  color: white;
  box-shadow: 0 1px 2px rgba(29,111,232,.3), inset 0 1px 0 rgba(255,255,255,.12);
}
.btn-primary:hover:not(:disabled) {
  background: #1560CC;
  box-shadow: 0 3px 10px rgba(29,111,232,.35);
}

/* Sekundär (im Modal-Footer) */
.modal-footer .btn-secondary {
  background: white;
  border: 1px solid #E0DED9;
  color: #3A3830;
}

/* AI-Button */
.btn-ai {
  background: linear-gradient(135deg, #1D6FE8, #7C3AED);
  color: white;
  border: 0;
}
```

### Badges / Pills

```
Offen:     bg rgba(29,111,232,.12)  / color #1D6FE8 / font 11.5px 600
Erledigt:  bg #F0FDF8 / border #BBF7D0 / color #14A87C
Admin:     bg #F0EEF5 / border #E9D5FF / color #7C3AED
Datum OK:  bg rgba(20,185,129,.15) / color #6ee7b7
Datum alt: bg rgba(245,158,11,.15) / color #fcd34d
Überfällig: bg #FEF3C7 / color #92400E / border #FDE68A
Schlafend: bg #F1F5F9 / border #E2E8F0 / color #64748B
```

### Stack-Panel (floating)

```
Position:       fixed, right:16px, bottom:16px, z-index:30
Width:          284px
Background:     white
Border:         1px solid #E8E7E2
Border-radius:  12px
Shadow:         var(--shadow-md)

Header:
  Padding:      9px 12px
  Border-bottom: 1px solid #F0F0EB
  Stack-Icon:   color #1D6FE8
  Titel:        12.5px / 700 / #1A1918
  Badge:        bg #1D6FE8 / white / padding 1px 7px / border-radius 100px

Aktiver Frame:
  Border:       1.5px solid #1D6FE8
  Border-radius: 8px
  Background:   rgba(29,111,232,.04)
  Padding:      8px 10px
```

### Modal

```
Border-radius:  16px  (war: 18px)
Box-shadow:     var(--shadow-xl)

Header:
  Padding:      18px 22px
  Border-radius: 16px 16px 0 0
  Titel:        17px / 700 / letter-spacing:-0.025em

Close-Button:
  Width/Height: 28px
  Border-radius: 6px
  Color:        var(--text-muted)
  Hover:        background var(--bg)

Footer:
  Padding:      14px 22px
  Border-radius: 0 0 16px 16px
```

### Formularfelder

```
.form-control:
  Padding:      9px 12px  (war: 0.5625rem 0.8125rem)
  Border:       1.5px solid #E0DED9
  Border-radius: 7px  (war: 9px)
  Font:         14px

.form-control:focus:
  Border-color: #1D6FE8
  Box-shadow:   0 0 0 3px rgba(29,111,232,.10)

.form-label:
  Font:         12.5px / 600 / #2A2826

.form-hint:
  Font:         11.5px / #9A9890
```

---

## Spacing-Referenz

| Token | Wert | Verwendung |
|---|---|---|
| xs | 4px | Icon-Gaps, Pill-Padding vertikal |
| sm | 8px | Element-Gaps, Button-Padding intern |
| md | 12px | Padding in kompakten Komponenten |
| lg | 16px | Standard-Padding in Karten |
| xl | 20–24px | Card-Padding, Sectionen |
| 2xl | 28–32px | Main-Content-Padding |

---

## Border-Radius

| Token | Wert | Verwendung |
|---|---|---|
| — | 5px | Kleine Aktions-Buttons (Topic-Card) |
| `--r` | 8px | Buttons, Inputs, kleine Elemente |
| — | 8px | Sidebar-Meeting-Einträge |
| `--r-lg` | 12px | Hauptkarten (Meeting-Header, Topics) |
| — | 16px | Modals |

---

## Schatten

```css
--shadow-xs: 0 1px 2px rgba(16,22,30,.05), 0 0 0 1px rgba(16,22,30,.06);
--shadow-sm: 0 2px 6px rgba(16,22,30,.08), 0 1px 2px rgba(16,22,30,.05);
--shadow-md: 0 6px 20px rgba(16,22,30,.12), 0 2px 6px rgba(16,22,30,.06);
--shadow-lg: 0 16px 40px rgba(16,22,30,.16), 0 4px 12px rgba(16,22,30,.08);
--shadow-xl: 0 24px 56px rgba(16,22,30,.20), 0 8px 16px rgba(16,22,30,.08);
```

---

## Umsetzungsreihenfolge (empfohlen)

1. **`:root {}` ersetzen** — sofortiger visueller Unterschied, 5 Minuten
2. **Schrift tauschen** — Inter → DM Sans, DM Mono für Datum-Elemente
3. **Navbar entfernen** — Logo/User in Sidebar, neue `.topbar` im Main
4. **Border-Radius vereinheitlichen** — `--r: 8px`, `--r-lg: 12px`
5. **Emoji → SVG-Icons** — Lucide Icons empfohlen (https://lucide.dev)
6. **Topbar einfügen** — Breadcrumb + AI-Badge, 52px, sticky
7. **Modal-Radii** — `18px → 16px`, Padding leicht anpassen
8. **DM Mono** für `.meeting-item-sub`, `.result-date`, `.due-badge`

---

## Assets

- **Schrift:** Google Fonts — DM Sans + DM Mono (kein Download nötig, CDN-Import)
- **Icons:** Keine externen Dateien — inline SVGs. Quelle: https://lucide.dev (1.5px Stroke, Viewbox 24×24, im Code auf 12–16px skalieren)
- **Bilder:** Keine

---

## Design-Referenz-Datei

`ThreadStack UI Redesign.html` — enthält alle drei Varianten (A, B, C) sowie das vollständige Design System als visuelle Referenz. Im Browser öffnen und nach rechts scrollen.

**Variante A** ist die im README spezifizierte Ziel-Variante.
