#!/usr/bin/env node
/**
 * privacy-scan — the machine-checkable half of a repo's privacy rules.
 *
 * Shared across the app family. The *engine* lives here; the *rules* live in
 * each repo's `.privacy-scan.json`, because they genuinely differ (holdings and
 * PPC in my-finances, statement PDFs and CBUs in my-expenses, AFIP certs and
 * CUITs in my-afip). One hard-coded rule set would mean false negatives in one
 * repo and false positives in the others.
 *
 * Five consumers:
 *   --hook            stdin is a Claude Code PreToolUse payload (see hooks/git-guard.sh)
 *   --staged          scan the index (for a local pre-commit hook)
 *   --range A...B     scan a commit range (CI)
 *   --tracked         audit EVERY tracked file, not just a diff (onboarding, periodic audit)
 *   --against-refs    LOCAL ONLY: compare tracked files against a real-document
 *                     corpus outside the repo (opt in via `refsDir` in config)
 *
 * Checks are bound to the git verb they can actually see. PreToolUse fires
 * BEFORE the command runs, so at `git add` time nothing is staged yet and
 * `git diff --cached` reads stale state — path checks go on `add`, content
 * checks go on `commit`/`push`.
 *
 * Two layers, deliberately different failure modes:
 *   hook  — fail-OPEN. Any error exits non-zero without a decision, which Claude
 *           Code treats as non-blocking. A guard that blocks all work gets
 *           deleted, and then nothing is enforced anywhere.
 *   CI    — fail-CLOSED. This is the real guarantee: the hook only ever sees
 *           commands *Claude* runs, CI sees everything that reaches a PR.
 *
 * Zero dependencies on purpose: the CI job runs it without `npm ci`.
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Defaults — the rules that are true for every repo in the family.
// A repo's .privacy-scan.json ADDS to these; it does not silently replace them.
// ---------------------------------------------------------------------------

/**
 * Azurite's development account key, published in Microsoft's own docs. All
 * three repos run their tests and their docker-compose against Azurite, so this
 * exact string is committed on purpose in all three. A default that flags it is
 * a guaranteed false positive, and a scanner that cries wolf on the documented
 * dev credential is a scanner people switch off.
 *
 * A repo cannot fix this from its own config: `.privacy-scan.json` ADDS to the
 * defaults, so a narrower local rule carrying this lookahead never gets a say —
 * the broad default has already matched. Hence the exemption lives here.
 */
const AZURITE_DEV_KEY =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

/** High-precision credential shapes. Near-zero false positives — these deny. */
const DEFAULT_SECRET_PATTERNS = [
  [`AccountKey\\s*=\\s*(?!${AZURITE_DEV_KEY})[A-Za-z0-9+/=]{16,}`, 'an Azure Storage AccountKey'],
  // `https` only, not `https?`. Azure never issues an http connection string, so
  // http means a local emulator — and in folded YAML the protocol lands on its
  // own line, away from the key, where the lookahead above cannot reach it.
  // Nothing is lost: a real account reached over http still carries a real
  // AccountKey, which the rule above catches whatever the protocol says.
  ['DefaultEndpointsProtocol\\s*=\\s*https\\s*;', 'an Azure Storage connection string'],
  ['SharedAccessSignature\\s*=', 'an Azure SAS token'],
  ['sk-ant-api\\d\\d-[A-Za-z0-9\\-_]{20,}', 'an Anthropic API key'],
  ['\\bgh[pousr]_[A-Za-z0-9]{30,}', 'a GitHub token'],
  ['github_pat_[A-Za-z0-9_]{20,}', 'a GitHub fine-grained PAT'],
  // Must be a quoted literal containing a `;` — real connection strings are
  // semicolon-delimited. Matching `NAME\s*=\s*\S+` instead flagged ordinary code
  // that merely assigns the env var (`process.env.X = originalConn`), and a
  // guard that cries wolf on save/restore boilerplate gets switched off.
  ['AZURE_STORAGE_CONNECTION_STRING\\s*=\\s*["\'][^"\']*;[^"\']*["\']', 'an Azure storage connection string'],
  ['"connectionString"\\s*:\\s*"[^"]{20,}"', 'a connectionString literal'],
  ['x-functions-key\\s*[:=]\\s*[\'"]?[A-Za-z0-9+/=_-]{20,}', 'an Azure Function App key'],
  [
    '(?i)\\b(AZURE_STATIC_WEB_APPS_API_TOKEN|AZURE_CREDENTIALS|CLIENT_SECRET)\\b\\s*[:=]\\s*["\']?[A-Za-z0-9+/_-]{16,}',
    'a deploy credential',
  ],
];

