# @amajail/money

Money (ARS/USD), es-AR formatting, `YYYY-MM` month keys, and a MEP fetcher with an
**explicit** failure state — shared by my-afip / my-finances / my-expenses (Node backends and
Astro dashboards; the Python backend shares conventions only).

Dependency-free CommonJS. Family roadmap Slice E (`dev-kit/ROADMAP.md`).

## Install — pin by tag, never floating

Consumers pin the release tarball (dev-kit is a private root package; the tarball is what a
tag ships). `/family-check` flags drift and floating pins:

```json
"@amajail/money": "https://github.com/amajail/dev-kit/releases/download/money-v0.1.0/amajail-money-0.1.0.tgz"
```

## API

```js
const {
  Money, ValidationError, DomainError,          // value object + its error types
  formatCurrency, formatARS, formatUSD,         // es-AR: $ 1.234.567,89
  formatNumber, formatPercentage, getCurrencySymbol,
  isMonthKey, monthKey, monthRange, addMonths,  // YYYY-MM keys (UTC)
  fetchMepRate, MepRateError,                   // dolarapi bolsa, throws — never 1:1
} = require('@amajail/money');

new Money(1234.56).add(Money.of(1)).format();   // "$ 1.235,56"
Money.of(100, 'USD').convertTo('ARS', 1431.4);  // rate is REQUIRED — no default
monthRange('2026-07');                          // { startDate: '2026-07-01', endDate: '2026-07-31' }
await fetchMepRate();                           // { rate, asOf } or throws MepRateError
```

Two rules the API enforces rather than documents:

- **No silent 1:1.** `convertTo` demands a positive rate; `fetchMepRate` throws
  `MepRateError` on any failure. A missing FX rate is an error state the caller must carry
  (see my-finances' `fxDegraded`), never a default.
- **es-AR digits everywhere.** Formatters produce `$ 1.234.567,89` — the numbers on screen
  must match the statement being reconciled.

## Releasing

Bump `version` in `packages/money/package.json`, then push a matching tag:

```bash
git tag money-v0.1.1 && git push origin money-v0.1.1
```

`.github/workflows/release-money.yml` verifies tag ↔ version, runs the tests, packs, and
attaches the tarball to a GitHub release. Consumers move by editing their pinned URL — a PR,
never an ambient drift.
