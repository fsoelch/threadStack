---
name: threadstack-web-module-konventionen
description: Bestandsmuster fuer eigenstaendige Frontend-Module unter public/ (TSHost-Adapter, BASE_PATH, Modal-Chrome, initRtToolbar), gegen die jedes neue Web-Arbeitspaket zu pruefen ist
metadata:
  type: project
---

Fuer Reviews von Arbeitspaketen, die ein neues Modul unter `public/` anlegen
(Muster: `progress.js`/`progress.css`/`progress-dev.html`, `graph.js`, `contacts.js`).

**Why:** Diese Module entstehen isoliert im Worktree, ohne dass `index.html`/`app.js`
mitgeliefert werden. Der developer sieht die Host-Konventionen daher nicht automatisch
und baut Netzwerkzugriff, Dialoge und Editor-Anbindung neu — jedes Mal an denselben
drei Stellen.

**How to apply:** Bei jedem neuen/erweiterten `public/*.js`-Modul gezielt greppen:

- **API-Basispfad ist real, nicht hypothetisch.** `server.js` setzt
  `const BASE = (process.env.BASE_PATH || '/notes')` und mountet alle Routen unter
  `const A = BASE + '/api'`; `deploy.sh` nutzt denselben Default `/notes`. `app.js`
  spiegelt das mit `_path`/`API`. Direkte `fetch('/api/...')`-Aufrufe in einem Modul
  sind damit im Produktions-Default **immer kaputt**, nicht nur "unter einem Proxy".
  Bestandsloesung: `window.TSHost.api(method, path, body)` — die Implementierung in
  `app.js` strippt ein fuehrendes `/api` und setzt `_path + '/api'` davor, d.h. Module
  duerfen ihre URL-Helfer unveraendert mit `/api/...` bauen. `progress.js#fetchDetail`
  ist das Referenz-Idiom (inkl. `getHost()`-Guard); `*-dev.html` mockt `window.TSHost`.
- **Dialoge gehoeren dem Host.** `index.html` definiert `.modal-overlay`, `.modal`,
  `.modal-header/-body/-footer`, `.modal-close`. `progress.js` und `graph.js` bauen
  bewusst KEIN eigenes Modal, sondern nutzen `TSHost.confirm` bzw. Host-Dialoge. Ein
  Modul mit eigenem `<prefix>-modal*`-Chrome erzeugt eine zweite Dialog-Optik und
  verstoesst gegen die Wiederverwendungsregel aus CLAUDE.md.
- **`initRtToolbar(tbId, editorId)`** wird in `app.js` genau einmal beim Init fuer eine
  feste Liste statischer Editor-IDs aufgerufen und fuellt die Toolbar per
  `tb.append(...items)` **ohne vorheriges Leeren**. Dynamisch erzeugte Editoren
  brauchen einen expliziten Init-Hook; ihn implizit als Seiteneffekt in den
  `setRT`-Adapter zu haengen funktioniert zwar, ist aber undokumentiert und bricht,
  sobald `setRT` mehrfach auf demselben Element laeuft.
- **Modal-Detailmuster:** `index.html` nutzt in `.modal-header` durchgehend `<h2>`
  (nur `.modal-header h2` ist gestylt) und wickelt Inhalt IMMER in `.modal-body`
  (dort sitzt das gesamte Padding). Ein Dialog, der die Bestandsklassen zwar
  verwendet, aber `h3` nimmt oder `.modal-body` weglaesst, sieht trotzdem anders aus
  als der Rest — beim Nachpruefen eines "Modal-Chrome"-Fixes explizit auf beides
  achten, nicht nur auf `.modal-overlay`/`.modal`.
