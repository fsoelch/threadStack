---
name: pattern-backup-restore-double-fault
description: Wiederkehrendes Antipattern bei automatischen Recovery-/Revert-Pfaden - ein fehlschlagender Revert-VERSUCH wird faelschlich wie ein erfolgreicher gemeldet
metadata:
  type: project
---

Gefunden im DB-Backup/Restore-Feature (Arbeitspaket B1, lib/backup/restore.js#
restoreFromFile), Schweregrad Hoch: Wenn eine Restore-Transaktion committet,
aber danach eine Integritaetspruefung (foreign_key_check) anschlaegt, versucht
der Code automatisch, den vorherigen Zustand aus einem Sicherheits-Backup
wiederherzustellen (Revert). Der urspruengliche Code meldete IMMER
`reverted:true`, sobald ein Revert-VERSUCH stattfand - auch wenn dieser
zweite Kopiervorgang SELBST warf (z.B. Backup-Datei waehrend des Laufs
beschaedigt/entfernt). Ein Admin haette dadurch fehlerhaft angenommen, die
Daten seien wieder im sicheren Ausgangszustand, obwohl die Live-DB tatsaechlich
im kaputten Zwischenzustand des gescheiterten Restores verharrte - potenziell
folgenreicher Datenverlust ohne Warnung.

**Fix-Muster:** einen expliziten Erfolgs-Flag (`revertSucceeded`) INNERHALB
des try-Blocks auf `true` setzen, NICHT im catch/finally annehmen. Drei
Zustaende statt zwei boolesche Werte unterscheiden ('unchanged' - nichts
committet, automatischer Rollback; 'reverted' - committet UND erfolgreich
zurueckgesetzt; 'needs_manual_recovery' - committet UND Revert-Versuch
scheiterte ebenfalls). Das dritte, gefaehrlichste Szenario braucht eine
eigene, deutlich alarmierendere Nutzermeldung inkl. Verweis auf die konkrete
Sicherheits-Backup-Datei fuer eine manuelle Wiederherstellung.

**Allgemein uebertragbar:** bei JEDEM "automatischer Recovery nach Fehler"-
Code (Retry, Rollback, Revert, Cleanup-nach-Fehler) IMMER pruefen, ob der
Recovery-Schritt selbst fehlschlagen kann, und ob dieser Fehlerfall separat
vom "alles gut"-Fall signalisiert wird - ein pauschales "Versuch unternommen
= Erfolg angenommen" ist ein wiederkehrendes, gefaehrliches Muster.

Zusaetzlicher Fund im selben Review (Mittel): Binaer-Uploads, die vor der
eigentlichen Verarbeitung zwischengespeichert werden muessen (hier:
Restore-Datei-Upload), NIE nach `os.tmpdir()` schreiben - das ist ein
systemweit GETEILTES Verzeichnis, nicht das app-eigene Datenverzeichnis.
Stattdessen einen Temp-Namen INNERHALB des ohnehin app-eigenen Zielordners
verwenden (Praefix, der garantiert nie mit dem eigentlichen Dateinamensmuster
kollidiert), plus restriktiven `mode` beim Schreiben (0600).
