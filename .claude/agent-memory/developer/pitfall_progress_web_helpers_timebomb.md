---
name: pitfall-progress-web-helpers-timebomb
description: test/progress_web_helpers.test.js badgeHtml test uses hardcoded absolute dates and will intermittently fail as real time passes
metadata:
  type: project
---

`test/progress_web_helpers.test.js` (around line 106-140, testing `badgeHtml()` from
`public/progress.js`) asserts an aria-label regex like
`/aria-label="Fortschritt: 5 Zwischenstände, letzter vor \d+ Tagen"/` against a
`lastEntryAt` of a hardcoded absolute date (e.g. `2026-08-20T10:00:00.000Z`). The
underlying formatter (`roughGermanDuration`, in `public/progress.js`) switches from
"N Tage" to "N Wochen" once the gap exceeds 14 days. Because the test computes the
gap against the real wall-clock `Date.now()` at test-run time (not a frozen clock),
this test silently starts failing once enough real time has passed since it was
authored — observed failing on 2026-09-05 (16 days after the hardcoded date).

**Why:** Not caused by any specific feature work; it's a pre-existing "time bomb"
test unrelated to whatever arbeitspaket you're doing. `public/progress.js` and its
test file are typically NOT owned by `lib/progress/*` backend arbeitspakete.

**How to apply:** If you see this specific test fail while working on an unrelated
`lib/progress/*` backend package, don't assume you caused a regression — check the
git blame/history of the test file (predates your change) and the hardcoded date
inside it. Report it as a known pre-existing issue/out-of-scope finding (belongs to
whoever owns `public/progress.js`) rather than trying to "fix" it by touching a file
outside your ownership. A proper fix would freeze the clock in the test (inject a
`now` or compute `lastEntryAt` relative to `Date.now()` instead of a literal date).
