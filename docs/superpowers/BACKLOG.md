# Backlog — agent-forge

Follow-ups split out of a brainstorming session, each awaiting its own
spec → plan → implementation cycle.

## Open

- **Spec 2 — Lifecycle: exiting an agent should release its resources**
  (raised 2026-09-20). Once the container is the task (see
  `specs/2026-09-20-container-per-task-design.md`), leaving an agent should be
  able to stop that task's container instead of leaving it running. Ending a
  `forge start`/`resume` attach is ambiguous today — detaching from tmux
  (`Ctrl-b d`) and the agent actually exiting both return from `lxc exec` — so
  the command has to tell them apart, probably by probing whether the tmux
  session survived, and only then offer the WIP check → `finish` / `stop`
  flow. Carries a small companion change: a line in `templates/CLAUDE.md`
  telling agents to bring down their Docker stacks and release resources when
  a task ends. That reminder matters much less after spec 1 (stopping the
  container releases everything at once), which is why it rides along here
  rather than being its own project.

- **Spec 3 — `forge prune`** (raised 2026-09-20). One command that reconciles
  the real state with what is actually alive: stopped or orphaned task
  containers, worktrees whose container is gone, orphaned `.git/worktrees/*`
  entries, and `agent/*` branches whose PR is merged or closed (retained by
  `finish` today, forever). Becomes considerably more necessary after spec 1,
  which multiplies the number of containers.

- **Claude OAuth credentials are never refreshed** (raised 2026-09-20).
  `~/.claude/.credentials.json` is pushed once at provisioning and never
  updated, so a long-lived container eventually holds an expired token. One
  container per task multiplies the occasions to hit it. A host mount does not
  solve it for free: `claude` *rewrites* that file on refresh, so it would
  need read-write sharing across N containers, with a risk around refresh
  token rotation. Needs its own investigation.

## Resolved

- **Host terminal garbles text on resize** (raised 2026-08-28, fixed
  2026-08-31). Diagnosed to layer 2: the pty behind `lxc exec` resized
  correctly, but the `su - aiuser -c "..."` wrapper around `tmux` kept
  SIGWINCH from reaching the tmux client, which went on drawing into a stale
  grid. Fixed by making tmux the direct target of `lxc exec` in
  `_forge_attach_task` (`scripts/lib/forge-start.sh`); see the comment there
  for the full rationale.
