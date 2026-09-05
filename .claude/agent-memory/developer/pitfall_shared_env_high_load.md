---
name: pitfall-shared-env-high-load
description: This worktree environment runs dozens of parallel agent worktrees sharing one machine — expect very high load averages and slow/stalled-looking test runs that are NOT deadlocks
metadata:
  type: project
---

The dev machine for this project runs many `worktree-agent-*` git worktrees
concurrently (observed: 100+ branches, 10+ concurrent `node --test` processes
from unrelated agent sessions at once). Load averages of 150-180+ are normal
under contention, not a sign anything is broken.

**Why relevant:** A `node --test` run across many files (e.g. all of
`test/progress_*.test.js` plus an AI test file) can appear to hang for many
minutes with 0.0% measured CPU in `ps` — this looks like a deadlock but is
actually just severe CPU scheduling starvation from sibling agent processes.
It does eventually complete successfully (observed: exit code 0 after ~10+
minutes wall-clock for a run that takes ~10s in isolation).

**How to apply:** Don't assume a stalled-looking `node --test` background
task is an actual hang/deadlock in the code under test just because `ps`
shows long elapsed time with ~0% CPU and state `S`. Re-run the same command
in isolation (fewer files) first to sanity-check it's not a real hang; if
the isolated run passes quickly, the full-glob slowness is very likely just
shared-machine contention — keep waiting via a background `until ! ps -p
<pid>` loop rather than killing/rewriting code to "fix" a phantom bug.