- **Response-Shapes gegen den Backend-Worktree pruefen, nicht gegen den Vertragstext.**
  Frontend- und Backend-Pakete desselben Features entstehen in getrennten Worktrees;
  Envelope (`{items,page,counts}` vs. flaches Array), Feldnamen und
  Query-Parameter-Grenzen (z.B. `limit<=50`) driften regelmaessig auseinander. Bei
  jedem Web-Paket, das neue Endpunkte konsumiert: den zugehoerigen Backend-Worktree
  oeffnen und Route fuer Route vergleichen. Besonders gefaehrlich sind Dialoge, die
  eine Vorbelegung per GET laden und beim Speichern per PUT die VOLLSTAENDIGE Liste
  ueberschreiben — ein stillschweigend fehlgeschlagener Prefill loescht dann beim
  ersten "Fertig" alle Bestandsdaten.
- **Lokales `escHtml` pro Modul ist Konvention**, kein Duplikat-Fund — `progress.js`
  macht das genauso. Ebenso die `module.exports`-no-undef-Warnung von eslint.
  Achtung: der `el(tag, attrs, html)`-Helfer setzt den dritten Parameter per
  `innerHTML` — jede Interpolation dort MUSS durch `escHtml`.

- **Der `*-dev.html`-Mock ist Teil des Response-Shape-Fixes.** Jedes Modul hat eine
  eigenstaendige Testseite (`contacts-dev.html`, `progress-dev.html`, `graph-dev.html`)
  mit einem handgeschriebenen `window.TSHost.api`-Mock. Wird ein Response-Shape in
  `public/<modul>.js` an das echte Backend angepasst, bleibt dieser Mock erfahrungs-
  gemaess auf dem alten Format stehen — die Unit-Tests bleiben gruen (eigene Mocks),
  aber die einzige manuelle Pruefflaeche zeigt danach stumm einen Leerzustand und
  reproduziert genau die Divergenz, die der Fix beseitigen sollte. Bei jedem
  Shape-/Feldnamen-/Query-Parameter-Fix daher zwingend mitpruefen:
  `grep -n "<altes Feld>\|<alter Parameter>" public/*-dev.html`.
- **Fail-closed-Guards brauchen einen Test, der den Guard selbst trifft.** Bei
  "Button disabled + Guard in der Speicherfunktion" reicht ein `dispatchEvent('click')`
  auf den deaktivierten Button: jsdom ruft Listener auf disabled-Elementen sehr wohl
  auf (verifiziert), der Test prueft also wirklich den Guard und nicht nur das
  `disabled`-Attribut. Sauberer ist trotzdem eine explizite Assertion auf die
  aufgezeichnete Call-Liste ("kein PUT") statt eines Proxys wie "Dialog bleibt offen".