/** Paths every repo protects, regardless of domain. */
const DEFAULT_PRIVATE_PATHS = [
  ['(^|/)\\.env(\\.|$)', 'an environment file'],
  ['(^|/)local\\.settings\\.json$', 'local Azure settings'],
  ['(^|/)\\.claude/settings\\.local\\.json$', 'local Claude settings'],
  ['(^|/)\\.mcp\\.json$', 'machine-specific MCP config'],
];

/** Diff paths where fake numbers are the whole point. */
const DEFAULT_FIXTURE_PATHS = [
  '(^|/)tests?/',
  '\\.test\\.[jt]s$',
  '\\.spec\\.[jt]s$',
  '\\.template\\.[A-Za-z0-9]+$',
  '\\.example\\.[A-Za-z0-9]+$',
];

/**
 * Two escape hatches, both deliberately visible and greppable:
 *   line-level — `privacy-scan: allow` on the offending line
 *   file-level — `privacy-scan: allow-secrets` anywhere in the file
 * File-level is NOT a blanket tests/** exemption: a real key pasted into a test
 * file is still a leak. `grep -rn 'privacy-scan: allow'` lists every exemption.
 */
const ALLOW_LINE_PRAGMA = /privacy-scan:\s*allow(?!-secrets)/;
const ALLOW_SECRETS_PRAGMA = /privacy-scan:\s*allow-secrets/;

const DEFAULT_WORDING = {
  boundary: 'private data and credentials',
  placeholders: 'placeholder values',
  confirm: 'real private data',
  fixHint: 'If this rule is wrong, fix it in .privacy-scan.json — do not work around it.',
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_FILE = '.privacy-scan.json';

/**
 * Compile a [pattern, what] pair list from config. Config supplies regexes as
 * strings so a repo can express things JS literals cannot carry through JSON —
 * notably my-expenses' negative lookahead that exempts the well-known Azurite
 * dev key while still catching every other account key.
 */
function compileRules(rules, label) {
  return (rules || []).map((rule) => {
    const [pattern, what, unless] = Array.isArray(rule)
      ? [rule[0], rule[1], rule[2]]
      : [rule.pattern, rule.what, rule.unless];
    try {
      return {
        re: toRegExp(pattern),
        what: what || 'private data',
        unless: (unless || []).map(toRegExp),
      };
    } catch (err) {
      throw new Error(`${CONFIG_FILE}: bad regex in ${label}: ${pattern} (${err.message})`);
    }
  });
}

/** Support an inline `(?i)` prefix so JSON rules can be case-insensitive. */
function toRegExp(pattern) {
  const src = String(pattern);
  return src.startsWith('(?i)') ? new RegExp(src.slice(4), 'i') : new RegExp(src);
}

function loadConfig(cwd) {
  let raw = {};
  const file = path.join(cwd, CONFIG_FILE);
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`${CONFIG_FILE}: ${err.message}`);
    // No config — defaults still protect .env, credentials and local settings.
  }

  return {
    privatePaths: compileRules(
      [...DEFAULT_PRIVATE_PATHS, ...(raw.privatePaths || [])],
      'privatePaths'
    ),
    secretPatterns: compileRules(
      [...(raw.disableDefaultSecrets ? [] : DEFAULT_SECRET_PATTERNS), ...(raw.secretPatterns || [])],
      'secretPatterns'
    ),
    // A rule's own `unless` cannot reach the DEFAULTS — a repo cannot append an
    // `unless` to the built-in `.env` rule. But `.env.test` holding Azurite
    // placeholders is committed on purpose in my-finances, so there has to be a
    // way to re-allow a path a default rule denies. This list is checked before
    // every rule, defaults included. Keep it to named files: it is the one
    // switch that can silence a default deny.
    privatePathExceptions: (raw.privatePathExceptions || []).map(toRegExp),
    fixturePaths: (raw.fixturePaths || DEFAULT_FIXTURE_PATHS).map(toRegExp),
    safePrefixes: raw.safePrefixes || [],
    safeRootFiles: new Set(raw.safeRootFiles || []),
    privateTermsFile: raw.privateTermsFile || null,
    refsDir: raw.refsDir || null,
    benignTokens: raw.benignTokens ? toRegExp(raw.benignTokens) : null,
    selfExempt: (raw.selfExempt || []).map(toRegExp),
    wording: { ...DEFAULT_WORDING, ...(raw.wording || {}) },
  };
}

