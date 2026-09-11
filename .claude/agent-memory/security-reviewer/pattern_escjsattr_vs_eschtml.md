---
name: pattern-escjsattr-vs-eschtml
description: Wiederkehrendes XSS-Antipattern in public/app.js - escHtml(...).replace(/'/g,"\\'") fuer onclick-Attribute ist wirkungslos; korrekt ist escJsAttr()
metadata:
  type: project
---

In `public/app.js` werden Werte haeufig per Template-String in
`onclick="fn('...')"`-Attribute interpoliert. Es existieren dort ZWEI Muster:

- **Falsch (wirkungslos):** `escHtml(x).replace(/'/g, "\\'")` — `escHtml`
  wandelt `'` bereits in `&#039;` um, der Regex findet danach kein `'` mehr.
  Der HTML-Parser dekodiert die Entity VOR dem JS-Parsing zurueck zu `'` →
  String-Literal-Ausbruch, beliebiger JS-Code laeuft.
- **Richtig:** `escJsAttr(x)` (definiert um Zeile 909) — escaped
  `\ ' " < > & \n \r` als `\uXXXX`, entity-dekodierungsfest.

**Why:** Empirisch mit jsdom verifiziert (2026-09-06): das erste Muster fuehrt
mit einem Kontaktnamen wie `x'); alert(1); void('` zu Code-Ausfuehrung, das
zweite nicht. Die CSP der App (`script-src 'self' 'unsafe-inline'`,
server.js ~Z.230) erlaubt Inline-Handler, es gibt also KEINE zweite
Verteidigungslinie — der Escaper ist der einzige Schutz.

**How to apply:** Bei jedem Review neuer/geaenderter `onclick`-Interpolationen
in `public/app.js` gezielt nach `.replace(/'/g` grepen. Nur server-generierte
IDs (`c.id`, `t.id`, `m.id`) sind unkritisch; alles nutzerkontrollierte
(Namen, Titel, Labels) MUSS ueber `escJsAttr()`. Siehe auch
[[pattern-private-rubrik-label-invariante]].
