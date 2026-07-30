---
name: "slice-roadmap"
description: "Turn a goal, spec or backlog into a slice-based ROADMAP.md: find the real (flatter) dependency graph, freeze shared contracts in Slice 0, give every slice a disjoint file set so parallel branches/worktrees never collide, mark the critical path, and draw the mermaid dependency diagram with fan-in merges. Use when planning a project, a large feature, or a cross-repo effort — anything worth splitting across parallel lanes or agents."
metadata:
  author: "dev-kit"
user-invocable: true
disable-model-invocation: false
---

# slice-roadmap

Invoked as `/slice-roadmap [goal or path to spec]`. Output is a **`ROADMAP.md`** in the target repo
(dev-kit for family-wide efforts). Reference examples of the finished form: `my-expenses/ROADMAP.md`
(single repo, shipped) and `dev-kit/ROADMAP.md` (cross-repo).

The method exists because specs and backlogs read sequential when the real dependency graph is much
flatter. Slices only truly depend on each other through **shared interfaces**; freeze those first
and almost everything else runs in parallel.

## Method

1. **Find the real graph.** For every "then", ask what data or interface actually forces the order.
   Habit and narrative are not dependencies. Expect the honest graph to be much flatter than the
   source document implies.
2. **Slice 0 = contract freeze.** Everything ≥2 slices share — dataclasses, API request/response
   models and their frontend mirror types, tool schemas, storage keys — gets written down and frozen
   in one short serial slice (target ½ day). This is the *only* mandatory serial work; keep it small.
3. **Cut slices around disjoint file sets.** Each slice lists the files it **Owns** — those lists
   are the branch/worktree boundaries, so no two slices may claim the same file and S0's frozen
   files are read-only to all. A slice that can't name its files isn't a slice yet.
4. **Fan-in merges.** Integration points are their own entries (Merge 1, Merge 2 …) with the slices
   they need. Contract drift discovered at a merge is a bug in the merge, **not** a reason to change
   the contract under another slice's feet.
5. **Mark the critical path** and say who staffs it first. Give the parallel wall-clock vs serial
   estimate — that delta is the roadmap's justification.

## Per-slice format

```
### Slice X — name (estimate) [⚠ critical path] [— needs S0/…]
**Owns:** exact files/dirs
- [ ] checkbox items — concrete, verifiable, each one landable
**Exit:** one observable criterion, not a vibe
```

Plus, document-wide: a one-line **Status** near the top (updated as things land); a **Decisions
made** log (numbered, dated — record what was *rejected* and why, so it doesn't get re-litigated);
**Standing assumptions** (not blocking — flag if wrong); optionally **Deliberately not building**
and a **Backlog** of good-but-unscheduled items.

## Mermaid conventions

One `flowchart TD` near the top, after Status:

- Node label: `Name — summary · estimate · flags`, then `<br/>`-separated key contents (2–3 lines
  max). Quote labels; `·` and `⚠` are safe inside quotes.
- Edges: `S0 --> A & B & C` fan-out, slices `--> M1`, merges chain to a terminal
  `DONE(["Done — …"])`. Label an edge when only part of a slice is the dependency
  (`D -->|mepRate fix only| M1`).
- Independent slices point straight at `DONE` — visibly parallel, visibly non-blocking.
- Styling carries meaning, keep exactly these: `style <critical-slice> stroke-width:3px`,
  `style S0 stroke-width:2px`, `style DONE stroke-width:2px`. No colors — they die in dark mode.

## Rules that make the parallelism safe

- The contract freeze is what buys the parallelism. If a slice discovers the contract is wrong (it
  happens), stop, fix it in **one commit on the default branch**, rebase all lanes — never patch it
  divergently inside a slice.
- Estimates are per-slice wall-clock for one worker. State the staffing plan: critical path gets a
  dedicated lane; everything else packs into the remaining lanes' slack, ordered by who consumes
  whom (a slice's future consumers land early to de-risk the merge).
- Roadmap upkeep is part of every slice: tick the boxes and bump Status **in the same PR** that
  lands the work; decisions made mid-flight get appended to the log, dated.

## What this skill does not do

It plans; it does not execute, create branches, or open issues. It also does not replace a spec —
when a spec exists, the roadmap derives from it and cites it (`Derived from specs.md §12` style),
and on conflict the spec wins unless the owner says otherwise.
