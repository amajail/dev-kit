// privacy-scan: allow-secrets
// This file necessarily contains credential-SHAPED strings to test the detector.
// Every one below is fabricated. Do not paste a real key here — the pragma above
// switches the credential check off for this file only.
//
// Run with: npm test  (node --test, zero dependencies)

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyCommand,
  splitSegments,
  createScanner,
  compileRules,
  loadConfig,
  toRegExp,
  DEFAULT_SECRET_PATTERNS,
  DEFAULT_PRIVATE_PATHS,
  DEFAULT_FIXTURE_PATHS,
} = require('../scripts/privacy-scan');

// A stand-in for a repo's .privacy-scan.json, close to my-finances' real rules
// so the ported assertions still mean what they meant there.
const scanner = createScanner({
  privatePaths: compileRules(
    [
      ...DEFAULT_PRIVATE_PATHS,
      ['(^|/)positions\\.json$', 'the live holdings mirror'],
      ['(^|/)scripts/[^/]*\\.local\\.[A-Za-z0-9]+$', 'a local-only script'],
      ['(^|/)scripts/update-[^/]*$', 'an ad-hoc bulk update script'],
      ['(^|/)docs/private/', 'an owner-private document'],
      ['(^|/)portfolio-report\\.html$', 'a rendered portfolio report'],
      ['(^|/)metaprompt-rebalance-plan\\.md$', 'a rebalance plan'],
      { pattern: '\\.csv$', what: 'possibly a broker export', unless: ['(^|/)tests/fixtures/'] },
    ],
    'privatePaths'
  ),
  secretPatterns: compileRules(DEFAULT_SECRET_PATTERNS, 'secretPatterns'),
  fixturePaths: DEFAULT_FIXTURE_PATHS.map(toRegExp),
  safePrefixes: ['src/', 'tests/', 'dashboard/', 'specs/', '.github/', 'docs/', 'scripts/'],
  safeRootFiles: new Set(['package.json', '.gitignore', 'README.md', 'CLAUDE.md', '.claude/settings.json']),
  privateTermsFile: null,
  refsDir: null,
  benignTokens: null,
  selfExempt: [],
  wording: { boundary: 'x', placeholders: 'y', confirm: 'z', fixHint: 'w' },
});

const { isPrivatePath, isSafeToStage, isFixturePath, scanLines, privatePathReason } = scanner;

describe('splitSegments', () => {
  test('splits on shell operators', () => {
    assert.deepEqual(splitSegments('ls && git add a ; echo hi'), ['ls', 'git add a', 'echo hi']);
  });

  test('does not split inside quotes', () => {
    assert.deepEqual(splitSegments('git commit -m "fix; and && stuff"'), ['git commit -m "fix; and && stuff"']);
  });
});

describe('classifyCommand', () => {
  test('ignores commands with no git invocation', () => {
    assert.deepEqual(classifyCommand('npm test'), []);
    assert.deepEqual(classifyCommand(''), []);
    assert.deepEqual(classifyCommand(undefined), []);
  });

  test('finds git after a quoted cd — the case an anchored regex would miss', () => {
    const [inv] = classifyCommand('cd "/tmp/a b" && git add secret.json');
    assert.equal(inv.verb, 'add');
    assert.deepEqual(inv.pathspecs, ['secret.json']);
  });

  test('detects force-add in long, short and bundled forms', () => {
    assert.equal(classifyCommand('git add -f x')[0].force, true);
    assert.equal(classifyCommand('git add --force x')[0].force, true);
    assert.equal(classifyCommand('git add -fA')[0].force, true);
  });

  test('does not treat push --force as an add-force', () => {
    const [inv] = classifyCommand('git push --force');
    assert.equal(inv.verb, 'push');
    assert.equal(inv.force, false);
  });

  test('detects broad adds', () => {
    for (const cmd of ['git add -A', 'git add .', 'git add :/', 'git add --all']) {
      assert.equal(classifyCommand(cmd)[0].broad, true, cmd);
    }
  });

  test('does not flag a targeted add as broad', () => {
    const [inv] = classifyCommand('git add src/index.js CLAUDE.md');
    assert.equal(inv.broad, false);
    assert.deepEqual(inv.pathspecs, ['src/index.js', 'CLAUDE.md']);
  });

  test('skips git global flags to reach the subcommand', () => {
    const [inv] = classifyCommand('git -C /repo add -f x');
    assert.equal(inv.verb, 'add');
    assert.equal(inv.force, true);
  });

  test('collects pathspecs after a double dash', () => {
    const [inv] = classifyCommand('git add -- scripts/positions.json');
    assert.deepEqual(inv.pathspecs, ['scripts/positions.json']);
  });

  test('extracts commit messages and unquotes them', () => {
    const [inv] = classifyCommand('git commit -m "fix: thing"');
    assert.deepEqual(inv.messages, ['fix: thing']);
    assert.equal(inv.deferMessage, false);
  });

  test('defers when the message comes from a file or an editor', () => {
    assert.equal(classifyCommand('git commit -F msg.txt')[0].deferMessage, true);
    assert.equal(classifyCommand('git commit')[0].deferMessage, true);
  });

  test('finds every git invocation in a chain', () => {
    const invs = classifyCommand('git add . && git commit -m "x" && git push');
    assert.deepEqual(invs.map((i) => i.verb), ['add', 'commit', 'push']);
  });
});

