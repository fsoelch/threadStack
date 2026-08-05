# Projektstandards fuer das Agenten-Team

Diese Datei gilt fuer ALLE Agenten (requirements-engineer, architect, ux-designer,
developer, security-reviewer, tester). Sie ergaenzt die jeweilige Rollenbeschreibung
und hat bei Konflikten Vorrang, da sie projektweite Konsistenz sicherstellt.

## Grundprinzipien

- Explizit statt implizit: Annahmen werden immer sichtbar gemacht, nie stillschweigend
  getroffen, wenn sie das Ergebnis wesentlich beeinflussen.
- Vertraege sind bindend: Schnittstellenvertraege des architect duerfen von
  developer-Agenten nicht eigenmaechtig geaendert werden. Abweichungen werden
  gemeldet, nicht heimlich umgesetzt.
- Eigentuemerschaft respektieren: Jeder Agent bleibt innerhalb der ihm zugewiesenen
  Dateien/Verantwortung. Wer eine Aenderung außerhalb fuer noetig haelt, meldet das,
  statt es selbst zu tun.
- Sicherheit ist keine Nachbesserung: Eingabevalidierung, sichere Fehlerbehandlung
  und der Umgang mit Secrets sind von Anfang an Teil der Umsetzung, nicht ein
  spaeterer Schritt.

## Sicherheits-Baseline (gilt fuer architect, developer, security-reviewer)

- Keine Secrets, API-Keys oder Zugangsdaten im Code, in Kommentaren oder in
  Testdaten. Konfiguration ueber Umgebungsvariablen oder einen Secret-Manager.
- Jede Eingabe von außerhalb der Vertrauensgrenze wird validiert: User-Input,
  API-Responses externer Dienste, Datei-Uploads, Umgebungsvariablen.
- Datenbankzugriffe ausschließlich parametrisiert.
- Fehlermeldungen an Endnutzer enthalten keine internen Details (Stacktraces,
  interne Pfade, Datenbankfehler im Klartext).
- Logs enthalten keine sensiblen Daten (Passwoerter, Tokens, personenbezogene Daten
  im Klartext).
- Neue Abhaengigkeiten nur mit kurzer Begruendung, keine Bibliotheken aus unklarer
  Quelle.

## Definition of Done (fuer developer-Arbeitspakete)

Ein Arbeitspaket gilt erst als fertig, wenn:
1. Der Schnittstellenvertrag vollstaendig implementiert ist (oder Abweichung
   dokumentiert wurde).
2. Alle zugehoerigen Akzeptanzkriterien durch Tests abgedeckt sind, inklusive
   Fehler-/Randfaelle.
3. Alle Tests gruen sind.
4. Der Sicherheitscheck aus der Developer-Rollenbeschreibung durchgefuehrt wurde.
5. Der Abschlussbericht im vorgegebenen Format vorliegt.

## Kommunikation zwischen Agenten

- Jeder Agent liefert seinen Output im in der jeweiligen Rollenbeschreibung
  definierten Format - das ist die Schnittstelle zum naechsten Agenten im Workflow.
- Wenn ein Agent auf Basis des Outputs eines vorherigen Agenten eine Luecke oder
  einen Widerspruch findet: das explizit benennen, nicht kommentarlos ueberschreiben
  oder ignorieren.

## Eskalation an den Menschen

Ein Agent unterbricht den Workflow und fragt den Menschen aktiv, wenn:
- eine Anforderung an einer Stelle mehrdeutig ist, die grundlegende Architektur-
  oder Sicherheitsentscheidungen beeinflusst,
- ein kritischer Sicherheitsfund nach einer Nachbesserung weiterhin besteht,
- der Tester nach einer Korrekturschleife weiterhin No-Go meldet.

In allen anderen Faellen arbeitet das Team den Workflow selbststaendig bis zur
Ergebnispraesentation durch.
