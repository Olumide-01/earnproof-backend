# Compatibility notes

Per [`docs/versioning.md`](versioning.md), every breaking change to a public
contract carries a note here: what changed, why, how a consumer migrates, and
who approved shipping it without the full staged deprecation process (minimum
support window, `Deprecation`/`Sunset` headers, usage measurement).

These entries document breaks shipped as a deliberate, one-shot exception to
the staged process, on the basis that this service has no external API
consumers outside this repository's own test suite and fixtures yet — the
work is pre-GA production-readiness hardening (see the originating issues),
not a change to a contract depended on in the wild. Approval for each entry is
requested through the normal PR review process on the PR that introduces it,
by a maintainer listed in `MAINTAINERS.md`.

## Issue #188 — deterministic cursor ordering for mutable list endpoints

```ts
{
  contractId: "GET /api/v1/issuers",
  migration:
    "The `page` query parameter has been removed. Use `cursor` " +
    "(opaque, from a previous response's `pageInfo.nextCursor`) and `limit` " +
    "instead. The response gains a `pageInfo` field; `items`/`total`/`limit` " +
    "are unchanged.",
  supportWindowEndsAt: "shipped directly — no external consumers yet",
  approvedBy: "requested via PR review, see PR introducing this note",
}
```

```ts
{
  contractId: "GET /api/v1/issuers/admin",
  migration: "Same as GET /api/v1/issuers above.",
  supportWindowEndsAt: "shipped directly — no external consumers yet",
  approvedBy: "requested via PR review, see PR introducing this note",
}
```

```ts
{
  contractId: "GET /api/v1/payments",
  migration:
    "The response body changed from a bare array of payments to " +
    "`{ data: Payment[], pageInfo: { hasMore, nextCursor } }`. Read the " +
    "payment list from `data` instead of the response root. `cursor` and " +
    "`limit` query parameters were added for pagination.",
  supportWindowEndsAt: "shipped directly — no external consumers yet",
  approvedBy: "requested via PR review, see PR introducing this note",
}
```

```ts
{
  contractId: "GET /api/v1/webhooks",
  migration:
    "The response body changed from a bare array of webhook endpoints to " +
    "`{ data: Webhook[], pageInfo: { hasMore, nextCursor } }`. Read the " +
    "endpoint list from `data` instead of the response root.",
  supportWindowEndsAt: "shipped directly — no external consumers yet",
  approvedBy: "requested via PR review, see PR introducing this note",
}
```

```ts
{
  contractId: "GET /api/v1/webhooks/:id/deliveries",
  migration:
    "The response body changed from a bare array of delivery records to " +
    "`{ data: WebhookDelivery[], pageInfo: { hasMore, nextCursor } }`. Read " +
    "delivery records from `data` instead of the response root.",
  supportWindowEndsAt: "shipped directly — no external consumers yet",
  approvedBy: "requested via PR review, see PR introducing this note",
}
```

```ts
{
  contractId: "GET /api/v1/api-keys",
  migration:
    "The response body changed from a bare array of API keys to " +
    "`{ data: ApiKey[], pageInfo: { hasMore, nextCursor } }`. Read the key " +
    "list from `data` instead of the response root.",
  supportWindowEndsAt: "shipped directly — no external consumers yet",
  approvedBy: "requested via PR review, see PR introducing this note",
}
```

```ts
{
  contractId: "GET /api/v1/trusted-sources",
  migration:
    "The response body changed from a bare array of trusted sources to " +
    "`{ data: TrustedSource[], pageInfo: { hasMore, nextCursor } }`. Read " +
    "the list from `data` instead of the response root.",
  supportWindowEndsAt: "shipped directly — no external consumers yet",
  approvedBy: "requested via PR review, see PR introducing this note",
}
```

