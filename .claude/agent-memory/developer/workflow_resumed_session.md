---
name: workflow-resumed-session
description: How to verify state when picking up an arbeitspaket after a previous developer run was cut off (rate limit/abort)
metadata:
  type: feedback
---

When asked to continue a developer arbeitspaket after a previous session was aborted
mid-work (e.g. session rate limit), do NOT assume the work is incomplete just because
the task description says "moeglicherweise unvollstaendig". First: merge the branch,
then read all files in scope end-to-end and diff mentally against the full original
requirement list. In at least one observed case (ThreadStack Arbeitspaket B2,
"Zwischenstand-Mechanismus um ref_type=contact erweitern"), the prior run had actually
finished 100% of the requirement (schema migration, queries, routes, tests) and
committed cleanly before being cut off — the only remaining job was verification
(run full test suite, confirm regressions, write the abschlussbericht) plus reporting
open cross-package dependencies (e.g. missing wiring call in server.js that belongs
to a different, later arbeitspaket/B4).

**Why:** Rate-limit aborts happen between commits, not necessarily mid-implementation.
Assuming incompleteness and redoing/rewriting already-correct code risks diverging
from a contract another agent already implemented faithfully, and wastes effort.

**How to apply:** Always run `git status --short` after merging — if clean, and the
implementation files already contain thorough contract-matching code + tests (check
against the full original requirement list line by line), the job may just be
"verify + document", not "implement". Still run the full test suite and check
requirement items individually (e.g. "does the wiring in the shared entrypoint file
already call the new function?") before declaring done, since partial completions
absolutely do happen too — this is a case-by-case check, not a shortcut to skip
verification.
