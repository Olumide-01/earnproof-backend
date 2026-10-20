# Organization operational quotas

Every organization is held to the same configurable limits, counted per
organization. Enforcement lives in
[`organization-quota.service.ts`](../src/quotas/organization-quota.service.ts).

## Quotas and defaults

| Quota | Kind | Default | Environment variable | Counted |
|---|---|---|---|---|
| `api_keys` | concurrent | 25 | `QUOTA_MAX_ACTIVE_API_KEYS` | API keys that are `ACTIVE` and not expired |
| `webhooks` | concurrent | 10 | `QUOTA_MAX_WEBHOOKS` | Webhooks not `DELETED` (disabled ones count, so re-enabling can never exceed the cap) |
| `proof_requests` | windowed, `P1D` | 1000 | `QUOTA_PROOF_REQUESTS_PER_DAY` | Proof issuance requests (minimum-income, recurring-income, payment-receipt) |
| `sync_frequency` | windowed, `PT1H` | 12 | `QUOTA_SYNCS_PER_HOUR` | Payment sync requests (`POST /payments/sync`) |

Windows are fixed UTC windows (the day starting 00:00Z, the hour starting
:00). Values are validated at boot: a non-integer or out-of-range value fails
startup rather than silently disabling a quota.

`proof_requests` and `sync_frequency` are charged to the organization the user
acts for: the oldest `ACTIVE` organization they created. Users outside any
active organization are not subject to organization quotas; their requests are
still covered by the ordinary per-route rate limiting.

## Enforcement guarantees

- **Atomic.** Concurrent quotas lock the organization row
  (`SELECT … FOR UPDATE`) inside the creating transaction, then count and
  insert under the lock. Windowed quotas use a single
  `INSERT … ON CONFLICT DO UPDATE … WHERE count < limit` statement. A burst of
  concurrent requests cannot overshoot either kind.
- **No partial changes.** The check runs in the same transaction as the
  mutation. A rejection writes nothing — no key, scope assignment, webhook,
  proof, or audit entry — and a mutation that fails after the check rolls its
  quota consumption back.
- A payment sync is charged before Horizon is contacted; a sync that later
  fails still counts, because it still cost a Horizon call.

## Rejection vs rate limiting

| | Quota rejection | Rate limiting (throttler) |
|---|---|---|
| Status | 429 | 429 |
| `code` | `QUOTA_EXCEEDED` | `TOO_MANY_REQUESTS` |
| Retry | Not until the window resets (message gives the time) or usage drops | After a short back-off |
| Metric | `quota_rejections_total{quota}` | `http_requests_total{status_class="4xx"}` only |

Clients must branch on `code`, not status. The metric is labelled by quota
only, never by organization.

## Usage reporting

`GET /api/v1/organizations/:id/usage` — organization creator or `ADMIN` only.
Returns counts, limits, remaining capacity, and for windowed quotas the window,
its start, and `resetsAt`. It contains no resource identifiers.

```json
{
  "organizationId": "org_…",
  "generatedAt": "2026-09-10T14:25:00.000Z",
  "quotas": [
    { "quota": "api_keys", "type": "concurrent", "limit": 25, "used": 3, "remaining": 22, "window": null, "windowStart": null, "resetsAt": null },
    { "quota": "sync_frequency", "type": "windowed", "limit": 12, "used": 2, "remaining": 10, "window": "PT1H", "windowStart": "2026-09-10T14:00:00.000Z", "resetsAt": "2026-09-10T15:00:00.000Z" }
  ]
}
```

## Operational notes

- Counters live in `OrganizationQuotaUsage`, one row per organization, quota,
  and window. Old windows are inert; they are not read after their window ends.
- Raising a limit takes effect at the next request. Lowering a concurrent limit
  below current usage blocks new creations but never removes existing
  resources.
