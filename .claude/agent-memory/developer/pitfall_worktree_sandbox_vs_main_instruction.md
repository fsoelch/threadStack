---
name: pitfall-worktree-sandbox-vs-main-instruction
description: Task text may say "work directly in the main checkout, no worktree" while the sandbox still hard-isolates the agent to its own worktree branch — reconcile by resetting the own branch to main's tip, not by fighting the sandbox
metadata:
  type: project
---

The launching/orchestrator agent sometimes writes instructions like "arbeite
direkt hier (du bist nicht in einem isolierten Feature-Worktree, sondern im
normalen Repo-Checkout)" and names the shared checkout path
(`/Users/florian.soelch/personly`). In practice the Bash tool sandbox for a
`developer` subagent is still hard-restricted to its own
`.claude/worktrees/agent-<id>` directory — any `cd`/`git -C` targeting the
shared checkout is refused with an explicit error ("a worktree-isolated
agent's git operations must target its own worktree"), even though the
`cwd` shown in tool output already IS that worktree by default (no `cd`
needed for non-git file operations).

**Why relevant:** Taking the task text at face value and trying to `cd` into
the shared checkout wastes turns on a refusal. Also, the agent's own
worktree branch can be stale relative to `main` (e.g. missing a just-merged
feature entirely) — the task's premise ("feature is already merged") only
holds for the shared checkout's `main`, not necessarily for the sandboxed
worktree's current branch tip.

**How to apply:** When this happens: (1) verify with `git log --oneline -3
main` from inside your own worktree — branch refs are shared via the common
`.git` dir even though `HEAD`/working tree are per-worktree, so this reads
the *live* tip of `main` without needing to enter the shared checkout; (2)
confirm your own worktree isn't checked out to `main` already (`git worktree
list | grep '\[main\]'` — if `main` is checked out elsewhere, you can't
`checkout main` yourself); (3) if your branch is behind/divergent and the
working tree is clean, `git reset --hard <main's tip sha>` on your own
branch to pull in the target state, do the work, and commit there. Document
this deviation explicitly in the final report (commit lands on the agent's
own branch, not literally on `main`) rather than silently proceeding as if
nothing were unusual — the orchestrating system is expected to merge it in
afterward. Never force-push or touch the shared checkout directly.
