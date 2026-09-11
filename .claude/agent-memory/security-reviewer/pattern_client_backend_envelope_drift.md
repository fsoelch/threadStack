---
name: pattern-client-backend-envelope-drift
description: Wiederkehrend: Web-/iOS-Clients nehmen flache Arrays an, wo das Backend {key: [...]}-Envelopes liefert - und die Test-Mocks bilden dieselbe falsche Annahme ab
metadata:
  type: project
---

Bei parallel entwickelten Arbeitspaketen (Backend-Modul vs. Web-Modul vs.
iOS-App) driften Response-Envelopes und Body-Feldnamen regelmaessig
auseinander. Gemessen am 2026-09-06 im Kontakte-Feature u.a.:
`GET /contact-categories` → `{categories:[...]}` (Client erwartete Array),
`GET .../info-blocks` → `{blocks,categories}` (Client erwartete Array),
`POST .../info-blocks` erwartet `body`, Clients sendeten `bodyHtml`,
Reorder erwartet `orderedIds`, Web sendete `order`, Rubrik-Zwangsloeschung
erwartet `?confirm=true`, Web sendete `{force:true}`.

**Why:** Zwei Verstaerker machen das sicherheitsrelevant statt bloss
funktional: (1) Clients fallen bei Formatabweichung meist STILL auf
`Array.isArray(x) ? x : []` zurueck — ein Fehlschlag sieht aus wie "keine
Daten"; (2) die Unit-Test-Mocks werden aus derselben falschen Annahme
gebaut und sind gruen, geben also falsche Sicherheit. Genau diese Kombination
hatte im selben Feature schon einmal zu einem destruktiven Bug gefuehrt
(Prefill schlug still fehl → `PUT {contactIds}` loeschte alle Zuordnungen).

**How to apply:** Bei jedem Review eines Features mit eigenem Backend-Router
die tatsaechlichen `res.json(...)`-Ausdruecke in `lib/**/routes.js` /
`router.js` gegen die Lesestellen in `public/*.js` und `AppState.swift`
abgleichen — nicht gegen den Schnittstellenvertrag und nicht gegen die
Tests. Zusaetzlich pruefen: fuehrt eine Voll-Ersetzen-PUT-Semantik zusammen
mit einem stillen Lade-Fehlschlag zu Datenverlust?
