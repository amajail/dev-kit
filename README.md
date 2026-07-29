# dev-kit

Shared layer for the app family: **my-afip**, **my-finances**, **my-expenses**.

Three sibling personal Azure apps (Astro dashboard + backend, deployed by GitHub Actions). Every
good pattern used to be stranded in whichever repo invented it — the privacy scanner got written
twice in two languages, the git guard twice, and one repo had neither. This is the single home for
what all three agree on.

## The line: prose goes up, enforcement stays down

| | lives here | why |
|---|---|---|
| commit format, branch naming, ask-before-commit, CLAUDE.md discipline | `claude/CLAUDE.md` → symlinked to `~/.claude/CLAUDE.md` | identical in all three; one copy to change |
| skills (`/claude-md-fix`, `/family-check`) | `claude/skills/` → symlinked to `~/.claude/skills/` | on-demand, machine-local |
| the PreToolUse git guard | `hooks/git-guard.sh` → registered once in `~/.claude/settings.json` | covers every repo instead of each wiring its own |
| the privacy scan **engine** | `scripts/privacy-scan.js` | one implementation, tested here |
| the privacy scan **rules** | each repo's own `.privacy-scan.json` | **stays per-repo — see below** |

The rules deliberately do *not* move up. What counts as private genuinely differs (holdings and PPC
in my-finances, statement PDFs and CBUs in my-expenses, AFIP certificates and CUITs in my-afip), and
one hard-coded rule set would mean false negatives in one repo and false positives in the others.

Nor does enforcement move up. A hook in `~/.claude` only ever sees commands **Claude** runs on **this
machine** — never a human typing git directly, never CI. So the fail-closed half stays in each repo's
`pr-checks.yml`. The two layers have deliberately opposite failure modes:

- **hook — fail-open.** Any error exits non-zero without a decision, which Claude Code treats as
  non-blocking. A guard that blocks all work gets deleted, and then nothing is enforced anywhere.
- **CI — fail-closed.** This is the actual guarantee.

## Using it in a repo

**1. Add `.privacy-scan.json`** describing what that repo must never publish. See
`schema/privacy-scan.schema.json`, or the three live examples. Defaults already protect `.env`,
`local.settings.json`, `.claude/settings.local.json` and the usual cloud credential shapes — your
config *adds* to those rather than replacing them.

**2. Add the CI job** to `pr-checks.yml`:

```yaml
  privacy:
    name: Privacy scan
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0        # required: the scan needs the merge base
      - uses: amajail/dev-kit/actions/privacy-scan@v1
```

A composite action rather than a reusable workflow: it slots into an existing job instead of
dictating the job shape, GitHub fetches this repo automatically (no second checkout, no token), and
this repo is public so private callers work too. No `npm ci` — the scanner is dependency-free, so
the job runs in seconds.

**3. The hook is already on** if `~/.claude/settings.json` registers `hooks/git-guard.sh` (see
Install). Nothing per-repo needed.

## Escape hatches

Both are deliberately visible — `grep -rn 'privacy-scan: allow'` lists every exemption in a repo.

- `privacy-scan: allow` on a line — skips the credential check for that line.
- `privacy-scan: allow-secrets` anywhere in a file — skips it for that whole file. Use for tests that
  assert on credential *parsing* and so must contain credential-shaped strings.

Neither ever exempts a **path** rule. A file that must not be committed must not be committed.

If you reach for a pragma often, the rule is wrong — fix `.privacy-scan.json` instead of working
around it.

## Modes

```bash
node scripts/privacy-scan.js --range origin/main...HEAD   # CI, fail-closed
node scripts/privacy-scan.js --staged                     # local pre-commit
node scripts/privacy-scan.js --hook                       # PreToolUse, fail-open (stdin = payload)
node scripts/privacy-scan.js --against-refs               # local only, needs refsDir in config
```

`--against-refs` closes a gap the others structurally cannot. They match *patterns* — something
shaped like a key, 22 digits shaped like a CBU. An ordinary peso amount is not a pattern, so a real
balance copied verbatim into a test fixture sails straight through. Only comparison against the real
documents catches that, and CI must never hold them — so this mode is local-only.

## Install

```bash
git clone https://github.com/amajail/dev-kit.git ~/repos/dev-kit
ln -s ~/repos/dev-kit/claude/CLAUDE.md ~/.claude/CLAUDE.md
ln -s ~/repos/dev-kit/claude/skills/claude-md-fix ~/.claude/skills/claude-md-fix
mkdir -p ~/.claude/hooks && ln -s ~/repos/dev-kit/hooks/git-guard.sh ~/.claude/hooks/git-guard.sh
```

Then register the hook in `~/.claude/settings.json` (PreToolUse, matcher `Bash`). `git-guard.sh`
resolves the symlink back to this checkout to find the scanner, so it works from wherever it is
linked.

## Tests

```bash
npm test    # node --test, zero dependencies
```

The suite is mostly adversarial: shell shapes that hid a `git add -f` from an earlier version of the
guard (subshells, command substitution, env prefixes, bundled flags), and heredoc bodies that must
read as data so that *documenting* the guard does not trip it.
