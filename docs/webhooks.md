# Webhooks: signing and verification

EarnProof signs every webhook delivery. This document is the integrator's guide
to verifying those signatures correctly, and the specification the
[conformance kit](../test/fixtures/webhooks/signing-vectors.json) checks an
implementation against.

Verification is the only thing standing between your handler and an attacker who
knows your endpoint URL. A webhook endpoint is, by necessity, reachable from the
public internet and accepts unauthenticated POSTs; the signature is what turns
those into authenticated ones. An endpoint that skips verification, or verifies
incorrectly, will act on events that EarnProof never sent.

## The scheme

| Property | Value |
|---|---|
| Algorithm | HMAC-SHA256 |
| Signature encoding | lowercase hex |
| Header format | `v1=<64 hex characters>` |
| Signing base | `<unixTimestampSeconds>.<deliveryId>.<rawRequestBody>` |

Headers on every delivery:

| Header | Meaning |
|---|---|
| `X-EarnProof-Timestamp` | Unix timestamp in **whole seconds** at signing time |
| `X-EarnProof-Delivery` | Delivery identifier — the idempotency key |
| `X-EarnProof-Event` | Event type, e.g. `proof.created` |
| `X-EarnProof-Signature` | `v1=` followed by the hex digest |
| `Content-Type` | `application/json` |

The HMAC key is the **raw text of your signing secret**. The API issues secrets
as 64-character hex strings; the key is those 64 ASCII characters, not the 32
bytes they would decode to. Treating the secret as hex-encoded bytes is the most
common porting mistake and produces a signature that is wrong every time — the
`hex-shaped-secret` vector exists to catch it.

## Verification procedure

1. Read the raw request body as **bytes**, before any JSON parsing.
2. Read `X-EarnProof-Signature`. Reject if absent or if it does not match
   `^v1=[0-9a-f]{64}$` exactly.
3. Read `X-EarnProof-Timestamp`. Reject if absent or not a whole number of
   seconds.
4. Reject if the timestamp differs from your clock by more than your tolerance
   (300 seconds is the recommended default).
5. Read `X-EarnProof-Delivery`. Reject if absent.
6. Compute `HMAC-SHA256(secret, timestamp + "." + deliveryId + "." + rawBody)`
   and hex-encode it.
7. Compare against the header's digest using a **constant-time** comparison.
8. **Only after step 7 succeeds**, check the delivery ID against your
   deduplication store. If it is new, record it and process the event. If it is
   already there, return a 2xx and do nothing else.

The reference implementation of exactly this is
[`scripts/webhook-receiver/verifier.ts`](../scripts/webhook-receiver/verifier.ts).
It is dependency-free and intended to be read and ported.

## Raw-body preservation

**Verify the bytes you received. Never a re-encoding of them.**

The signature covers the exact byte sequence EarnProof sent. Any transformation
between the socket and your verification code — parsing to an object and
re-serialising, trimming whitespace, normalising line endings, re-ordering keys,
transcoding the character set — produces different bytes and a signature that
cannot match. Worse, a receiver that verifies a re-serialised object is checking
a value the sender never signed: two payloads that differ only in key order
produce the same re-serialisation, so a tampered body can verify. The
`tampered-body-reordered-keys` vector fails any implementation that does this.

Most frameworks parse the body for you by default. Turn that off for the webhook
route:

```js
// Express: raw Buffer for this route only, so the rest of the app is unaffected
app.post(
  "/webhooks/earnproof",
  express.raw({ type: "application/json", limit: "1mb" }),
  (req, res) => {
    // req.body is a Buffer here — this is what you verify
  },
);
```

| Framework | What to use |
|---|---|
| Express | `express.raw({ type: "application/json" })` on the route |
| Fastify | `addContentTypeParser("application/json", { parseAs: "buffer" }, …)` |
| Next.js (app router) | `await request.text()` before `request.json()` |
| Django | `request.body` (not `request.POST`, not a parsed form) |
| Rails | `request.raw_post` |
| Go | `io.ReadAll(r.Body)` before any `json.Decode` |
| Flask | `request.get_data()` (not `request.get_json()`) |

Cap the body you buffer. Reading an unbounded request into memory is a
denial-of-service vector regardless of signing; 1 MiB is comfortably above any
legitimate delivery.

## Constant-time signature comparison

**Never compare signatures with `==` or `===`.**

Ordinary string comparison returns as soon as it finds a differing byte, so how
long it takes reveals how many leading bytes were correct. Repeated against an
endpoint, that timing signal lets an attacker recover a valid signature one byte
at a time without ever knowing the secret.

