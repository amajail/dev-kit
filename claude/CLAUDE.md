# Shared rules — every repo

Applies wherever I open Claude Code. Each repo's own `CLAUDE.md` carries what is specific to it;
this file carries only what holds regardless of repo. It is itself a CLAUDE.md and obeys the budget
below — 3 bold spans, spent on the three things that have actually cost something.

## Git

- Commit subject: `<type>: <imperative>`, ≤72 chars, type ∈ `feat|fix|refactor|docs|test|ci|chore|perf`.
- Branch `<type>/kebab-case` off the default branch, same type set as the subject (`feature/` also
  reads as `feat`). Never commit directly to it.
- Ask before committing ad-hoc work. A repo may carve out an exception (my-finances lets speckit work
  commit as it goes); the exception belongs in that repo's file, not here.

## Privacy — enforced, not remembered

`.gitignore` is the privacy boundary. *What* each repo must never publish is data, in its own
`.privacy-scan.json`; the engine, the schema and the rationale live in `~/repos/dev-kit`.

Two layers, with deliberately opposite failure modes:

- hook — `~/.claude/hooks/git-guard.sh` (PreToolUse) is **fail-open**. It only ever sees commands
  Claude runs on this machine: never a human typing git, never CI. A guard that blocks all work gets
  deleted, and then nothing is enforced anywhere.
- CI — `pr-checks.yml` → `amajail/dev-kit/actions/privacy-scan` is **fail-closed**. That is the
  actual guarantee; it sees everything reaching a PR.

**Never work around a block** — fix the rule, or ask the owner. Two escape hatches exist, both
greppable (`grep -rn 'privacy-scan: allow'`): `privacy-scan: allow` on one line,
`privacy-scan: allow-secrets` for a whole file. Neither ever exempts a path rule. Reaching for either
more than occasionally means the rule is wrong — fix `.privacy-scan.json` instead.

## CLAUDE.md discipline

CLAUDE.md is production code, not documentation. Every line is justified or cut; rules are enforced
by hooks and tests rather than asserted in prose; a pointer beats a duplicated paragraph.

Per file: soft cap 80 lines, at most 3 bold spans — if a fourth thing needs bold, one of the three
is not earning it. Adding more than 4 lines means deleting something else in the same edit.

A rule that has failed three times does not get a fourth try in prose. It becomes a hook check or a
`.gitignore` entry, or it is deleted as unenforceable. `/claude-md-fix` does that classification and
keeps the tally; `/family-check` is what actually measures the line count.

## The family stack

my-afip, my-finances and my-expenses share: Astro dashboard, Tailwind v4, `@amajail/ui`
(`~/repos/amajail-ui`), Azure Functions or Static Web Apps, and Azure Table Storage as the only
datastore — no ORM, no second database.

Pin `@amajail/ui` to a tag (`github:amajail/amajail-ui#v0.1.0`), never a floating branch. A
`#master` pin changes the build with no PR and no signal; that has already happened. `/family-check`
flags floating pins and cross-repo version drift.