// ---------------------------------------------------------------------------
// Command parsing — see tests/privacy-scan.test.js for the bypasses this closes
// ---------------------------------------------------------------------------

/**
 * Split a shell command into segments on `&&`, `||`, `;`, `|`, and newlines,
 * respecting single and double quotes. Good enough to find git invocations;
 * it is not a shell.
 */
function splitSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        current += ch + command[++i];
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    // `(`/`)`/`{`/`}` are separators too, so a subshell like `(git add -f x)`
    // does not hide the invocation behind a `(git` token.
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      segments.push(current);
      current = '';
      continue;
    }

    current += ch;
  }
  segments.push(current);

  return segments.map((s) => s.trim()).filter(Boolean);
}

/** Tokenize one segment, stripping one level of quoting. */
function tokenize(segment) {
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];

    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < segment.length) {
        current += segment[++i];
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current || started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }

    current += ch;
  }
  if (current || started) tokens.push(current);

  return tokens;
}

/** Global git flags that consume the following token. */
const GIT_FLAGS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

/**
 * Remove heredoc bodies before looking for git invocations. Text written into
 * a file is data, not a command — `cat > notes.md <<'EOF'` containing the words
 * `git add -f` must not read as a force-add. Without this, documenting the
 * guard trips the guard.
 *
 * Known limit: `bash <<'EOF'` genuinely executes its body, and that body is
 * dropped here too. Rare enough to accept, and CI still scans the result.
 */
function stripHeredocs(command) {
  if (!command.includes('<<')) return command;

  const START = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  const kept = [];
  let delimiter = null;

  for (const line of command.split('\n')) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null;
      continue; // drop the body and its terminator
    }
    kept.push(line);
    const starts = [...line.matchAll(START)];
    if (starts.length) delimiter = starts[0][2];
  }

  return kept.join('\n');
}

/**
 * Find every git invocation in a command and describe it.
 *
 * @returns {Array<{verb: string, args: string[], force: boolean, broad: boolean,
 *                  pathspecs: string[], messages: string[], deferMessage: boolean}>}
 */
function classifyCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return [];

  const invocations = [];

  for (const segment of splitSegments(stripHeredocs(command))) {
    const tokens = tokenize(segment);

    let i = 0;
    // Skip leading env assignments (FOO=bar git ...).
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;

    const cmd = tokens[i];
    if (!cmd || !/(^|\/)git$/.test(cmd)) continue;
    i++;

    // Skip git's own global flags to reach the subcommand.
    while (i < tokens.length && tokens[i].startsWith('-')) {
      if (GIT_FLAGS_WITH_VALUE.has(tokens[i]) && !tokens[i].includes('=')) i++;
      i++;
    }

    const verb = tokens[i];
    if (!verb) continue;
    const args = tokens.slice(i + 1);

    invocations.push(describe(verb, args));
  }

  return invocations;
}

