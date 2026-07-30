# MCP contracts — family integration (Slice 0, frozen 2026-07-30)

The integration analogue of my-expenses' Pydantic ↔ `api.ts` freeze: Slices B (my-afip MCP),
C (my-expenses MCP), M1 (monthly close) and M2 (surplus → weekly analysis) build against THIS
file, not against each other. Changing a name or field here after B/C start is the
contract-change protocol in `claude/skills/implement-roadmap` — one commit on the default
branch, all lanes rebase. Nothing else may redefine these shapes.

## Conventions (apply to every tool below)

- **Month key** is always the string `YYYY-MM` (es-AR data, ISO month key — matches
  my-expenses `Txn.month` and my-afip's report `year`/`month` pair collapsed to one arg).
- **Error shape** (copied from my-finances `src/functions/mcp.js`): a failed tool call
  returns `{"error": string, "code"?: string, "details"?: object}` instead of throwing.
  `code` is the error class name (`ValidationError`, …); `details` carries field-level
  validation errors when they exist.
- **Amounts** are numbers in ARS unless the field name says otherwise (`…Usd`). Two-decimal
  rounding at the edge; no formatted strings on the wire (formatting is the client's job).
- **Read-only.** Neither new MCP gets a write tool (roadmap "Deliberately not building").
  my-finances' audited writes remain the only MCP write surface in the family.
- MCP tool results are JSON **strings** (stringified objects), per the MCP tool protocol —
  same as my-finances' implementation.

## my-afip MCP (Slice B)

Hosting: lift my-finances' in-process Azure Functions MCP extension pattern —
`src/functions/mcp.js`, Streamable HTTP on `/runtime/webhooks/mcp`, behind the platform
system key, handlers delegating to the existing DI-container use-cases. No new auth story.

Freshness: the Binance fetch only runs on the owner's machine (repo rule 2), so the orders
table can silently go stale. Every response below carries:

```jsonc
"tableFreshness": {
  "newestOrderDate": "YYYY-MM-DD",  // date of the newest order in the WHOLE table (any month)
  "ageDays": 3                       // whole days between that and today
}
```

M1's rule: `ageDays > 10` ⇒ caveat the income figure as possibly under-reported (don't skip).

### `list_orders`

| arg | type | req | meaning |
|---|---|---|---|
| `month` | string `YYYY-MM` | yes | calendar month, order dates |

Returns:

```jsonc
{
  "month": "2026-06",
  "count": 12,
  "tableFreshness": { … },
  "orders": [{
    "orderNumber": "string",
    "orderDate": "YYYY-MM-DD",
    "tradeType": "SELL" | "BUY",
    "asset": "USDT",
    "fiat": "ARS",
    "totalPrice": 123456.78,
    "processingStatus": "success" | "failed" | "pending",
    "cae": "string|null",
    "voucherNumber": "number|null",
    "errorMessage": "string|null"
  }]
}
```

### `list_invoices`

Same `month` arg. Returns:

```jsonc
{
  "month": "2026-06",
  "count": 10,
  "tableFreshness": { … },
  "invoices": [{
    "voucherNumber": 123,
    "cae": "string",
    "invoiceDate": "YYYY-MM-DD",
    "orderNumber": "string",   // the order it invoices
    "totalAmount": 123456.78,
    "currency": "ARS"
  }]
}
```

### `monthly_income`

Same `month` arg. The tool M1 actually calls; the other two are drill-down.

```jsonc
{
  "month": "2026-06",
  "invoicedArs": 1234567.89,     // sum of successful invoices dated in the month
  "invoiceCount": 10,
  "sellOrdersArs": 1300000.00,   // sum of SELL orders in the month (invoiced or not)
  "sellOrderCount": 12,
  "uninvoicedCount": 2,          // SELL orders with no successful invoice
  "tableFreshness": { … }
}
```

`invoicedArs` is the income figure of record; `sellOrdersArs − invoicedArs` with
`uninvoicedCount > 0` tells M1 income is understated *by the app's own books*, before any
freshness caveat.

## my-expenses MCP (Slice C)

Hosting: MCP endpoint mounted on the existing FastAPI app (`/mcp`, Streamable HTTP via the
official `mcp` Python SDK). Auth: the same `x-api-key` middleware story as the REST API —
key set ⇒ required, unset (local dev/tests) ⇒ open. Read-only; tools call the same
`services/analytics.py` functions as the REST endpoints, so **the `Card payment` exclusion
holds by construction** (analytics `visible()` — CLAUDE.md rule 2) and `kind` partitions
exactly (rule 5).

`kind` arg everywhere below: `"card" | "bank"`, optional — omit for both.

### `spending_summary`

| arg | type | req |
|---|---|---|
| `month` | string `YYYY-MM` | yes |
| `kind` | `"card"`\|`"bank"` | no |

```jsonc
{
  "month": "2026-06",
  "kind": "card",            // echoed; null when omitted
  "expenses": 456789.12,     // POSITIVE magnitude (sign convention lives on Txn.amount)
  "income": 1000000.00,      // positive magnitude
  "net": 543210.88,          // income − expenses
  "count": 87
}
```

### `by_category`

Same args as `spending_summary`. Expense totals, positive, descending (ties by name):

```jsonc
{
  "month": "2026-06",
  "kind": null,
  "categories": [{ "category": "Supermarket", "total": 123456.78 }]
}
```

### `search_transactions`

| arg | type | req | meaning |
|---|---|---|---|
| `query` | string | yes | case-insensitive substring of the description, matched verbatim (merchant text stays as the bank printed it) |
| `month` | string `YYYY-MM` | no | restrict to one month |
| `limit` | integer | no | max rows, default 50, cap 200 |

```jsonc
{
  "query": "coto",
  "count": 3,                // rows returned (post-limit)
  "transactions": [{        // TxnOut fields, verbatim from the REST contract
    "id": "…", "date": "YYYY-MM-DD", "description": "…", "amount": -12345.67,
    "currency": "ARS", "category": "…", "account": "…", "kind": "card",
    "source_file": "…"
  }]
}
```

`amount` keeps the app-wide sign rule: `< 0` expense, `> 0` income. Card payments are NOT
excluded here — search shows what the statement shows; only aggregates exclude them.

## Monthly-close report shape (M1 fills, M2 may consume)

The routine's deliverable. No new storage — this is the report body; the ONLY write is the
`monthlyCashflow` key below.

```jsonc
{
  "month": "2026-06",
  "incomeArs": 1234567.89,          // afip monthly_income.invoicedArs
  "spendArs": 456789.12,            // expenses spending_summary.expenses (both kinds)
  "spendByCategory": [{ "category": "…", "totalArs": 0 }],
  "surplusArs": 777778.77,          // incomeArs − spendArs
  "savingsRate": 0.63,              // surplusArs / incomeArs, null when incomeArs = 0
  "portfolioDeltaArs": 0,           // finances portfolio_summary month-over-month, null if unavailable
  "reachedPortfolioArs": 0,         // what actually landed in the portfolio (see reconciliation)
  "unreconciled": {
    "sellsWithoutBankCredit": [{ "orderNumber": "…", "orderDate": "…", "totalPrice": 0 }],
    "bankCreditsWithoutInvoice": [{ "id": "…", "date": "…", "description": "…", "amount": 0 }]
  },
  "caveats": ["afip orders table 14 days stale", "fx degraded: MEP provider down"],
  "sources": { "afip": "mcp", "expenses": "mcp", "finances": "mcp" }
}
```

Reconciliation is fuzzy date+amount, both directions (roadmap M1). Degraded inputs
(`tableFreshness.ageDays > 10`, finances `fxDegraded: true`) go to `caveats` — the report
still ships; only a missing MCP skips a section, and that too is a caveat.

## `portfolioSettings` key: `monthlyCashflow` (M1 writes, M2 reads)

Stored via my-finances' audited settings path, one row, overwritten monthly:

```jsonc
{
  "month": "2026-06",
  "incomeArs": 1234567.89,
  "spendArs": 456789.12,
  "surplusArs": 777778.77,
  "computedAt": "2026-07-03T12:00:00Z"   // ISO 8601 UTC
}
```

M2's staleness rule: if `computedAt` is older than **45 days**, the weekly analysis omits
the cashflow section entirely — it never reuses a stale surplus in sizing advice.
