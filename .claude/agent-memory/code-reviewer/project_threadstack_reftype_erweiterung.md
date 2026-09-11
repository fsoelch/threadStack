---
name: threadstack-reftype-erweiterung
description: Wiederkehrende Qualitaetsmuster, wenn ein Arbeitspaket einen neuen ref_type in die geteilte progress-/link-Komponente einzieht
metadata:
  type: project
---

Arbeitspakete, die einen bestehenden polymorphen Mechanismus (`lib/progress`,
`theme_links`, `stack_frames`) um einen weiteren `ref_type` erweitern, erzeugen
regelmaessig dieselben zwei Muster. Beide sind Wartbarkeits-, keine Funktionsfehler —
die Tests sind dabei gruen.

**Why:** Der neue Typ kann meist weniger als die bestehenden (ein Kontakt hat keinen
"naechsten Schritt", keine Ruhephase, kein KI-Wiedereinstieg). Diese Faehigkeits-
Unterschiede werden als Einzel-`if`s an den Fundstellen abgelegt, statt einmal als
Datenstruktur. Beim naechsten Typ verdoppelt sich das.

**How to apply:**

1. **`refType === 'x'`-Sonderfaelle zaehlen und verorten.** Beispiel B2 (`contact`):
   sechs verstreute Stellen ueber `routes.js` und `queries.js` (next-step-Reject,
   ai-Skip, dormant in `summaryFor`, dormant in `detailStats`, `reentry`-Zweig,
   meta-Skip in `deleteForRefs`) plus drei Allowlist-Erweiterungen. Ab ~3 Stellen
   eine zentrale Faehigkeits-Map (`REF_CAPABILITIES`) einfordern — sonst muss man
   fuer jeden Typ alle sechs Stellen einzeln lesen, um sein Verhalten zu kennen.
2. **Sonderfall-Zweige gegen den generischen Zweig gegenrechnen.** Sehr haeufig ist
   der neue `isX ? {...} : {...}`-Zweig komplett redundant, weil eine vorgelagerte
   Flag-Neutralisierung den generischen Zweig bereits dasselbe liefern laesst.
   Nicht argumentieren — beide Objekte im Probe-Skript serialisieren und
   vergleichen. In B2 war der `reentry`-Ternary nachweislich bitidentisch.
3. **Exportflaeche pruefen, nicht nur die HTTP-Routen.** Die fuer den neuen Typ
   angepassten, direkt exportierten Funktionen (`deleteForRefs`, `summaryFor`,
   `retargetRef`) sind typischerweise NUR indirekt ueber eine Route mitgetestet
   oder gar nicht — obwohl genau daran das Folgepaket haengt. Vgl.
   [[threadstack-testmuster]] Punkt 2.
4. **Test-Titel gegen die Assertions lesen.** Titel behaupten in diesen Paketen
   gern mehr, als geprueft wird (z.B. "description ist immer ''", ohne dass
   `description` ueberhaupt assertet wird — das Feld ist ueber HTTP gar nicht
   sichtbar). Der Vertragspunkt bleibt damit ungetestet.

Siehe auch [[threadstack-review-konventionen]] und [[threadstack-sqlite-table-rebuild]].