- **Host-Integrations-Pakete (app.js/index.html verdrahten ein fertiges
  `public/<modul>.js`) haben drei wiederkehrende Schwachstellen**, die ein
  gruener Testlauf nicht zeigt:
  1. **`onClickAttr`-/Attribut-Callbacks des Moduls delegieren das Escaping
     explizit an den Host** ("Host ist verantwortlich fuer Escaping innerhalb
     des zurueckgegebenen Fragments"). Der Host liefert dann typischerweise
     `` `onclick="...doX('${c.someId}')"` `` ohne jedes Escaping. Nachweisbar per
     jsdom mit einer Id wie `x" onmouseover="__PWN__=1` — das Attribut bricht
     wirklich auf. Meist ist die Id serverseitig generiert (kein aktiver
     Angriffsweg), aber es bleibt ein Konsistenz-/Robustheitsfund.
     **Die richtige Bestandsloesung ist `escJsAttr(s)` (app.js ~Z.909)**, das
     `[\\'"<>&\n\r]` in `\uXXXX` uebersetzt — diese Escapes ueberleben die
     HTML-Entity-Dekodierung des Attributwerts und sind daher zugleich HTML- und
     JS-sicher (Vorbilder: `confirmDeleteTheme`, `confirmDeleteKnowledge`,
     `confirmDeleteUser`, `confirmPermanentlyDeleteMeeting`).
     **Achtung, haeufiger Fehlgriff:** `escHtml(x).replace(/'/g,"\\'")` sieht wie
     die Bestandskonvention aus, ist aber WIRKUNGSLOS — `escHtml` hat `'` bereits
     zu `&#039;` gemacht, das `replace` findet nichts mehr, und der HTML-Parser
     dekodiert `&#039;` zurueck zu `'`, BEVOR der Attributinhalt als JS geparst
     wird. Das String-Literal bricht also trotzdem auf. Dieses Antipattern steht
     noch an mindestens einer Stelle in `public/app.js` (`renderContactCard` ->
     `confirmDeleteContact('${c.id}', '${escHtml(c.name)...}')`, seit `main`, dort
     mit dem nutzergesteuerten Feld `c.name`) — bei jedem Review greppen:
     `grep -n 'escHtml([^)]*)\.replace(/./g' public/*.js`.
     Belastbarer Regressionstest dafuer: Wert mit `x'); window.__pwned=1; ('`
     rendern, Chip in jsdom klicken, `window.__pwned === undefined` UND
     `empfangeneId === originalId` pruefen (zweite Assertion verhindert einen
     vakuum-gruenen Test, falls der Inline-Handler gar nicht erst feuert).
  2. **`TSHost.openObject(type, id, meta)` deckt todo/topic/contact bereits
     ab.** Neue Navigations-Helfer im Host bauen die contact-Zeile
     (`selectView('__contacts__'); openContactModal(id)`) gern ein zweites Mal
     nach — obwohl dasselbe Paket fuer todo/topic korrekt `openObject`
     benutzt. Immer `grep -n "openObject" public/app.js` gegenlesen.
  3. **`findTopicAnywhere(tid)` durchsucht NUR die aktive `meetings`-Liste**;
     archivierte Meetings sind dort nicht enthalten. Ein daraus abgeleitetes
     `archived: !!found.meeting.archived` ist deshalb beweisbar immer `false`
     und der Archiv-Nur-Lese-Zweig von `openObject` unerreichbar.
- **Wird ein statisches Editor-Feld aus index.html entfernt, bleibt seine Id in
  der `initRtToolbar`-Init-Liste am Ende von app.js stehen** (Muster
  `['m-desc','t-desc',...,'contact-desc'].forEach(id => initRtToolbar(id+'-tb', id))`).
  `initRtToolbar` null-guarded, es kracht also nicht — die verwaiste Id
  ueberlebt aber jede Behauptung "keine verwaisten Referenzen". Ebenso bleibt
  die zugehoerige CSS-Regel (`.contact-card-desc`) als toter Block zurueck.
- **Vier Schliesswege pro Dialog pruefen, nicht einen:** `×`, Footer-Button,
  `overlayClick()`, globaler Escape-Handler. Wandert ein Modal aus dem
  Escape-Bulk-Hide (`[...].forEach(id => el.style.display='none')`) in einen
  eigenen `closeX()`-Pfad, ist das fuer die uebrigen Modals unschaedlich, aber
  ein Test, der nur `window.closeX()` direkt aufruft, belegt den Vertrag
  "feuert bei JEDEM Schliessweg genau einmal" nicht. In jsdom sind alle vier
  billig nachstellbar (`.modal-close`/`.modal-footer .btn-secondary` klicken,
  `overlay.dispatchEvent(new MouseEvent('click',{bubbles:true}))`,
  `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`).
  Achtung: `overlayClick()` hat einen `hasText`-Guard ueber
  `input[type=text|email], textarea, .rt-content` — ein Modal, in das dynamisch
  Rich-Text-Editoren gemountet werden, ist per Overlay-Klick danach faktisch
  nicht mehr schliessbar.

Siehe auch [[threadstack-review-konventionen]], [[threadstack-testmuster]] und
[[threadstack-aggregierte-snippets]].