function describe(verb, args) {
  const inv = {
    verb,
    args,
    force: false,
    broad: false,
    pathspecs: [],
    messages: [],
    deferMessage: false,
    stagesTracked: false,
  };

  let afterDoubleDash = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (afterDoubleDash) {
      inv.pathspecs.push(arg);
      continue;
    }
    if (arg === '--') {
      afterDoubleDash = true;
      continue;
    }

    if (arg.startsWith('-')) {
      if (verb === 'add' && (arg === '-f' || arg === '--force')) inv.force = true;
      if (verb === 'add' && (arg === '-A' || arg === '--all' || arg === '-u' || arg === '--update')) {
        inv.broad = true;
      }
      // Bundled short flags: -fA, -Af, -nf …
      if (verb === 'add' && /^-[A-Za-z]{2,}$/.test(arg)) {
        if (arg.includes('f')) inv.force = true;
        if (arg.includes('A') || arg.includes('u')) inv.broad = true;
      }

      if (verb === 'commit') {
        // `-a` stages tracked modifications as part of the commit, so at hook
        // time the index does NOT yet contain them. A tracked file edited after
        // its last clean `git add` never passed an add-time gate, so this is a
        // real path for a secret to reach a commit — scan the worktree instead.
        if (arg === '-a' || arg === '--all') inv.stagesTracked = true;
        if (/^-[A-Za-z]{2,}$/.test(arg) && arg.includes('a')) inv.stagesTracked = true;

        if (arg === '-m' || arg === '--message') {
          if (args[i + 1] !== undefined) inv.messages.push(args[++i]);
        } else if (arg.startsWith('--message=')) {
          inv.messages.push(arg.slice('--message='.length));
        } else if (arg === '-F' || arg === '--file' || arg.startsWith('--file=')) {
          // Message comes from a file we cannot see — skip the message check.
          inv.deferMessage = true;
        } else if (/^-[A-Za-z]{2,}$/.test(arg) && arg.includes('m')) {
          if (args[i + 1] !== undefined) inv.messages.push(args[++i]);
        }
      }
      continue;
    }

    inv.pathspecs.push(arg);
  }

  if (verb === 'add') {
    // `.`, `:/`, `*` stage far more than they name.
    if (inv.pathspecs.some((p) => p === '.' || p === ':/' || p === '*' || p === './' || p === ':/*')) {
      inv.broad = true;
    }
  }

  if (verb === 'commit' && inv.messages.length === 0 && !inv.deferMessage) {
    // Editor-based commit — message not visible at hook time.
    inv.deferMessage = true;
  }

  return inv;
}

// ---------------------------------------------------------------------------
// Scanner — bound to one repo's config
// ---------------------------------------------------------------------------

