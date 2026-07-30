---
name: "implement-roadmap"
description: "Execute a slice-based ROADMAP.md (the /slice-roadmap format): read it, ask only the questions the roadmap doesn't answer, then implement it with parallel agents in worktrees — slice Owns lists as the boundaries, critical path staffed first, Slice 0 serial. Fan-in at the merges, run the app and verify the changed flows with Playwright MCP, troubleshoot what fails, and close out with the roadmap updated and a report. Use when a roadmap exists and the owner says build it."
metadata:
  author: "dev-kit"
user-invocable: true
disable-model-invocation: false
---

# implement-roadmap

Invoked as `/implement-roadmap [path]`; the path defaults to the repo's `ROADMAP.md`. Companion to
`/slice-roadmap` — that one plans, this one builds. It assumes the roadmap has the slice format:
Status, mermaid graph, per-slice **Owns** + checkboxes + **Exit**, fan-in merges.

**Run this right after `/clear`.** A skill cannot clear the session itself. If the session already
carries substantial unrelated context, say so and stop — ask the owner to `/clear` and re-invoke —
rather than executing a multi-agent build on top of someone else's leftovers.

## Phase 1 — Read, verify, interrogate

1. Read the roadmap in full, plus the repo's CLAUDE.md and anything the roadmap cites (specs,
   contract docs). Build the dependency graph from the mermaid edges, not from prose order.
2. **Pre-flight** — refuse to start over a mess: working tree clean, on the default branch and up
   to date, last CI run green, local stack boots (e.g. `docker compose up`, `npm ci`). Report and
   stop on any failure; don't "fix" pre-existing breakage as a side quest.
3. Cross-check the roadmap against reality: already-ticked boxes match landed code; Owns files
   exist or are marked (new); frozen contracts haven't drifted since the roadmap was written.
   Stale roadmap → surface the diff and ask before proceeding.
4. **One AskUserQuestion batch, up front** — never mid-build. Ask only what the roadmap doesn't
   answer: which slices are in scope this run; commit/PR authorization (branch-per-slice + PRs is
   the default; the ask-before-commit rule is satisfied here, once); whether to pause for review at
   each merge or run straight through; any ambiguity found in step 3.

## Phase 2 — Parallel build

- Topological order from the graph. Slice 0 (contract freeze) runs **serial and first** if
  unticked — nothing else starts until its Exit holds.
- Each ready slice → one agent in its **own worktree** (`isolation: worktree`). The slice's Owns
  list is the boundary: an agent touches nothing outside it, and S0's frozen files are read-only
  to all. Two slices claiming one file is a roadmap bug — stop and fix the roadmap first.
- **Critical path gets an agent first** and keeps one; other slices fill remaining capacity in
  dependency order (a slice's future consumers land early). Keep concurrency modest (3–4 lanes) —
  the merges are where over-parallelization comes home to roost.
- Agent brief = the slice text **verbatim** (Owns, checkboxes, Exit) + the frozen contracts + the
  repo's CLAUDE.md rules + "every behaviour change lands with its test, same commit". Each agent
  proves its own Exit criterion and runs the tests for its files before reporting done.
- **Contract-change protocol** (from `/slice-roadmap`): an agent that believes a frozen contract is
  wrong stops and reports; you halt the affected lanes, fix the contract in one commit on the
  default branch, rebase all lanes. Never let a lane patch a contract divergently.

## Phase 3 — Fan-in

Merges in roadmap order, each on its own branch. At each merge: run the **full** test suite (not
just the changed slices'), verify the merge entry's own checkboxes, and remember the rule —
contract drift found here is a bug in the merge, not a license to change the contract. Tick boxes
and bump the roadmap's Status line **in the same PR** that lands each slice or merge.

## Phase 4 — Verify live

Tests passing is not the bar; the running app is.

1. Launch the app the way the repo's CLAUDE.md says (or the project's `/run` skill if present).
2. Playwright MCP pass, scoped to what this run changed: `browser_navigate` to each affected page,
   `browser_snapshot` to confirm real data renders (not empty states, unless empty is correct),
   exercise the changed flows end to end (upload, filter, edit, save — whatever the slices touched),
   and check `browser_console_messages` + `browser_network_requests` for errors on every page.
3. If the repo ships dark mode or mobile layouts, spot-check both. Screenshot the money shots —
   they go in the close-out report and the PR.

## Phase 5 — Troubleshoot

For anything Phase 3–4 surfaces: reproduce it first; attribute it to a slice by the Owns lists;
fix it **in that slice's lane with a regression test**, then re-run the failing verification, then
the full suite. Escalate only two ways: contract-level problems → the Phase 2 protocol;
scope-level problems (the roadmap asked for the wrong thing) → stop and ask the owner. Found bugs
that are real but **out of this run's scope**: file an issue per bug and link it in the report —
never silently widen the run (the my-expenses #14–#17 pattern: found during a refactor,
deliberately fixed outside it).

## Phase 6 — Close out

- Roadmap: all landed boxes ticked, Status line updated with date and what shipped, mid-flight
  decisions appended to the Decisions log.
- Report to the owner: slices landed with their Exit criteria verified, PRs opened (list), issues
  filed, screenshots, what was deferred and why, and the single next action if the roadmap
  continues.
- Clean up: worktrees removed, no stray branches, working tree clean.

## What this skill does not do

It does not deploy (deploys ride the repos' existing on-merge workflows), does not merge PRs the
owner hasn't approved, and does not invent slices — gaps it finds go back through `/slice-roadmap`.
