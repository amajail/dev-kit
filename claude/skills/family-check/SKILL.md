---
name: "family-check"
description: "Sweep the my-afip / my-finances / my-expenses repos and report drift in one table: branch and working-tree state, ahead/behind, last CI run on the default branch, @amajail/ui pin (floating vs pinned, and mismatches between repos), CLAUDE.md line count against the 80-line cap, privacy guards present, and open PRs. Read-only — it reports, it never fixes."
metadata:
  author: "dev-kit"
user-invocable: true
disable-model-invocation: false
---

# family-check

Invoked as `/family-check`. Output is **one table and a short flag list** — no per-repo prose.

**Read-only.** It never checks out, stashes, edits or pushes anything. The one write it performs is
`git fetch --quiet`, which touches only remote-tracking refs — never the worktree, never a local
branch. Counts are therefore as of the fetch this skill performs, not as of the last time the owner
fetched. Other agents may be working in these repos concurrently, so a dirty tree or an in-flight
branch is information, not an error.

## The repo list (data — extend here, nowhere else)

| repo | frontend dir |
|---|---|
| my-afip | dashboard |
| my-finances | dashboard |
| my-expenses | frontend |

All live under `~/repos/`. The frontend dir differs per repo, so it is data too — that is where
`@amajail/ui` is pinned. Add a row to add a repo; nothing below hardcodes a repo name.

## Run

```bash
REPOS="my-afip:dashboard my-finances:dashboard my-expenses:frontend"

for entry in $REPOS; do
  name=${entry%%:*}; fe=${entry##*:}; d=~/repos/$name
  [ -d "$d/.git" ] || { echo "$name|MISSING"; continue; }
  git -C "$d" fetch --quiet origin 2>/dev/null

  branch=$(git -C "$d" rev-parse --abbrev-ref HEAD)
  dirty=$(git -C "$d" status --porcelain | wc -l)
  ab=$(git -C "$d" rev-list --left-right --count @{upstream}...HEAD 2>/dev/null | tr '\t' '/')

  # slug and default branch come from the remote, never from the directory name
  slug=$(cd "$d" && gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)
  def=$(cd "$d" && gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null)
  ci=$(gh run list -R "$slug" --branch "${def:-main}" --limit 1 --json conclusion,status,workflowName \
         -q '.[0] | (if .conclusion == "" then .status else .conclusion end) + " (" + .workflowName + ")"' 2>/dev/null)
  prs=$(gh pr list -R "$slug" --state open --json number -q 'length' 2>/dev/null)

  pin=$(sed -n 's/.*"@amajail\/ui": *"\([^"]*\)".*/\1/p' "$d/$fe/package.json" 2>/dev/null)
  lines=$(wc -l < "$d/CLAUDE.md" 2>/dev/null)

  cfg=$([ -f "$d/.privacy-scan.json" ] && echo yes || echo no)
  act=$(grep -qr 'amajail/dev-kit/actions/privacy-scan' "$d/.github/workflows/" 2>/dev/null && echo yes || echo no)
  loc=$(ls "$d"/scripts/privacy[-_]scan.* >/dev/null 2>&1 && echo yes || echo no)

  echo "$name|$branch|$dirty|${ab:--}|${ci:-?}|${prs:-?}|${pin:-none}|${lines:-?}|$cfg/$act/$loc"
done
```

## Reading the output, and what to flag

- **branch / dirty / ahead-behind** — `ab` is `behind/ahead` vs the branch's upstream; `-` means no
  upstream (a local-only branch). Flag a repo sitting on its default branch with a dirty tree.
- **CI** — the last run on the *default* branch, which is not always `main`; read it from
  `defaultBranchRef`. The workflow name is printed with it because the newest run is often
  `pages-build-deployment`, not the PR checks — a green there says nothing about the build. `?` means
  no run, or `gh` is not authenticated. Flag anything not `success`.
- The GitHub slug is **not** the directory name — my-finances lives at
  `amajail/my-finances.adrimajail.com`. Always resolve it from the repo's own remote, as above.
- **`@amajail/ui` pin** — three states, and print the raw pin string:
  - *tag* (`#v0.1.0`) — correct;
  - *sha* (40 hex chars) — immutable, so builds are reproducible, but still not the rule;
  - *floating* (`#master`, `#main`) — **flag**. A floating pin changes the build with no PR and no
    signal.
  Also compare the raw strings across repos: any two differing is drift, flag it even if both are tags.
- **CLAUDE.md lines** — flag over 80 (the soft cap in `~/.claude/CLAUDE.md`). This skill is what
  makes that cap a measurement rather than an assertion.
- **guards** — three fields, `config/action/local`. Not a boolean: a repo with no `.privacy-scan.json`
  may still have its own scanner script, which is *partial*, not unguarded. Classify as
  `dev-kit` (config + action), `local` (own script only), `partial`, or `none` — and flag anything
  that is not `dev-kit`, since only the shared action is the tested, fail-closed one.
- **open PRs** — a count. Expect non-zero when other agents are mid-work.

Render as a markdown table with one row per repo, then a short bullet list of only the flags that
fired. If nothing fired, say so in one line.

## Later

A cron routine can wrap this unchanged — it takes no arguments, writes nothing, and its output is
already a diffable table. The natural cadence is weekly; the natural escalation is "open an issue
when a flag fires two sweeps running". Neither is built yet, deliberately: an unread scheduled
report is worse than no report.
