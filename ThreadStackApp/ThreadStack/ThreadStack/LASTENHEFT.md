# Lastenheft – ThreadStack App

**Projekt:** ThreadStack Mobile & Desktop Client  
**Plattformen:** iOS (iPhone/iPad) · macOS  
**Stand:** Mai 2026  
**Auftraggeber:** Florian Soelch  

---

## 1. Ausgangssituation und Zielsetzung

ThreadStack ist ein webbasiertes Meeting- und Aufgabenmanagementsystem, das auf einem selbst betriebenen Server läuft. Ziel dieses Projekts ist die Entwicklung einer nativen Client-App für iOS und macOS, die vollständige Feature-Parität mit der Web-Applikation bietet und eine optimale Nutzungserfahrung auf Apple-Geräten ermöglicht.

Die App kommuniziert ausschließlich mit der REST-API des ThreadStack-Servers und speichert keine Daten lokal (außer Sitzungs-Cookies und Benutzereinstellungen).

---

## 2. Zielgruppe

- Privatpersonen und kleine Teams, die ThreadStack zur Meeting-Vorbereitung und -Nachbereitung einsetzen
- Nutzer des selbst betriebenen ThreadStack-Servers unter `soelch.com/threadStack`
- Primär macOS-Nutzer, ergänzend iPhone-Nutzer unterwegs

---

## 3. Systemübersicht

```
┌─────────────────────┐         HTTPS/REST         ┌──────────────────────┐
│   ThreadStack App   │ ◄─────────────────────────► │  ThreadStack Server  │
│  (iOS / macOS)      │     JSON · Cookie-Auth       │  soelch.com/...      │
└─────────────────────┘                             └──────────────────────┘
```

### Technische Rahmenbedingungen

- **Sprache:** Swift / SwiftUI (Multiplatform)
- **Mindest-iOS:** iOS 17
- **Mindest-macOS:** macOS 14 (Sonoma)
- **Authentifizierung:** Session-Cookie (serverseitig gesetzt nach Login)
- **Kein Apple Developer Account erforderlich** für den Betrieb auf eigenen Geräten

---

## 4. Funktionale Anforderungen

### 4.1 Authentifizierung

| ID | Anforderung |
|----|-------------|
| A01 | Der Nutzer kann die Server-URL einmalig konfigurieren. |
| A02 | Der Nutzer kann sich mit Benutzername und Passwort anmelden. |
| A03 | Die Sitzung wird nach erfolgreichem Login persistent (Cookie) gespeichert und beim nächsten App-Start automatisch wiederhergestellt. |
| A04 | Der Nutzer kann sich abmelden. |
| A05 | Bei abgelaufener Sitzung wird der Nutzer automatisch zur Login-Ansicht weitergeleitet. |
| A06 | Der Nutzer kann sein Passwort über die Einstellungen ändern. |

### 4.2 Meetings

| ID | Anforderung |
|----|-------------|
| M01 | Alle Meetings werden als Liste in der Seitenleiste angezeigt. |
| M02 | Ein Meeting zeigt Titel, Farbe, Teilnehmer, nächsten Termin und Anzahl offener Themen. |
| M03 | Meetings können angelegt werden (Titel, Beschreibung, Teilnehmer, Farbe, Datum, Wiederholung). |
| M04 | Meetings können bearbeitet werden. |
| M05 | Meetings können gelöscht werden. |
| M06 | Vergangene Meeting-Termine werden farblich hervorgehoben (orange). |
| M07 | Wiederkehrende Meetings (wöchentlich, zweiwöchentlich, monatlich) werden unterstützt. |
| M08 | Das Datum eines wiederkehrenden Meetings kann per Knopfdruck auf den nächsten Termin vorgerückt werden. |
| M09 | Meetings können über ein Suchfeld gefiltert werden. |

### 4.3 Themen (Topics)

| ID | Anforderung |
|----|-------------|
| T01 | Innerhalb eines Meetings werden alle Themen in drei Sektionen angezeigt: Offen · Schlafend · Erledigt. |
| T02 | Ein Thema zeigt Titel, Beschreibung, Status-Icon, zugewiesene Topics und Verlinkungen zu anderen Meetings. |
| T03 | Themen können angelegt, bearbeitet und gelöscht werden. |
| T04 | Themen können als erledigt markiert werden (mit optionalem Ergebnis-Text und Datum). |
| T05 | Erledigte Themen können wieder geöffnet werden. |
| T06 | Themen können in den Schlaf-Modus versetzt werden (mit Aufweck-Datum). |
| T07 | Schlafende Themen werden visuell gedimmt und mit Aufweck-Datum angezeigt. |
| T08 | Themen können per Drag-and-Drop innerhalb der offenen Sektion neu sortiert werden. |
| T09 | Themen können in ein anderes Meeting verschoben werden. |
| T10 | Themen können mit anderen Meetings geteilt werden (Verknüpfung via Group-ID). |
| T11 | Themen können als Todo markiert werden (Pin-Icon). |
| T12 | Themen können mit Topics (Themenbereichen) verknüpft werden. |