describe('isPrivatePath', () => {
  for (const p of [
    'scripts/positions.json',
    'scripts/update-bullmarket-2026-05-11.js',
    'scripts/plan-version.local.json',
    'docs/private/portfolio-framework-v3.md',
    'local.settings.json',
    '.env',
    '.env.local',
    'portfolio-report.html',
    'metaprompt-rebalance-plan.md',
    '.claude/settings.local.json',
  ]) {
    test(`protects ${p}`, () => assert.equal(isPrivatePath(p), true));
  }

  for (const p of [
    'src/domain/entities/Position.js',
    'scripts/positions.template.json',
    'scripts/seed-positions.js',
    'docs/research/README.md',
    'CLAUDE.md',
  ]) {
    test(`allows ${p}`, () => assert.equal(isPrivatePath(p), false));
  }

  test('reports WHY a path is protected, not just that it is', () => {
    assert.equal(privatePathReason('docs/private/x.md'), 'an owner-private document');
    assert.equal(privatePathReason('src/x.js'), null);
  });

  test('honours a per-rule `unless` exception', () => {
    // The shape my-expenses needs: CSV is a bank export everywhere except fixtures.
    assert.equal(isPrivatePath('data/export.csv'), true);
    assert.equal(isPrivatePath('tests/fixtures/sample.csv'), false);
  });

  test('privatePathExceptions can re-allow a path a DEFAULT rule denies', () => {
    // `unless` lives on a rule, so it cannot reach the built-in `.env` rule —
    // and my-finances commits `.env.test` (Azurite placeholders) on purpose.
    // Same scanner config, only the exception list differs.
    const base = {
      privatePaths: compileRules(DEFAULT_PRIVATE_PATHS, 'privatePaths'),
      secretPatterns: [],
      fixturePaths: [],
      safePrefixes: [],
      safeRootFiles: new Set(),
      selfExempt: [],
      wording: {},
    };
    const strict = createScanner(base);
    const lenient = createScanner({
      ...base,
      privatePathExceptions: ['(^|/)\\.env\\.test$', '(^|/)dashboard/\\.env\\.production$'].map(toRegExp),
    });

    assert.equal(strict.privatePathReason('.env.test'), 'an environment file');
    assert.equal(lenient.privatePathReason('.env.test'), null);
    assert.equal(lenient.privatePathReason('dashboard/.env.production'), null);
    // The exception is narrow: everything else the default rule denies stays denied.
    assert.equal(lenient.privatePathReason('.env'), 'an environment file');
    assert.equal(lenient.privatePathReason('.env.local'), 'an environment file');
    assert.equal(lenient.privatePathReason('dashboard/.env'), 'an environment file');
  });
});

describe('isSafeToStage', () => {
  test('accepts ordinary work areas and known root config', () => {
    assert.equal(isSafeToStage('src/functions/x.js'), true);
    assert.equal(isSafeToStage('specs/020-thing/plan.md'), true);
    assert.equal(isSafeToStage('package.json'), true);
    assert.equal(isSafeToStage('.claude/settings.json'), true);
  });

  test('rejects protected paths and unrecognised strays', () => {
    assert.equal(isSafeToStage('scripts/positions.json'), false);
    assert.equal(isSafeToStage('my-holdings-export.csv'), false);
    assert.equal(isSafeToStage('docs/private/x.md'), false);
  });
});

