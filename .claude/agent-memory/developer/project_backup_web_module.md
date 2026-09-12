---
name: project-backup-web-module
description: Implementierungsdetails/Fallstricke des DB-Backup/Restore-Web-Frontends (public/backup.js, Arbeitspaket B3) - Referenz fuer aehnliche Admin-Feature-Panels oder Binaer-Upload/Download aus einem Host-Modul
metadata:
  type: project
---

- `TSHost.confirm({title,message,confirmLabel,cancelLabel})` reichte VOR
  diesem Paket `danger`/`focus`-Optionen von `genericConfirm()` NICHT durch
  (obwohl `genericConfirm` sie seit langem unterstuetzt) - kein Konsument
  brauchte bislang den destruktiven Stil ueber den Host-Vertrag. Fuer
  Restore/Delete-Bestaetigungen minimal, rueckwaertskompatibel erweitert
  (`danger`/`focus` als zusaetzliche, optionale Felder). Bei kuenftigen
  "gefaehrliche Aktion bestaetigen"-Anforderungen aus einem public/*.js-
  Modul: diese bereits erweiterte Signatur nutzen, nicht erneut pruefen/
  patchen.
- TSHost hatte VOR diesem Paket keinen Weg fuer (a) rohe Binaer-Uploads aus
  einem public/*.js-Modul (nur JSON via `api()`) und (b) ein aktives
  Erzwingen des Sitzungsende-Screens ausserhalb einer echten 401-Antwort
  (Restore invalidiert Sitzungen SERVERSEITIG, der aktuelle Tab weiss das
  nicht automatisch). Ergaenzt: `TSHost.uploadRaw(path, file)` (analog `api()`,
  aber `Content-Type: file.type`, Body = File-Objekt, gleiches err.status/
  code/body-Envelope) und `TSHost.forceLogout()` (ruft die bestehende
  `handleSessionExpiry()` auf). Beide sind duenne Wrapper um bereits
  bestehende interne app.js-Funktionen/Patterns (rohe fetch()-Uploads gab es
  schon bei Attachments), keine neue Logik.
- Datei-Downloads aus einem public/*.js-Modul brauchen KEINEN
  Fetch/Blob-Umweg: ein simples `<a href="${base}/api/.../download"
  download="...">` reicht, weil der Server per `Content-Disposition:
  attachment` antwortet und der Browser das mit vorhandenen Session-Cookies
  (`credentials` implizit "same-origin" bei normaler Navigation) selbst
  handled - identisches Muster wie der bestehende Attachment-Download-Link
  in app.js. `runExport()`s Fetch+Blob-Pattern (app.js) ist nur noetig, wenn
  der Request-Body selbst dynamisch ist (POST) oder ein Ladezustand/Busy-
  Button waehrend des Downloads gebraucht wird - fuer einen reinen GET-Link
  ist das unnoetiger Overhead.
- Admin-Panel-Modals mit einem gemounteten Handle (wie `TSBackup.mount()`,
  analog `contactDetailHandle`) muessen an DREI Stellen denselben
  destroy()-Pfad durchlaufen, nicht nur den ×-Button: `overlayClick()`
  (Klick auf Hintergrund) und den globalen Escape-Handler - beide haben
  je eine eigene Sonderfall-Liste (`if (id === 'contact-modal') ...`), in
  die ein neues Modal mit eigenem Handle EXPLIZIT eingetragen werden muss,
  sonst wird nur `style.display='none'` gesetzt und das Handle bleibt an
  einem detached DOM-Host haengen (kein Crash, aber Leak/Karteileiche).
