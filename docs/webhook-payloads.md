# Webhook payload schemas

Every webhook body is produced by a versioned serializer in
[`webhook-payload.serializers.ts`](../src/webhooks/webhook-payload.serializers.ts).
This page is the integrator-facing contract and the policy for changing it.
The general deprecation rules are in [versioning.md](versioning.md); this page
covers what is specific to webhooks.

## Envelope

```json
{
  "specVersion": "1",
  "id": "0b5c7d6e-3f2a-4c1b-9e8d-7a6b5c4d3e2f",
  "event": "proof.revoked",
  "schemaVersion": "1",
  "createdAt": "2026-09-01T12:00:00.000Z",
  "data": { "proofId": "…", "status": "REVOKED", "revokedAt": "…" }
}
```

| Field | Meaning |
|---|---|
| `specVersion` | Version of the envelope itself. |
| `id` | **Stable event identifier.** One value per domain event, identical across every subscribed endpoint, retry, replay, and redrive. Deduplicate on it. Also sent as `X-EarnProof-Delivery`. |
| `event` | Event type. |
| `schemaVersion` | Version of `data` for this event. The pair (`event`, `schemaVersion`) identifies the payload contract. Also sent as `X-EarnProof-Schema-Version`. |
| `createdAt` | When the domain event occurred — not when this attempt was sent. |
| `data` | Event payload. Flat: every value is a string or `null`. |

Byte-exact version-1 examples for every event type live in
[`src/webhooks/fixtures/v1/`](../src/webhooks/fixtures/v1/).

## Guarantees

- **Only declared fields.** Serializers copy named fields from a plain domain
  snapshot. They never spread a database row, so internal columns (user ids,
  wallet hashes, encrypted thresholds, commitments, secrets) cannot appear. A
  serializer whose output differs from its declared field list — or that emits a
  forbidden field name or a nested object — throws, and the event is **not
  delivered** rather than delivered with an undeclared field.
- **Identical bytes on every attempt.** The body is serialized once when the
  event occurs and stored in `WebhookDelivery.payloadBody`. Retries, manual
  replays, and dead-letter redrives sign and send those exact bytes with the
  original `schemaVersion`. The body is never re-serialized, so a signature
  check against a previously received copy of the same event always matches.
- **Pinned versions.** Each endpoint stores the `payloadVersion` it was created
  with (default: current). Introducing a new version does not change what
  existing endpoints receive.

## Changing a payload

| Change | How it ships |
|---|---|
| Add a new event type | Additive. New serializer under the current version plus a fixture. |
| Add, remove, rename, retype, or reorder a field of an existing event | New `schemaVersion` with its own serializer and fixtures. The existing version is untouched. |
| Change date or number formatting | New `schemaVersion`. |

The contract test
[`webhook-payload.contract.spec.ts`](../src/webhooks/webhook-payload.contract.spec.ts)
fails when a v1 serializer's bytes or field list drift from the frozen fixtures.
**Never edit a fixture to make it pass** — that is exactly the break the test
exists to catch.

## Deprecation and removal

1. Mark the old version deprecated by setting `deprecation.sunsetAt` on its
   schemas in the registry. The date must be at least **180 days** after the
   announcement (the webhook window in [versioning.md](versioning.md)).
2. Deliveries of a deprecated version carry `Deprecation: true` and
   `Sunset: <date>` headers. The body is never modified to announce its own
   deprecation.
3. After the sunset date, the version is removed from
   `WEBHOOK_PAYLOAD_VERSIONS`. Endpoints still pinned to it **stop receiving
   events** (fail closed) instead of silently receiving a shape they did not
   agree to; the skipped serialization is logged per endpoint.
4. Rows already queued keep their stored bytes and version; a removed version
   only stops new events from being produced for pinned endpoints.