### 4.4 Todos

| ID | Anforderung |
|----|-------------|
| D01 | Alle eigenen Todos werden in einer separaten Ansicht angezeigt (Offen · Schlafend · Erledigt). |
| D02 | Todos können angelegt, bearbeitet und gelöscht werden. |
| D03 | Todos können als erledigt markiert werden (mit Ergebnis und Datum). |
| D04 | Erledigte Todos können wieder geöffnet werden. |
| D05 | Todos können in den Schlaf-Modus versetzt werden. |
| D06 | Todos können in ein Meeting verschoben werden. |
| D07 | Todos können mit Topics verknüpft werden. |
| D08 | Die Anzahl offener Todos wird als Badge in der Seitenleiste angezeigt. |

### 4.5 Topics (Themenbereiche)

| ID | Anforderung |
|----|-------------|
| P01 | Alle Topics werden in einer separaten Ansicht als Karten angezeigt. |
| P02 | Eine Topic-Karte zeigt Titel, Beschreibung und alle verknüpften Themen/Todos. |
| P03 | Topics können angelegt, bearbeitet und gelöscht werden. |
| P04 | Topics können mit Themen und Todos verknüpft und diese Verknüpfungen wieder gelöst werden. |

### 4.6 Einstellungen

| ID | Anforderung |
|----|-------------|
| E01 | Der Nutzer kann die Server-URL einsehen und ändern. |
| E02 | Der Nutzer kann die Schriftgröße über einen Slider (7 Stufen: XS bis XXXL) anpassen. |
| E03 | Die gewählte Schriftgröße wird persistent gespeichert und sofort angewendet. |
| E04 | Der Nutzer kann sein Passwort ändern. |

### 4.7 Administration

| ID | Anforderung |
|----|-------------|
| V01 | Administratoren haben Zugriff auf eine Benutzerverwaltung. |
| V02 | Neue Nutzer können angelegt werden (Benutzername, Passwort, Admin-Rolle). |
| V03 | Bestehende Nutzer können gelöscht werden. |

---

## 5. Nicht-funktionale Anforderungen

| ID | Anforderung |
|----|-------------|
| N01 | Die App ist ohne bezahltes Apple-Developer-Konto auf eigenen Geräten lauffähig. |
| N02 | Alle Netzwerkanfragen erfolgen verschlüsselt über HTTPS. |
| N03 | Die App verhält sich auf macOS und iOS nativ — plattformspezifische UI-Konventionen werden eingehalten. |
| N04 | Fehlerzustände (Netzwerkfehler, abgelaufene Sitzung) werden dem Nutzer verständlich kommuniziert. |
| N05 | Die App startet ohne Wartezeit und stellt die zuletzt aktive Ansicht wieder her. |
| N06 | Schriftgröße und Server-URL bleiben App-Updates erhalten (AppStorage). |

---

## 6. Abgrenzung (nicht im Scope)

- Offline-Betrieb oder lokale Datenspeicherung
- Push-Benachrichtigungen
- Kollaboration in Echtzeit (kein WebSocket)
- App-Store-Veröffentlichung
- Nutzer-Registrierung (nur Admin kann Nutzer anlegen)
- Datei-Anhänge

---

## 7. Plattformspezifische Anforderungen

### macOS
- Zwei-Spalten-Layout: Seitenleiste (Meetings, Topics, Todos) + Detailbereich
- Kein NSToolbar (Stabilitätsgründe) — Aktionen über inline-Buttons
- Suchfelder sind direkt in der Liste eingebettet (kein `.searchable`)
- Gear-/Admin-/Logout-Buttons in der Fußzeile der Seitenleiste

### iOS
- NavigationSplitView mit Suchleiste
- Swipe-Aktionen auf Listeneinträgen (Löschen, Erledigen, Schlafen)
- Kontextmenü per Langtipp
- Pull-to-Refresh

---

## 8. Datenmodell (Übersicht)

| Entität | Schlüsselfelder |
|---------|----------------|
| `Meeting` | id, title, description, participants[], color, nextDate, isRecurring, recurrencePattern, topics[] |
| `Topic` | id, title, description, done, result, resultDate, isTodo, snoozedUntil, groupId, sortOrder |
| `TodoItem` | id, title, description, done, result, resultDate, snoozedUntil |
| `Theme` | id, title, description |
| `ThemeLink` | id, themeId, refType (topic/todo), refId |
| `AppUser` | id, username, role |

---

## 9. Abnahmekriterien

- [ ] Login und Sitzungs-Wiederherstellung funktionieren zuverlässig
- [ ] Meetings, Themen und Todos können vollständig verwaltet werden (CRUD)
- [ ] Schlafen/Aufwecken funktioniert korrekt (Datum-Vergleich)
- [ ] Schriftgrößen-Slider wirkt sich sofort auf alle Listenansichten aus
- [ ] App läuft stabil auf macOS ohne Abstürze (insb. kein NSCalendarDate-Crash)
- [ ] App läuft auf iPhone (iOS 17+)
- [ ] App-Icon ist auf beiden Plattformen korrekt gesetzt