function createScanner(config) {
  /** @returns {string|null} what the path is, if it must never be staged */
  function privatePathReason(p) {
    const norm = String(p).replace(/^\.\//, '');
    if ((config.privatePathExceptions || []).some((re) => re.test(norm))) return null;
    for (const rule of config.privatePaths) {
      if (!rule.re.test(norm)) continue;
      if (rule.unless.some((re) => re.test(norm))) continue;
      return rule.what;
    }
    return null;
  }

  function isPrivatePath(p) {
    return privatePathReason(p) !== null;
  }

  function isFixturePath(p) {
    return config.fixturePaths.some((re) => re.test(String(p)));
  }

  /** Where ordinary work lives. Anything else in a broad `git add` prompts the owner. */
  function isSafeToStage(p) {
    const norm = String(p).replace(/^\.\//, '');
    if (isPrivatePath(norm)) return false;
    if (config.safeRootFiles.has(norm)) return true;
    return config.safePrefixes.some((prefix) => norm.startsWith(prefix));
  }

  /** A file that necessarily contains the patterns it looks for is content-exempt. */
  function isSelfExempt(p) {
    return config.selfExempt.some((re) => re.test(String(p)));
  }

  /**
   * Scan added diff lines for secrets, and optionally for owner private terms.
   *
   * @param {Array<{path: string, text: string}>} lines
   * @param {{terms?: string[], allowsSecrets?: (path: string) => boolean}} [opts]
   * @returns {{secrets: object[], terms: object[]}}
   */
  function scanLines(lines, opts = {}) {
    const secrets = [];
    const termHits = [];
    const termList = (opts.terms || []).filter(Boolean);
    const allowsSecrets = opts.allowsSecrets || (() => false);

    for (const { path: p, text, line } of lines) {
      if (!allowsSecrets(p) && !isSelfExempt(p) && !ALLOW_LINE_PRAGMA.test(text)) {
        for (const rule of config.secretPatterns) {
          if (rule.re.test(text)) {
            // `line` is carried through only when the caller supplied one
            // (--tracked does; diff modes do not). Never carry `text` — a hit
            // is by definition private, and findings get printed.
            secrets.push(line === undefined ? { path: p, label: rule.what } : { path: p, label: rule.what, line });
            break;
          }
        }
      }

      if (termList.length && !isFixturePath(p) && /\d[\d.,]{2,}/.test(text)) {
        const hit = termList.find((t) => new RegExp(`\\b${escapeRegExp(t)}\\b`).test(text));
        if (hit) termHits.push({ path: p, term: hit });
      }
    }

    return { secrets, terms: termHits };
  }

  return { privatePathReason, isPrivatePath, isFixturePath, isSafeToStage, isSelfExempt, scanLines };
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// git helpers (all failures are non-fatal — the caller decides)
// ---------------------------------------------------------------------------

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Files a broad `git add` would newly stage. */
function wouldStage(cwd) {
  const out = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
  const entries = out.split('\0').filter(Boolean);
  const paths = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const index = entry[0];
    const worktree = entry[1];
    const p = entry.slice(3);

    // Renames carry a second \0-separated source path — consume it.
    if (index === 'R' || index === 'C') i++;

    if (index === '?' || worktree !== ' ') paths.push(p);
  }

  return paths;
}

/** Added lines from a diff, tagged with their file. */
function addedLines(diffArgs, cwd) {
  const out = git(['diff', '--unified=0', '--no-color', ...diffArgs], cwd);
  const lines = [];
  let p = '(unknown)';

  for (const line of out.split('\n')) {
    if (line.startsWith('+++ b/')) {
      p = line.slice('+++ b/'.length);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      lines.push({ path: p, text: line.slice(1) });
    }
  }

  return lines;
}

function changedPaths(diffArgs, cwd) {
  return git(['diff', '--name-only', '--diff-filter=d', ...diffArgs], cwd).split('\n').filter(Boolean);
}

/**
 * Does this file carry the file-level allow pragma? Reads the working tree,
 * present in all modes (CI checks out the head of the range). An unreadable
 * file means no exemption — fail toward scanning.
 */
function makePragmaChecker(cwd) {
  const cache = new Map();

  return (p) => {
    if (cache.has(p)) return cache.get(p);
    let allowed = false;
    try {
      allowed = ALLOW_SECRETS_PRAGMA.test(fs.readFileSync(path.join(cwd, p), 'utf8'));
    } catch {
      allowed = false;
    }
    cache.set(p, allowed);
    return allowed;
  };
}

/**
 * The owner's private term list (tickers, merchant names), if configured.
 * Deliberately gitignored: a committed list of real terms is itself a
 * disclosure. Consequence — CI can never run this check.
 */
function loadTerms(cwd, config) {
  if (!config.privateTermsFile) return [];
  try {
    return fs
      .readFileSync(path.join(cwd, config.privateTermsFile), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Hook mode (fail-open)
// ---------------------------------------------------------------------------

function emit(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

/** No opinion — let the normal permission flow decide. */
function passThrough() {
  process.exit(0);
}

function runHook(payload, cwd, config, scanner) {
  const command = payload && payload.tool_input && payload.tool_input.command;
  const invocations = classifyCommand(command);
  if (!invocations.length) passThrough();

  const { privatePathReason, isPrivatePath, isSafeToStage, scanLines } = scanner;
  const allowsSecrets = makePragmaChecker(cwd);
  const W = config.wording;
  const asks = [];

  for (const inv of invocations) {
    if (inv.verb === 'add') {
      // FORCE_ADD — .gitignore is the privacy boundary; -f exists only to cross it.
      if (inv.force) {
        emit(
          'deny',
          '`git add -f` bypasses .gitignore, which is this repo\'s privacy boundary ' +
            `(${W.boundary} are protected by it).\n` +
            'If the file is genuinely safe to publish, add a negation to .gitignore in its own commit, ' +
            'then stage it normally.\n' +
            W.fixHint
        );
      }

      // PRIVATE_PATH — named a protected file outright.
      const named = inv.pathspecs.filter(isPrivatePath);
      if (named.length) {
        emit(
          'deny',
          'These paths must not be staged:\n' +
            named.map((p) => `  - ${p} — ${privatePathReason(p)}`).join('\n') +
            `\nThey are already covered by .gitignore. Use ${W.placeholders} in anything committed.\n` +
            W.fixHint
        );
      }

      // BROAD_ADD — heuristic, so ask rather than deny.
      if (inv.broad) {
        let staging;
        try {
          staging = wouldStage(cwd);
        } catch {
          continue; // git unavailable — fail open
        }
        const priv = staging.filter(isPrivatePath);
        const unknown = staging.filter((p) => !isPrivatePath(p) && !isSafeToStage(p));

        if (priv.length) {
          emit(
            'deny',
            'A broad `git add` here would stage protected files:\n' +
              priv.map((p) => `  - ${p} — ${privatePathReason(p)}`).join('\n') +
              '\nStage explicit paths instead: git add <path>.\n' +
              W.fixHint
          );
        }
        if (unknown.length) {
          asks.push(
            `\`${inv.verb} ${inv.args.join(' ')}\` would stage files outside the usual work areas:\n` +
              unknown.slice(0, 15).map((p) => `  - ${p}`).join('\n') +
              (unknown.length > 15 ? `\n  … and ${unknown.length - 15} more` : '') +
              `\nConfirm none of them contain ${W.confirm}.`
          );
        }
      }
    }

    if (inv.verb === 'commit') {
      // `-a` will stage tracked edits that are not in the index yet, so
      // `--cached` would read an empty diff and silently find nothing.
      const base = inv.stagesTracked ? ['HEAD'] : ['--cached'];
      let lines = [];
      try {
        lines = addedLines(base, cwd);
      } catch {
        continue; // fail open
      }

      const terms = loadTerms(cwd, config);
      const { secrets, terms: termHits } = scanLines(lines, { terms, allowsSecrets });

      if (secrets.length) {
        emit(
          'deny',
          'The staged changes contain what looks like a credential:\n' +
            dedupe(secrets.map((s) => `  - ${s.label} in ${s.path}`)).join('\n') +
            '\nRemove it and use an env var or local.settings.json (both gitignored).\n' +
            W.fixHint
        );
      }

      // The commit message is un-rewritable once pushed.
      if (!inv.deferMessage && inv.messages.length) {
        const msgLines = inv.messages.map((m) => ({ path: '(commit message)', text: m }));
        const msg = scanLines(msgLines, { terms }); // messages have no file to carry a pragma
        if (msg.secrets.length) {
          emit(
            'deny',
            'The commit message contains what looks like a credential ' +
              `(${msg.secrets[0].label}). Commit messages cannot be rewritten after pushing.\n` +
              W.fixHint
          );
        }
        if (msg.terms.length) {
          asks.push(
            `The commit message mentions ${msg.terms[0].term} alongside a number. ` +
              'Commit messages cannot be rewritten after pushing — confirm it holds no real data.'
          );
        }
      }

      if (termHits.length) {
        asks.push(
          'Staged changes pair a real private term with a number:\n' +
            dedupe(termHits.map((h) => `  - ${h.term} in ${h.path}`)).join('\n') +
            '\nConfirm these are placeholders, not real data.'
        );
      }
    }

    if (inv.verb === 'push') {
      let range;
      try {
        git(['rev-parse', '--abbrev-ref', '@{u}'], cwd);
        range = '@{u}..HEAD';
      } catch {
        range = 'origin/main..HEAD';
      }

      let paths = [];
      let lines = [];
      try {
        paths = changedPaths([range], cwd);
        lines = addedLines([range], cwd);
      } catch {
        continue; // fail open
      }

      const priv = paths.filter(isPrivatePath);
      if (priv.length) {
        emit(
          'deny',
          'This push contains commits touching protected paths:\n' +
            priv.map((p) => `  - ${p} — ${privatePathReason(p)}`).join('\n') +
            '\nPushing publishes them irreversibly. Rewrite the history first.\n' +
            W.fixHint
        );
      }

      const { secrets } = scanLines(lines, { allowsSecrets });
      if (secrets.length) {
        emit(
          'deny',
          'This push contains what looks like a credential:\n' +
            dedupe(secrets.map((s) => `  - ${s.label} in ${s.path}`)).join('\n') +
            '\nRotate it and rewrite the history before pushing.\n' +
            W.fixHint
        );
      }
    }
  }

  if (asks.length) emit('ask', asks.join('\n\n'));
  passThrough();
}

function dedupe(arr) {
  return [...new Set(arr)];
}

// ---------------------------------------------------------------------------
// CI / pre-commit mode (fail-closed: non-zero exit on findings)
// ---------------------------------------------------------------------------

function runScan(diffArgs, scope, cwd, config, scanner) {
  const paths = changedPaths(diffArgs, cwd);
  const lines = addedLines(diffArgs, cwd);
  const { privatePathReason, scanLines } = scanner;

  const problems = [];
  const flagged = new Set();

  for (const p of paths) {
    const what = privatePathReason(p);
    if (what) {
      problems.push(`  ${p}\n      is ${what}`);
      flagged.add(p);
    }
  }

  // Don't pile content hits on top of a path that is already blocked.
  const contentLines = lines.filter((l) => !flagged.has(l.path));
  const { secrets } = scanLines(contentLines, {
    terms: loadTerms(cwd, config),
    allowsSecrets: makePragmaChecker(cwd),
  });
  for (const s of dedupe(secrets.map((x) => `  ${x.path}\n      added line looks like ${x.label}`))) {
    problems.push(s);
  }

  if (problems.length) {
    process.stderr.write(
      `privacy-scan: BLOCKED — ${problems.length} problem(s) in ${scope}\n\n` +
        problems.join('\n') +
        `\n\n  ${config.wording.fixHint}\n`
    );
    process.exit(1);
  }

  process.stdout.write(
    `privacy-scan: clean — ${paths.length} file(s), ${lines.length} added line(s) in ${scope}\n`
  );
}

// ---------------------------------------------------------------------------
// --tracked (audit): every tracked file, every line
// ---------------------------------------------------------------------------

/**
 * Audit the whole working tree rather than a diff.
 *
 * `--range` and `--staged` only ever see ADDED lines. That is correct for a PR
 * gate — pre-existing text must not re-fail every later PR — but it means
 * anything committed before the scanner existed is permanently invisible to it.
 * A real CUIT sat in my-afip's README for three months while `--range` runs
 * reported clean, because the line never changed again.
 *
 * So this mode covers the two moments a diff cannot: onboarding a repo to the
 * scanner, and periodic audit. It is deliberately NOT wired into CI — on an
 * established repo it reports history rather than regressions, and a gate that
 * fails for reasons the current PR did not cause is a gate people switch off.
 */
function runTrackedAudit(cwd, config, scanner) {
  const { privatePathReason, scanLines } = scanner;
  const allowsSecrets = makePragmaChecker(cwd);
  const paths = git(['ls-files'], cwd).split('\n').filter(Boolean);

  const pathHits = [];
  const lines = [];
  let skipped = 0;

  for (const p of paths) {
    const what = privatePathReason(p);
    if (what) pathHits.push({ path: p, what });

    if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|pdf|zip|gz|tgz|mp4|lock)$/i.test(p)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(cwd, p), 'utf8');
    } catch {
      skipped++;
      continue;
    }
    if (text.includes('\0')) continue; // binary
    text.split('\n').forEach((t, i) => lines.push({ path: p, text: t, line: i + 1 }));
  }

  const { secrets } = scanLines(lines, { terms: loadTerms(cwd, config), allowsSecrets });

  const located = dedupe(
    secrets.map((s) => `  ${s.path}${s.line ? `:${s.line}` : ''}\n      looks like ${s.label}`)
  );

  const problems = [...pathHits.map((h) => `  ${h.path}\n      is ${h.what}`), ...located];

  if (problems.length) {
    process.stderr.write(
      `privacy-scan: ${problems.length} finding(s) across ${paths.length} tracked file(s)\n\n` +
        problems.join('\n') +
        '\n\n  These are pre-existing, so a diff-based scan cannot see them.\n' +
        '  Anything already pushed should be treated as published: redacting now\n' +
        '  does not unpublish it.\n' +
        `\n  ${config.wording.fixHint}\n`
    );
    process.exit(1);
  }

  process.stdout.write(
    `privacy-scan: clean — ${paths.length} tracked file(s) audited` +
      (skipped ? `, ${skipped} unreadable` : '') +
      '\n'
  );
}

// ---------------------------------------------------------------------------
// --against-refs (local only)
// ---------------------------------------------------------------------------

/**
 * Report tracked-file tokens that also appear in a real-document corpus.
 *
 * This closes a gap the other modes structurally cannot. They match *patterns*
 * — something shaped like a key, 22 digits shaped like a CBU. An ordinary
 * peso amount is not a pattern, so a real balance copied verbatim into a test
 * fixture sails straight through. Only comparison against the real documents
 * catches that, and CI must never hold them — so this mode is local-only.
 *
 * Deliberately precise about output: it reports the token and the file, never
 * the surrounding real-document context.
 */
const VALUE_TOKEN = /\d{1,3}(?:\.\d{3})*,\d{2}|(?<!\d)\d{5,}(?!\d)/g;

function scanAgainstRefs(cwd, config) {
  if (!config.refsDir) {
    process.stderr.write('privacy-scan: --against-refs needs "refsDir" in .privacy-scan.json\n');
    return 2;
  }
  const refsDir = config.refsDir.replace(/^~(?=$|\/)/, process.env.HOME || '~');

  if (!fs.existsSync(refsDir) || !fs.statSync(refsDir).isDirectory()) {
    process.stdout.write(`privacy-scan: no reference dumps at ${refsDir} — nothing to compare against\n`);
    return 0;
  }

  const real = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.txt')) real.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(refsDir);

  if (!real.length) {
    process.stdout.write(`privacy-scan: no .txt dumps under ${refsDir} — nothing to compare against\n`);
    return 0;
  }
  const corpus = real.join('\n');

  const hits = [];
  for (const p of git(['ls-files'], cwd).split('\n').filter(Boolean)) {
    if (/\.(png|jpg|jpeg|woff2?|lock|pdf)$/i.test(p)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(cwd, p), 'utf8');
    } catch {
      continue;
    }
    const seen = new Set();
    for (const token of text.match(VALUE_TOKEN) || []) {
      if (seen.has(token)) continue;
      if (config.benignTokens && config.benignTokens.test(token)) continue;
      seen.add(token);
      if (corpus.includes(token)) hits.push({ path: p, token });
    }
  }

  if (hits.length) {
    process.stdout.write(
      `privacy-scan: ${hits.length} token(s) in tracked files also appear in your real documents\n\n`
    );
    for (const h of hits) process.stdout.write(`  ${h.path}\n      ${h.token}\n`);
    process.stdout.write(
      '\n  These may be coincidence (a round number) or a verbatim copy.\n' +
        '  Re-invent anything that came from a real document — keep the shape,\n' +
        '  change the digits, so the regression it exercises still fires.\n'
    );
    return 1;
  }

  process.stdout.write('privacy-scan: no tracked file shares a value with your real documents\n');
  return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main(argv) {
  // CLI modes always mean "the repo I am standing in". CLAUDE_PROJECT_DIR is a
  // hook-only fallback: a Claude session rooted in one repo can run a Bash
  // command in another, and only the payload knows which.
  const cwd = process.cwd();

  if (argv.includes('--hook')) {
    // Every failure path here exits non-zero WITHOUT emitting a decision: a
    // non-zero exit is a non-blocking error, so the tool proceeds (fail-open).
    // One terse line, never a stack trace — this lands in the user's session.
    try {
      const payload = JSON.parse(readStdin());
      const hookCwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || cwd;
      const config = loadConfig(hookCwd);
      runHook(payload, hookCwd, config, createScanner(config));
    } catch (err) {
      process.stderr.write(`privacy-scan: skipped (${err.message})\n`);
      process.exit(1);
    }
    return;
  }

  let config;
  try {
    config = loadConfig(cwd);
  } catch (err) {
    process.stderr.write(`privacy-scan: ${err.message}\n`);
    process.exit(2);
  }
  const scanner = createScanner(config);

  if (argv.includes('--against-refs')) {
    process.exit(scanAgainstRefs(cwd, config));
  }

  if (argv.includes('--tracked')) {
    runTrackedAudit(cwd, config, scanner);
    return;
  }

  if (argv.includes('--staged')) {
    runScan(['--cached'], 'staged changes', cwd, config, scanner);
    return;
  }

  const rangeIdx = argv.indexOf('--range');
  if (rangeIdx !== -1 && argv[rangeIdx + 1]) {
    runScan([argv[rangeIdx + 1]], argv[rangeIdx + 1], cwd, config, scanner);
    return;
  }

  process.stderr.write(
    'usage: privacy-scan.js (--hook | --staged | --range <A...B> | --tracked | --against-refs)\n'
  );
  process.exit(2);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  classifyCommand,
  splitSegments,
  tokenize,
  stripHeredocs,
  createScanner,
  loadConfig,
  compileRules,
  toRegExp,
  DEFAULT_SECRET_PATTERNS,
  DEFAULT_PRIVATE_PATHS,
  DEFAULT_FIXTURE_PATHS,
};
