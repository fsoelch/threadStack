- [Design-System-Muster ThreadStack](design_system_patterns.md) — Modal/RT-Editor/TSProgress/Theme-Link/Confirm/Suche-Konventionen (Web+iOS), inkl. bekannter Luecken (Reorder nur Drag&Drop, Progress-Head-Zeile unconditional).

## Sitzungsende-Hinweis Web (2026-09-11)
- Fuer neue Hinweistexte auf dem Login-Screen die bestehende `.form-error`-Klasse
  (role="alert", bereits genutzt von `#login-error`) wiederverwenden statt eine
  neue Banner-Optik einzufuehren.

## Admin-only Feature-Screens (2026-09-12, Backup/Restore)
- Admin-only Features bekommen einen eigenen Menuepunkt im `#user-menu`
  (gleiches `display:none`-Toggle-Pattern wie `user-menu-admin`), nicht
  einen zusaetzlichen Tab im bestehenden `admin-modal` - es gibt im Projekt
  KEIN Tab-Komponenten-Muster innerhalb eines Modals, nur mehrere Modals ueber
  eigene Menuepunkte (Konsistenz mit AI-Einstellungen/Export/Benutzerverwaltung).
- `genericConfirm(title, message, confirmLabel, cancelLabel, {danger:true,
  focus:'cancel'})` ist der bestehende Bestaetigungsdialog fuer hochriskante
  Aktionen (Restore/Delete) - reiner Klartext, KEIN "Tippe X zum Bestaetigen"-
  Eingabefeld im Projekt vorhanden. Bei "besonders destruktiv" stattdessen auf
  `focus:'cancel'` + ausgeschriebene Konsequenzen im Message-Text setzen.
