#!/usr/bin/env bash
# Claude Code PreToolUse guard on Bash. Registered once in ~/.claude/settings.json,
# so it covers every repo in the family rather than each repo wiring its own.
#
# The matcher fires on EVERY Bash call, and Node startup costs 100-300 ms, so
# grep the raw payload and bail before spawning Node for the 95% case.
#
# The grep is deliberately unanchored. Matching the JSON structure
# ("command"\s*:\s*"[^"]*git +add) breaks on any quoted segment before the verb
# — `cd "/a b" && git add secret` would slip past. Over-triggering is harmless
# here (privacy-scan re-decides precisely); under-triggering is the failure.
#
# Any non-zero exit is a non-blocking error in Claude Code: the tool proceeds.
# That is the intended fail-open behaviour — a guard that blocks all work gets
# deleted, and then nothing is enforced anywhere. CI is the real guarantee.

set -uo pipefail

# Resolve through the symlink in ~/.claude/hooks back to the dev-kit checkout,
# so the scanner sitting next door is found wherever this is linked from.
source_path="${BASH_SOURCE[0]}"
if command -v readlink >/dev/null 2>&1; then
  resolved=$(readlink -f "$source_path" 2>/dev/null) && source_path="$resolved"
fi
kit_root="$(cd "$(dirname "$source_path")/.." && pwd)"
scanner="$kit_root/scripts/privacy-scan.js"

input=$(cat)

printf '%s' "$input" | grep -qE 'git[[:space:]]+(add|commit|push)' || exit 0

# No scanner (bad symlink, moved checkout) must not block work — but say so,
# because a guard that silently stopped guarding is worse than a noisy one.
if [ ! -f "$scanner" ]; then
  printf 'privacy-scan: scanner not found at %s — guard inactive\n' "$scanner" >&2
  exit 1
fi

printf '%s' "$input" | node "$scanner" --hook