```js
const crypto = require("node:crypto");

const expected = crypto.createHmac("sha256", secret).update(base).digest();
const provided = Buffer.from(hexFromHeader, "hex");

const valid =
  expected.length === provided.length &&
  crypto.timingSafeEqual(expected, provided);
```

| Language | Function |
|---|---|
| Node.js | `crypto.timingSafeEqual` |
| Python | `hmac.compare_digest` |
| Go | `hmac.Equal` |
| Ruby | `Rack::Utils.secure_compare` |
| PHP | `hash_equals` |
| Java | `MessageDigest.isEqual` |

Validate the header's shape *before* comparing, so both operands are known to be
the same length. `timingSafeEqual` throws on a length mismatch, and catching that
to return `false` reintroduces a length oracle.

If you accept more than one secret during a rotation, try **all** of them and
combine the results — returning early on the first match leaks which secret
matched, which tells an observer whether you have cut over yet.

## Timestamp tolerance

A signature never expires on its own. Without a timestamp check, a delivery
captured once is replayable forever.

Reject any delivery whose timestamp differs from your clock by more than your
tolerance. **Check both directions**: a one-sided check that only rejects old
timestamps will accept a signature minted with an arbitrarily distant future
timestamp, which never ages out.

- Recommended tolerance: **300 seconds**.
- Too tight and ordinary clock drift or a slow retry rejects genuine deliveries.
- Too loose and the replay window widens for no benefit.
- Run NTP. A drifting receiver clock rejects everything, and the symptom looks
  like a signing bug on our side.

The timestamp is signed, so it cannot be edited without invalidating the
signature — but it is only *checked* if you check it.

## Delivery-ID deduplication

`X-EarnProof-Delivery` is stable across every attempt of the same event. Use it
as your idempotency key.

It is also reused by an operator-requested **replay** — a replay is deliberately
indistinguishable from a retry, so an integrator that deduplicates cannot be made
to process an event twice by replaying it. The practical consequence is that a
replay is only useful to you once the original ID has aged out of your store,
which is one reason the store needs a TTL rather than infinite retention.

**Record the ID only after the signature verifies.** Recording on arrival lets
anyone who can reach your endpoint send an unsigned request carrying a guessed or
observed delivery ID, and your store will then discard the genuine delivery as a
duplicate. This is a real, silent denial-of-service against your own event
stream, and the `dedup-cache-poisoning` scenario in the vectors exists to catch
it.

```js
// Correct order
const result = verify(...);
if (!result.ok) return reject(result.reason);   // nothing recorded yet
if (!store.register(result.deliveryId)) {
  return respond(200);                          // already handled
}
process(body);
```

Bound the store. An unbounded map keyed by attacker-influenced identifiers is a
memory-exhaustion target. A TTL of 24 hours or more comfortably covers the retry
schedule; keeping IDs forever means a deliberately requested replay can never be
processed.

If your processing is already idempotent by the event's own identifiers, a
dedup store is still worth having — it turns "harmless duplicate work" into "no
work".

## Outbound destination validation (SSRF protection)

Every webhook URL is, by definition, attacker-influenced: an organisation
member configures it, and EarnProof's backend then makes an outbound HTTP
request to it. Without validation, that is a network pivot — a malicious or
compromised configurer could point a webhook at internal infrastructure and
use EarnProof's server as a proxy to reach it. The checks below are enforced
centrally, in [`src/common/http/destination-guard.ts`](../src/common/http/destination-guard.ts),
and every outbound client that dispatches to a caller-influenced destination
(webhooks today) runs its target through this module before connecting. The
webhook-facing entry point is
[`src/webhooks/webhook-ssrf-guard.ts`](../src/webhooks/webhook-ssrf-guard.ts), a
thin wrapper that delegates to it.

### Allowed schemes and ports

- **Scheme:** `https:` only. `http:`, `ftp:`, `file:`, `data:`, `ws:`, and
  everything else are rejected.
- **Port:** the default HTTPS port (443) only. Any explicit port —
  including `:443` written out, and especially an unusual port like `:8080`
  or `:6379` — is rejected. A caller-controlled port is itself a common way
  to reach an internal service that happens to sit behind a public hostname.
- **Credentials:** `https://user:pass@host/...` is rejected outright. URL
  credentials can be used to smuggle secrets to a third party and have no
  legitimate use in a webhook URL.

### Blocked address ranges

Both IPv4 and IPv6 literals are checked, and a hostname is checked again
after DNS resolution (see below). Blocked ranges:

- Loopback (`127.0.0.0/8`, `::1`)
- Unspecified (`0.0.0.0/8`, `::`)
- RFC 1918 private space (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
- Link-local (`169.254.0.0/16`, `fe80::/10`)
- Cloud metadata endpoints (`169.254.169.254` — AWS/GCP/Azure;
  `100.100.100.200` — Alibaba Cloud)
- Carrier-grade NAT / shared address space (`100.64.0.0/10`)
- Benchmark and documentation ranges (`198.18.0.0/15`, `198.51.100.0/24`
  TEST-NET-2, `203.0.113.0/24` TEST-NET-3)
- Reserved and broadcast (`240.0.0.0/4`, `255.255.255.255`)
- Unique-local IPv6 (`fc00::/7`)
- `localhost`, and any hostname ending in `.localhost`, `.local`, or
  `.internal`, regardless of what it would resolve to.

### Ambiguous IP representations

An address can be spelled in more than one way, and a naive check that only
recognises the canonical dotted-decimal or colon-hex form can be bypassed by
an equivalent-but-different-looking one. This module rejects the ambiguous
forms rather than trusting the platform to have normalised them first:

- **Octal-looking octets** (`017.0.0.1`) and **hex octets** (`0x7f.0.0.1`)
  are refused by the IPv4 parser — it accepts only one-to-three-digit
  strict decimal, with no leading zero.
- **Single-integer or short forms** (`2130706433`, `127.1`) are not treated
  as four-octet IPv4 and so never bypass the range checks by looking like a
  hostname instead of the loopback address they represent.
- **IPv4-mapped IPv6** (`::ffff:127.0.0.1` and its compressed hex form
  `::ffff:a9fe:a9fe`) is decoded back to its IPv4 payload and re-checked
  under the same IPv4 rules — the IPv6 wrapper is not itself a bypass.
- **NAT64-embedded IPv4** (`64:ff9b::/96`) is decoded the same way.

### DNS revalidation at connection time

A hostname's resolved address is only trusted for the instant it was
checked. `assertSafeWebhookDestination` re-resolves DNS and re-validates
every returned address **immediately before every delivery attempt and
retry** — not once at the time the webhook was configured, and not once at
enqueue time. This is what defeats DNS rebinding: an attacker who gets a
hostname approved while it resolves to a public address, then repoints DNS
at an internal address before (or between) delivery attempts, is still
caught, because each attempt re-resolves and re-checks independently.

### Redirects and credential forwarding

Deliveries are made with `redirect: "error"` — a 3xx response is treated as
a delivery failure, never followed. This is deliberate: a redirect is a
fresh, unvalidated destination, and following it would mean re-sending the
signed payload (and, if the receiving code ever added redirect-following, any
`Authorization` header) to whatever URL an attacker's endpoint chooses to
respond with — including an internal address the outbound destination
guard would otherwise have blocked. If redirect-following is ever
introduced for a legitimate reason, the redirect target must be re-run
through `assertSafeDestination` exactly like any first-hop destination
before it is followed, and no credential or signature computed for the
original request may be attached to the redirected one.

### Stellar Horizon is out of scope for this guard

`src/stellar/horizon-transport.ts` also makes outbound HTTP requests, but its
target is `STELLAR_HORIZON_URL`, an operator-configured environment variable
— not a value any webhook customer, API caller, or other end user can
influence. It is deliberately not routed through the destination guard: doing
so would add DNS-resolution and range-checking overhead to every Horizon call
for a URL that is not attacker-controlled, and an operator who points it at
an internal address is doing so intentionally (e.g. a self-hosted Horizon
instance).

## Retries

A delivery that does not receive a 2xx is retried up to **5 times total**, with
exponential backoff of roughly 1s, 2s, 4s, then 8s.

- Every attempt carries the **same** `X-EarnProof-Delivery`, so dedup works
  across retries.
- Each attempt is **re-signed** with the timestamp of that attempt. Do not cache
  a signature and compare it across attempts.
- Return 2xx as soon as you have durably accepted the event — write it to a queue
  or table and return. Doing the work inline risks a timeout, which we record as
  a failure and retry, giving you the work twice.
- Deliveries time out after 10 seconds.
- Return 2xx for duplicates. A 4xx on a duplicate makes us retry an event you
  have already processed, for the full schedule, for nothing.
- Redirects are not followed. Point the endpoint at its final URL.

Suggested response codes:

| Situation | Status |
|---|---|
| Accepted | `204` |
| Already processed | `200` |
| Missing or malformed headers, stale timestamp | `400` |
| Signature did not verify | `401` |
| Body too large | `413` |
| You are up but cannot accept right now | `503` — we retry |

## Secret rotation

Rotating via `POST /api/v1/webhooks/:id/rotate-secret` returns the new secret
**once**; it is not retrievable afterwards. Store it before you close the
response.

Rotation cuts over immediately on our side. There is no dual-signing period: the
next delivery is signed with the new secret, and a delivery already in flight
when you rotate was signed with the old one and will fail its current attempt.
It is retried, and the retry is signed with the new secret.

So the overlap has to live in **your** receiver:

1. Rotate, and store the new secret alongside the one you already have.
2. Configure the receiver to accept **either** — try both on every request.
3. Wait out the retry schedule with margin. An hour is generous; the schedule
   itself completes in well under a minute.
4. Remove the old secret. Deployment order matters: step 2 must be live
   everywhere *before* step 1, or deliveries signed with the new secret arrive at
   a receiver that has never heard of it.

```js
// During the overlap window
const secrets = [process.env.WEBHOOK_SECRET_NEW, process.env.WEBHOOK_SECRET_OLD]
  .filter(Boolean);
```

Rotate on a schedule, and immediately if a secret may have been exposed — in a
log, a bug report, a screenshot, or a compromised host. Rotation is cheap;
treating a possible exposure as acceptable is not.

Secrets are stored encrypted at rest and are never returned by any read
endpoint, so the copy you hold at creation or rotation time is the only copy. If
you lose it, rotate again.

## What never to log

Your receiver's log is a copy of everything you put in it, usually with wider
access than the endpoint itself. Treat it as a publication.

**Never log:**

- The signing secret, in any form — not truncated, not hashed, not "just in dev".
- The `X-EarnProof-Signature` header, or any computed digest. A signature plus
  its body is a persistent forgery oracle if the secret is ever exposed.
- `Authorization` headers, or any credential on the request.
- The full webhook payload. Envelopes carry proof identifiers, credential
  hashes, and wallet-derived hashes; a log that retains them turns log access
  into data access.
- Whole request-header dumps. `console.log(req.headers)` prints the signature
  and any credential in one line, which is why it is called out separately.

**Safe to log:** the delivery ID, the event type, the outcome, the status code
you returned, and a duration. That is enough to answer every support question
about a delivery without retaining anything sensitive.

```js
// Enough to debug, safe to keep
log.info({ deliveryId, event, outcome: "accepted", status: 204, durationMs });
```

The reference receiver's `safeLogLine` is exactly this, and deliberately has no
option to widen it.

## Conformance kit

Two pieces, both runnable:

**Golden vectors** —
[`test/fixtures/webhooks/signing-vectors.json`](../test/fixtures/webhooks/signing-vectors.json).
Language-neutral, with no dependency on this repository. Each positive vector
carries the secret, timestamp, delivery ID, raw body (as UTF-8 **and** base64,
so byte sequences are unambiguous), the assembled signing base, and the expected
signature. Negative vectors carry the headers to send and the failure each must
produce.

The vectors are **frozen**. They are the wire contract; a mismatch means the
protocol changed, which breaks every integrator at once. Do not regenerate them
to make a test pass.

Coverage worth knowing about, because each one has failed a real implementation
somewhere: multi-byte UTF-8 bodies, bodies full of literal `.` characters, empty
bodies, trailing newlines, whitespace-significant JSON, hex-shaped secrets,
post-2038 timestamps, uppercase digests, truncated digests, header/signature
mismatches, millisecond timestamps, and replay and rotation scenarios.

**Reference receiver** —
[`scripts/webhook-receiver/`](../scripts/webhook-receiver/). Run the whole kit:

```bash
npm run webhook:conformance
```

That runs every vector through the verifier in-process, then again through a real
HTTP server on `127.0.0.1`, which is the only way to prove the raw body survived
the framework. It exits non-zero on any failure and runs in CI.

Point it at your own handler by running the receiver standalone and comparing
behaviour:

```bash
EARNPROOF_WEBHOOK_SECRET=<your-endpoint-secret> npm run webhook:receiver
```

It binds to `127.0.0.1` on an ephemeral port unless `PORT` is set. Prefer the
environment variable over a `--secret` flag: command-line arguments are visible
to every local user in the process list.

## Related

- [Webhook delivery runbook](runbooks/webhook-delivery.md) — operating the
  sending side.
- [Versioning](versioning.md) — how `specVersion` and event types evolve.
- [Architecture](architecture.md) — where webhooks sit in the system.
- [Webhook TLS posture](webhook-tls-posture.md) — scheduled certificate and
  protocol probes of webhook endpoints.
