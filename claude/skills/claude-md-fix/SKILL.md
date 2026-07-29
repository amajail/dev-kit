---
name: "claude-md-fix"
description: "Fix the repo guidance that let Claude get something wrong. Finds the CLAUDE.md sentence (or gap) that permitted the error, classifies it, and lands the fix where it will actually hold — a privacy-scan rule, a .gitignore entry, the repo's canonical doc, or a rewritten line in CLAUDE.md. Use when the owner corrects Claude on a convention, or after a privacy-scan block that turned out to be wrong."
metadata:
  author: "dev-kit"
user-invocable: true
disable-model-invocation: false
---

# claude-md-fix

Invoked as `/claude-md-fix "<what went wrong>"`. Repo-agnostic: it works in any repo, and reads
whatever guidance that repo actually has.

The point is **not** to add a rule. It is to work out why the existing guidance failed and put the
fix at the layer that will hold. Most of the time the right outcome is a rule moving *out* of
CLAUDE.md, or a rule getting shorter.

## 1. Find the sentence

Quote the exact line that permitted the error — from the repo's `CLAUDE.md`, from `~/.claude/CLAUDE.md`
(the shared rules), or from the repo's canonical doc if it has one (step 3) — or state plainly that
no line covers it.

If you cannot find a sentence and the gap isn't real either, **stop**. Not every mistake is a
documentation bug; sometimes the guidance was right and was simply not followed, which is case (D).

## 2. Classify

**(A) Hard rule, machine-checkable.** Land it in enforcement, then **delete the prose**. Never keep
both — prose kept "as a backstop" alongside a check teaches that unenforced prose is normal. In
order of preference:

1. a `.gitignore` entry, if the rule is "this must never be committed";
2. a rule in this repo's `.privacy-scan.json` (schema: `~/repos/dev-kit/schema/privacy-scan.schema.json`);
3. a new check in the shared engine, `~/repos/dev-kit/scripts/privacy-scan.js`, **plus** a test in
   `~/repos/dev-kit/tests/privacy-scan.test.js` — same commit, and that is a dev-kit PR, not this repo's;
4. a repo test, if the rule is about code behaviour rather than what gets published.

**(B) Hard rule, not checkable.** Rewrite it: specific, and it must **name the replacement action**,
not only forbid. The model to match is "Use obvious placeholders (`SYMBOL`, `123.45`, `BROKER`)" —
it says what to do instead. If this rule needs emphasis, something else must lose it (step 4).

**(C) Preference, not a rule.** Rewrite plainly or delete. Never emphasize.

**(D) Already stated correctly, and Claude ignored it.** Do **not** restate it louder. Repetition
and bold are what produce a 14-line section that fails anyway. Choose one of:
- move it earlier in the file (position beats volume),
- promote it to a check (case A),
- or accept it as unenforceable and delete it.

## 3. Check the canonical doc, and the shared file

Some repos have a document that supersedes CLAUDE.md on conflict — `.specify/memory/constitution.md`
in a speckit repo, `specs.md` in my-expenses. If one exists and states the same rule:

- edit it **there** (constitution: version bump + Sync Impact Report entry);
- leave at most a one-line imperative + `(canonical: <doc> §N)` in CLAUDE.md.

A fix applied only to CLAUDE.md is inert whenever the two disagree, so check for a contradiction even
when you are not editing the canonical doc.

Then check `~/.claude/CLAUDE.md`. If the rule is true for *every* repo, it belongs there and gets
deleted here; if it is already there and the repo file restates it, delete the restatement. That file
lives in `~/repos/dev-kit/claude/CLAUDE.md` — editing it is a dev-kit PR.

CLAUDE.md never states a rationale. Rationale lives in exactly one place.

## 4. Budget check

Per file: soft cap **80 lines** and **3 bold spans**. If the edit adds more than 4 lines net, delete
something else in the same edit. If it needs a fourth bold span, one of the existing three isn't
earning it — demote that one first, and say which in your summary.

## 5. Log it

Append one row to the log:

```
| date | what Claude did | the sentence that permitted it | class | where the fix landed |
```

Log path: `docs/claude-md-log.md` if the repo has a `docs/` directory, otherwise
`.claude/claude-md-log.md`. Whichever exists already wins; create it with the header row if neither
does. The log lives outside CLAUDE.md and is never `@import`ed — it grows without bound and would
otherwise cost tokens in every session.

## The graduation rule

Before writing the row, grep the log for the same rule. **If this is its third appearance, prose has
failed and is not allowed a fourth try.** It must become a check or a `.gitignore` entry, or be
deleted as unenforceable. Say so explicitly in your summary rather than filing another prose tweak.

## Finally

Report: the sentence, the classification, where the fix landed, what you deleted to stay in budget,
and — if applicable — that the graduation rule fired.
