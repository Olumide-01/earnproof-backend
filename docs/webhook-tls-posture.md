# Webhook endpoint TLS posture

EarnProof probes each active webhook endpoint's TLS configuration so expiring
certificates, hostname mismatches, untrusted chains and weak protocols are seen
before deliveries start failing (issue #315).

Implementation: `src/webhooks/tls-posture/` and `src/jobs/webhook-tls-probe.job.ts`.

## What a probe does

A probe is one TLS handshake and nothing else:

1. The URL goes through the outbound destination guard
   ([webhooks.md](webhooks.md#outbound-destination-validation-ssrf-protection)):
   https only, default port, no credentials, no internal hostnames or literals.
2. The hostname is resolved once. If **any** address is non-public, the probe
   stops with `DESTINATION_BLOCKED`.
3. The socket connects to the address that was checked, sending the hostname
   as SNI. Connecting by address closes the DNS-rebinding window.
4. The handshake result is read and the socket is closed. **No HTTP request is
   sent**, so there is no response and no redirect to follow.

The probe offers TLS 1.0 and above, so it can observe an endpoint that only
negotiates a weak protocol. It never accepts the connection for delivery.

## Outcomes

The first matching rule wins, so a certificate with several problems always
reports the same outcome:

| Outcome | Meaning |
| --- | --- |
| `DESTINATION_BLOCKED` | URL or resolved address rejected by the guard |
| `UNREACHABLE` | DNS failure or connection refused/reset/unreachable |
| `TIMEOUT` | No handshake within 5 seconds |
| `WEAK_PROTOCOL` | Negotiated below TLS 1.2, or the server only offers older protocols |
| `HANDSHAKE_FAILED` | Any other TLS failure, or no usable certificate |
| `EXPIRED` | Strictly after the certificate's `notAfter` (X.509 validity is inclusive) |
| `NOT_YET_VALID` | Before `notBefore` |
| `HOSTNAME_MISMATCH` | Certificate does not cover the hostname |
| `UNTRUSTED` | Chain does not verify against the trust store |
| `EXPIRING_SOON` | `notAfter` within 14 days, inclusive |
| `HEALTHY` | None of the above |

For a completed handshake the precedence is: no certificate, expired, not yet
valid, hostname mismatch, untrusted, weak protocol, expiring soon, healthy.

A stored probe holds only the outcome, negotiated protocol, certificate
validity dates, the leaf certificate's SHA-256 fingerprint, duration and time.
The resolved address, resolver errors and TLS library messages are never
stored, logged or returned.

## Scheduling and bounds

- `WebhookTlsProbeJob` runs hourly (`WEBHOOK_TLS_PROBE_CRON` overrides it).
- Each run probes at most 25 `ACTIVE` webhooks, 5 at a time. A webhook is due
  once its latest probe is at least 24 hours old (boundary inclusive).
- An overlapping run in the same process is skipped. Across instances a
  webhook may occasionally be probed twice; that is harmless and bounded.
- One endpoint failing does not stop the batch.
- The latest 20 probes per webhook are kept; older rows are pruned after each
  probe.

## Alerts

A probe raises an alert (`alerted: true`, plus a warning log with the webhook
id and outcome only) when its outcome is not `HEALTHY` **and** differs from the
previous probe's outcome. A persistently broken endpoint alerts once, not every
day. A change from one problem to another (for example `EXPIRING_SOON` to
`EXPIRED`) alerts again.

"Previous" means the latest probe that started earlier. A slow probe that
finishes after a newer one neither becomes the latest result nor alerts against
it.

## Endpoints

Under `/api/v1/organizations/:organizationId/webhooks`, bearer session.

| Route | Who | Result |
| --- | --- | --- |
| `GET /tls-posture` | Any ACTIVE member, or platform `ADMIN` | Latest posture per webhook (max 100, `truncated` flag) |
| `GET /:webhookId/tls-posture` | Any ACTIVE member, or platform `ADMIN` | Posture plus the last 20 probes |
| `POST /:webhookId/tls-posture/probe` | Organization `ADMIN`/`OWNER`, or platform `ADMIN` | Runs one probe now |

Posture fields: `status` (an outcome, or `UNKNOWN` before the first probe),
`healthy`, `lastProbedAt`, and `stale`. `stale` is true when there is no probe or
the latest is more than 48 hours old (strictly).

Failure behaviour: **401** no session. **403** not a member or role too low.
**404** webhook missing or belonging to another organization (indistinguishable).
**409** on-demand probe of a non-`ACTIVE` webhook. **429** on-demand probe less
than 60 seconds after the previous probe of that webhook. At exactly 60 seconds
the probe is allowed.

## Limitations

- Weak-protocol detection reports what the endpoint negotiates. An endpoint
  that supports TLS 1.2+ **and** older versions is reported healthy.
- Probes use the default trust store. An endpoint that relies on mTLS client
  certificates is still probed; the handshake reports the server certificate.