describe('isFixturePath', () => {
  test('recognises places where fake numbers belong', () => {
    assert.equal(isFixturePath('tests/unit/domain/Position.test.js'), true);
    assert.equal(isFixturePath('scripts/positions.template.json'), true);
    assert.equal(isFixturePath('scripts/allocation-targets.example.json'), true);
    assert.equal(isFixturePath('src/domain/entities/Position.js'), false);
  });
});

describe('scanLines — secrets', () => {
  for (const [text, label] of [
    ['AccountKey=abcdefghijklmnopqrstuvwx123456==', 'an Azure Storage AccountKey'],
    ['DefaultEndpointsProtocol=https;AccountName=x', 'an Azure Storage connection string'],
    ['const k = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA"', 'an Anthropic API key'],
    ['token: ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'a GitHub token'],
    ['"connectionString": "UseDevelopmentStorage=true;Extra=padding"', 'a connectionString literal'],
  ]) {
    test(`flags ${label}`, () => {
      const { secrets } = scanLines([{ path: 'src/x.js', text }]);
      assert.equal(secrets.length, 1);
      assert.equal(secrets[0].label, label);
    });
  }

  test('honours the allow-secrets pragma for the given file only', () => {
    const lines = [
      { path: 'tests/privacy-scan.test.js', text: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
      { path: 'src/config.js', text: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
    ];
    const allowsSecrets = (p) => p === 'tests/privacy-scan.test.js';
    const { secrets } = scanLines(lines, { allowsSecrets });
    assert.deepEqual(secrets, [{ path: 'src/config.js', label: 'a GitHub token' }]);
  });

  test('honours the line-level allow pragma', () => {
    const { secrets } = scanLines([
      { path: 'src/x.js', text: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789 // privacy-scan: allow' },
    ]);
    assert.deepEqual(secrets, []);
  });

  test('scans everything when no pragma checker is supplied', () => {
    const { secrets } = scanLines([{ path: 'anything.js', text: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }]);
    assert.equal(secrets.length, 1);
  });

  test('does not flag ordinary code', () => {
    const { secrets } = scanLines([
      { path: 'src/x.js', text: 'const total = quantity * averageCost;' },
      { path: 'src/x.js', text: "rowKey: `${assetType}__${symbol}`" },
      { path: 'src/x.js', text: 'const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;' },
    ]);
    assert.deepEqual(secrets, []);
  });

  test('does not flag save/restore of the connection-string env var', () => {
    // Regression: the first pass matched `NAME\s*=\s*\S+`, so this ordinary
    // beforeEach/afterEach boilerplate in my-afip's tests read as a credential.
    const { secrets } = scanLines([
      { path: 'tests/db.test.js', text: '    process.env.AZURE_STORAGE_CONNECTION_STRING = originalConn;' },
      { path: 'tests/db.test.js', text: "    process.env.AZURE_STORAGE_CONNECTION_STRING = 'UseDevelopmentStorage=true';" },
    ]);
    assert.deepEqual(secrets, []);
  });

  test('an unquoted .env-style connection string is still caught — by the other rules', () => {
    // Pinning the reasoning behind the tightened env-var rule: that rule needs
    // quotes, so it does NOT match a raw .env line. That is fine only because
    // the real credential shapes below catch it anyway (and .env is a blocked
    // path besides). If both of those ever change, this test fails loudly.
    const { secrets } = scanLines([
      {
        path: 'config/settings',
        text: 'AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=x;AccountKey=abcdefghijklmnopqrstuvwx1234==',
      },
    ]);
    assert.equal(secrets.length, 1);
  });

  test('still flags a quoted connection string assigned to that env var', () => {
    const { secrets } = scanLines([
      {
        path: 'src/x.js',
        text: "AZURE_STORAGE_CONNECTION_STRING = 'AccountName=x;EndpointSuffix=core.windows.net'",
      },
    ]);
    assert.equal(secrets.length, 1);
  });
});

describe('scanLines — private terms', () => {
  const terms = ['GOOGL', 'GD35'];

  test('flags a real term paired with a number outside fixtures', () => {
    const { terms: hits } = scanLines([{ path: 'scripts/x.js', text: 'GOOGL quantity 41 at 178.25' }], { terms });
    assert.deepEqual(hits, [{ path: 'scripts/x.js', term: 'GOOGL' }]);
  });

  test('ignores fixtures and examples', () => {
    const lines = [
      { path: 'tests/unit/x.test.js', text: 'GOOGL 41 178.25' },
      { path: 'scripts/positions.template.json', text: 'GD35 100 55.10' },
    ];
    assert.deepEqual(scanLines(lines, { terms }).terms, []);
  });

  test('ignores a term with no number beside it', () => {
    assert.deepEqual(scanLines([{ path: 'docs/x.md', text: 'GOOGL is a CEDEAR' }], { terms }).terms, []);
  });

  test('is inert when no term list is configured', () => {
    assert.deepEqual(scanLines([{ path: 'scripts/x.js', text: 'GOOGL 41 178.25' }]).terms, []);
  });

  test('does not match a term embedded in a longer word', () => {
    assert.deepEqual(scanLines([{ path: 'scripts/x.js', text: 'GOOGLE 41 178.25' }], { terms }).terms, []);
  });
});

describe('commit -a', () => {
  test('flags that -a stages tracked edits not yet in the index', () => {
    assert.equal(classifyCommand('git commit -a -m "x"')[0].stagesTracked, true);
    assert.equal(classifyCommand('git commit --all -m "x"')[0].stagesTracked, true);
    assert.equal(classifyCommand('git commit -am "x"')[0].stagesTracked, true);
    assert.deepEqual(classifyCommand('git commit -am "x"')[0].messages, ['x']);
  });

  test('leaves a plain commit reading the index', () => {
    assert.equal(classifyCommand('git commit -m "x"')[0].stagesTracked, false);
  });
});

describe('shell-shape bypasses', () => {
  for (const [label, cmd] of [
    ['subshell', '(git add -f x)'],
    ['grouped', '{ git add -f x; }'],
    ['command substitution', 'echo $(git add -f x)'],
    ['chained subshell', 'cd /tmp && (git add -f x)'],
    ['env prefix', 'FOO=1 git add -f x'],
    ['absolute path', '/usr/bin/git add -f x'],
    ['backgrounded', 'git add -f x &'],
  ]) {
    test(`still finds the invocation: ${label}`, () => {
      const invs = classifyCommand(cmd);
      assert.equal(invs.some((i) => i.verb === 'add' && i.force), true);
    });
  }

  test('treats -f after -- as a pathspec, not a flag', () => {
    const [inv] = classifyCommand('git add -- -f');
    assert.equal(inv.force, false);
    assert.deepEqual(inv.pathspecs, ['-f']);
  });
});

describe('heredoc bodies are data, not commands', () => {
  test('does not read a documented git command as a real one', () => {
    const cmd = [
      "cat > pr-body.md <<'EOF'",
      'Adversarial testing found `(git add -f x)` slipping through in a subshell.',
      'Any `git add -A` would have published it.',
      'EOF',
      'gh pr create --body-file pr-body.md',
    ].join('\n');
    assert.deepEqual(classifyCommand(cmd), []);
  });

  test('still sees a real git command outside the heredoc', () => {
    const cmd = ["cat > x.md <<'EOF'", 'git add -f nothing', 'EOF', 'git add -f real.json'].join('\n');
    const invs = classifyCommand(cmd);
    assert.equal(invs.length, 1);
    assert.deepEqual(invs[0].pathspecs, ['real.json']);
  });

  test('handles unquoted and dash-suppressed delimiters', () => {
    assert.deepEqual(classifyCommand(['cat <<EOF', 'git add -f x', 'EOF'].join('\n')), []);
    assert.deepEqual(classifyCommand(['cat <<-END', '\tgit add -f x', '\tEND'].join('\n')), []);
  });

  test('a git command quoted as an ARGUMENT is data, not an invocation', () => {
    // Found the hard way: testing this guard means echoing payloads that contain
    // `git add -f`, and my-expenses' inline grep — which this replaces — blocked
    // the test command itself. Tokenizing finds `printf` as the verb, not git.
    const cmd = `printf '{"tool_input":{"command":"git add -f x"}}' | ./git-guard.sh`;
    assert.deepEqual(classifyCommand(cmd), []);
  });
});

describe('config compilation', () => {
  test('supports an inline (?i) prefix for case-insensitive rules', () => {
    assert.equal(toRegExp('(?i)secret').test('SECRET'), true);
    assert.equal(toRegExp('secret').test('SECRET'), false);
  });

  test('supports lookahead, so a repo can exempt one known-safe value', () => {
    // The shape my-expenses needs: the well-known Azurite dev key is fine,
    // every other account key is a real credential.
    const only = createScanner({
      privatePaths: [],
      secretPatterns: compileRules(
        [['AccountKey=(?!DEVKEYDEVKEYDEVKEY)[A-Za-z0-9+/]{16,}={0,2}', 'a real account key']],
        'secretPatterns'
      ),
      fixturePaths: [],
      safePrefixes: [],
      safeRootFiles: new Set(),
      selfExempt: [],
      wording: {},
    });
    assert.deepEqual(only.scanLines([{ path: 'a.js', text: 'AccountKey=DEVKEYDEVKEYDEVKEY' }]).secrets, []);
    assert.equal(
      only.scanLines([{ path: 'a.js', text: 'AccountKey=REALREALREALREALREAL1234' }]).secrets.length,
      1
    );
  });

  test('names the offending rule when a regex is invalid', () => {
    assert.throws(() => compileRules([['[unclosed', 'x']], 'privatePaths'), /bad regex in privatePaths/);
  });
});

// These go through loadConfig, NOT a hand-built createScanner config. The
// lookahead test above passes only because it bypasses the merge: a repo's
// rules are ADDED to the defaults, so a narrow local rule cannot stop a broad
// default from matching first. Azurite's key reaching a repo's diff is the
// case that actually happens, so assert it against the merged rule set.
describe('default secret patterns, as merged by loadConfig', () => {
  const AZURITE_KEY =
    'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
  // No config file there, so this is the defaults and nothing else.
  const defaults = createScanner(loadConfig('/nonexistent-repo-for-tests'));
  const secretsIn = (text) => defaults.scanLines([{ path: 'docker-compose.yml', text }]).secrets;

  test('allows the published Azurite development key', () => {
    assert.deepEqual(secretsIn(`AccountKey=${AZURITE_KEY}`), []);
    assert.deepEqual(
      secretsIn(
        `AZURE_STORAGE_CONNECTION_STRING: "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;` +
          `AccountKey=${AZURITE_KEY};TableEndpoint=http://127.0.0.1:10002/devstoreaccount1;"`
      ),
      []
    );
  });

  test('allows folded YAML, where the protocol lands on its own line', () => {
    // docker-compose.yml writes the connection string as a `>-` block, so the
    // protocol and the key are separate added lines and no per-line lookahead
    // can tie them together.
    assert.deepEqual(secretsIn('        DefaultEndpointsProtocol=http;'), []);
    assert.deepEqual(secretsIn('        AccountName=devstoreaccount1;'), []);
  });

  test('still blocks any other account key, and any https connection string', () => {
    assert.equal(secretsIn('AccountKey=Zm9yZ2VkZm9yZ2VkZm9yZ2VkZm9yZ2VkMTIzNA==').length, 1);
    assert.equal(secretsIn('DefaultEndpointsProtocol=https;AccountName=realacct;').length, 1);
  });
});

describe('--tracked audit support', () => {
  test('carries a line number through when the caller supplies one', () => {
    // --tracked reports file:line. Diff modes do not have line numbers, so the
    // field is only present when given — an earlier version looked the hit back
    // up by matching on `text`, which scanLines does not return, so every
    // finding silently lost its location.
    const { secrets } = scanLines([
      { path: 'README.md', text: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789', line: 38 },
    ]);
    assert.equal(secrets.length, 1);
    assert.equal(secrets[0].line, 38);
  });

  test('omits the line field entirely for diff-mode callers', () => {
    const { secrets } = scanLines([
      { path: 'README.md', text: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
    ]);
    assert.deepEqual(secrets, [{ path: 'README.md', label: 'a GitHub token' }]);
  });

  test('never carries the offending text into a finding', () => {
    // Findings get printed. A secret's own value must not travel with it.
    const { secrets } = scanLines([
      { path: 'a.js', text: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', line: 1 },
    ]);
    assert.equal(Object.hasOwn(secrets[0], 'text'), false);
  });
});
