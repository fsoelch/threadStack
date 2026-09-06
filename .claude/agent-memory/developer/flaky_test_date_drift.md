---
name: flaky-test-date-drift
description: test/progress_web_helpers.test.js "badgeHtml" hat einen kalenderzeit-abhaengigen Fixture-Bug (Tage vs. Wochen Formatierung)
metadata:
  type: project
---

`test/progress_web_helpers.test.js`, Test `badgeHtml: Fortschritts-Badge-Markup`,
Subtest "normaler Zustand" (Zeile ~106-126), verwendet ein hartcodiertes Datum
`lastEntryAt: '2026-08-20T10:00:00.000Z'` und erwartet per Regex, dass das
aria-label IMMER "... letzter vor \d+ Tagen" enthaelt. Die produktive
`formatRelative`/Badge-Logik in `public/progress.js` schaltet aber ab einer
gewissen Differenz automatisch von "Tagen" auf "Wochen" um. Sobald das
Testlaufdatum mehr als ~2 Wochen nach dem 2026-08-20 liegt, schlaegt der Test
fehl (beobachtet am 2026-09-05, 16 Tage Differenz -> "vor 2 Wochen" statt
"vor \d+ Tagen").

**Warum wichtig:** Das ist ein vorbestehender, von der eigentlichen Aufgabe
unabhaengiger Flaky-Test (kalenderzeit-abhaengiges Fixture, kein Regressions-
bug). Er gehoert zu `public/progress.js`/W2, nicht zu `public/contacts.js`/W1 -
also außerhalb typischer Kontakt-Arbeitspaket-Eigentuemerschaft.

**Wie anwenden:** Wenn `npm test` mit exakt diesem Testnamen fehlschlaegt und
sonst alles gruen ist: nicht als eigene Regression werten, sondern als
bekannten, unabhaengigen Flaky-Test dokumentieren/melden statt (a) blind zu
ignorieren oder (b) im falschen Arbeitspaket zu reparieren. Ein echter Fix
muesste das Testfixture auf ein relatives statt absolutes Datum umstellen
(Verantwortung des progress.js/W2-Eigentuemers).
