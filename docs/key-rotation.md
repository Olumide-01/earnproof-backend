# Cryptographic key rotation: identifiers, lifecycle, and operator runbook

This document defines the key identifier and lifecycle policy for every
cryptographic purpose in the backend, and gives operators a rehearsed
procedure for rotating each one. It is the reference for the "Create a
cryptographic key-rotation rehearsal and runbook" production-readiness
work.

Scope: this document defines policy for all five cryptographic purposes in
the system. Payment-encryption keys and credential-signing keys both have
staged, dual-read (verify-only) rotation support. Session signing does not
(see "Deferred: session signing" below for why that is a safe, explicitly
scoped trade-off). Verification-event hash salts and webhook HMAC secrets
already have adequate rotation mechanisms and are documented for
completeness and consistency, not changed.

## 1. Cryptographic purposes and key identifiers

Every distinct cryptographic purpose has its own key material and its own
identifier namespace. Keys are never shared across purposes.

| Purpose | Env var(s) | Key identifier | Rotation support |
|---|---|---|---|
| Payment amount / webhook secret encryption (AES-256-GCM) | `PAYMENT_ENCRYPTION_KEY`, `PAYMENT_ENCRYPTION_KEY_V0`, `_V1`, ... + `PAYMENT_ENCRYPTION_KEY_VERSION` | Numeric version embedded in ciphertext (`enc:v<N>:...`) | Yes — staged, dual-read |
| Payment amount / webhook secret encryption (AES-256-GCM) | `PAYMENT_ENCRYPTION_KEY`, `PAYMENT_ENCRYPTION_KEY_V0`, `_V1`, ... + `PAYMENT_ENCRYPTION_KEY_VERSION` | Numeric version embedded in ciphertext (`enc:v<N>:...`) | Yes — staged, dual-read (this pass) |
| Payment address encryption and lookup tokens (AES-256-GCM, HMAC-SHA256; keys derived with HKDF) | Derived from `PAYMENT_ENCRYPTION_KEY_V<N>`; no separate variable | `aenc:v<N>:...` ciphertext, `hmac:v<N>:...` token | Yes — staged, dual-read, backfill re-protects |
| Verification-event metadata hashing (HMAC-SHA256) | `VERIFICATION_HASH_SALT_V0`, `_V1`, ... + `VERIFICATION_HASH_SALT_VERSION` | Numeric version stored per-row (`saltVersion` column) | Yes — pre-existing pattern, mirrored by payment encryption |
| Session token hashing | `SESSION_SECRET` | None (single key) | Documented policy only, no code change |
| Credential signing (HMAC-SHA256 over canonicalized payload) | `CREDENTIAL_SIGNING_SECRET`, `CREDENTIAL_SIGNING_SECRET_V0`, `_V1`, ... + `CREDENTIAL_SIGNING_KEY_VERSION`, optional `_V<N>_VERIFY_UNTIL` | Non-secret `keyId` (`earnproof-v<N>`) carried in the credential's own `proof` block | Yes — staged, verify-only, with an optional time-bounded overlap window |
| Webhook delivery signing (HMAC-SHA256) | Per-webhook `signingSecret`, stored encrypted per row via the payment-encryption key | Webhook row ID (implicit) | Yes — per-entity, not globally rotated (already fine) |

Each purpose's key is decodable/derivable independently: compromising the
payment-encryption key does not expose the session secret, the credential
signing secret, or any individual webhook's signing secret, and vice
versa.

## 2. Key lifecycle states

Every versioned key identifier moves through the following states. States
apply per-version, not per-purpose — a purpose can have several versions
alive in different states simultaneously during a rotation window.

| State | Meaning | Configuration |
|---|---|---|
| **active** | The version new writes/signatures use. | `..._VERSION` env var points to this version's number. |
| **retiring** | Still configured and loaded for reads (decrypt/verify), but no longer used for new writes. | Version's `..._V<N>` env var still set; `..._VERSION` points elsewhere. |
| **retired** | No longer configured anywhere. Any data still encrypted/signed under this version cannot be processed. | Version's `..._V<N>` env var removed entirely. |
| **compromised** | An active or retiring version whose key material may have leaked. Handled via the emergency path (§5), not the staged path. | See §5. |

For payment encryption specifically: versions are loaded from
`PAYMENT_ENCRYPTION_KEY_V0`, `_V1`, ... sequentially, stopping at the first
gap (same convention `VerificationEventService` already uses for
`VERIFICATION_HASH_SALT_V*`). The unversioned `PAYMENT_ENCRYPTION_KEY` is
treated as an implicit version 0 when `PAYMENT_ENCRYPTION_KEY_V0` is not
set, so existing deployments and existing ciphertext keep working without
any environment changes — this is the "version 0 forever" backward
compatibility guarantee.

`PaymentEncryptionKeyringService`
(`src/common/crypto/payment-encryption-keyring.service.ts`) loads this
keyring once per process from `ConfigService` and exposes `.encrypt()`
(always uses the active version) and `.decrypt()` (looks up whichever
version the ciphertext says it was written with). It never logs key
material — startup diagnostics log only version numbers, never key bytes
(see §6).

### Ciphertext format: format version vs. key version

The on-disk encoding is `enc:v<keyVersion>:<iv>:<tag>:<ciphertext>`. The
`v<N>` segment is the **key version**, not a wire-format version — there is
currently only one wire format (AES-256-GCM with a 12-byte IV and 16-byte
tag, base64url-encoded fields). If the wire format ever needs to change
independently of key rotation, add a distinct format marker rather than
overloading this field (e.g. `enc2:v<N>:...`), so key-version parsing and
format parsing never become ambiguous. The legacy `redacted:<base64>`
prefix (pre-encryption placeholder format) is unrelated and passed through
unchanged by `decryptProtectedAmount`.

## 3. Staged rotation: dual-read behavior

Staged rotation is the default, safe path for rotating a key with no
downtime and no risk of losing access to existing data.

**Before rotation** — one key configured, e.g. only `PAYMENT_ENCRYPTION_KEY`
(implicit v0). All reads and writes use v0.

**Stage 1 — introduce the new version.** Set `PAYMENT_ENCRYPTION_KEY_V1` to
a freshly generated 32-byte key (base64 or hex; see §7 for generation).
Leave `PAYMENT_ENCRYPTION_KEY_VERSION` unset (or `0`) — writes still go to
v0. Both v0 and v1 are now loaded; nothing observable changes yet. This
step exists purely to get the new key material distributed to every
process before it is depended on.

**Stage 2 — cut writes over.** Set `PAYMENT_ENCRYPTION_KEY_VERSION=1` and
restart/redeploy. From this point:
- All **new** ciphertext is written as `enc:v1:...`.
- All **old** ciphertext (`enc:v0:...`) continues to decrypt normally —
  the version segment in the ciphertext tells `decryptProtectedAmount`
  which key to use, so old and new data coexist with zero read failures.
  This is the dual-read guarantee: a service instance restarted at any
  point during this stage, with both `_V0` and `_V1` configured, can read
  both eras of data.

**Stage 3 — let old data age out (retiring).** Leave `PAYMENT_ENCRYPTION_KEY_V0`
configured for as long as any row might still hold `enc:v0:...` ciphertext
(payments and webhook secrets are effectively never rewritten in place, so
in practice this window is indefinite unless a backfill job re-encrypts
old rows under v1 — no such backfill exists today; retiring v0 is an
explicit operator decision, not automatic).

Payment account addresses are the exception: their keys are derived from the
same `PAYMENT_ENCRYPTION_KEY_V<N>`, and `npm run payments:backfill-addresses`
re-encrypts and re-tokens them under the active version. Run it after Stage 2
and before retiring an old version. See
[payment address encryption](payment-address-encryption.md).

**Stage 4 — retire.** Once satisfied nothing still needs v0 (verified via a
backfill, a data audit, or an accepted retention/expiry cutoff), remove
`PAYMENT_ENCRYPTION_KEY_V0` from configuration entirely and restart. Any
ciphertext still tagged `enc:v0:...` now fails to decrypt with a typed,
unambiguous `UnknownKeyVersionError` (never silent corruption, never a
generic crash) — this is the explicit "retired" boundary the acceptance
criteria call for. `test/crypto/key-rotation.spec.ts` rehearses exactly
this sequence, including the restart step, with synthetic test keys.

The same four-stage shape applies to `VERIFICATION_HASH_SALT_*` (already
implemented) and would apply to `SESSION_SECRET` /
`CREDENTIAL_SIGNING_SECRET` if they are ever versioned (see §7 note on
extending the pattern).

## 4. Rollback

Rollback undoes Stage 2 (the write cutover) while still inside the
retiring window (Stage 3) — i.e. before the old version has been retired.

**Procedure:** set `PAYMENT_ENCRYPTION_KEY_VERSION` back to the previous
version number and restart/redeploy. Because the previous version's key
was never removed from configuration (it only stopped being the active
write key), this is a same-shape config change to the forward rotation —
no data migration, no re-encryption, no downtime.

**Safe limits on rollback:**
- Rollback is only safe **before retirement** (§2). Once a version's env
  var has been removed and a restart has happened without it, rollback
  requires restoring that key's original material from your secrets
  backup — the running process has no memory of a retired key.
- Data written under the newer version *while it was active* remains
  `enc:v<newVersion>:...` after rollback. Rolling back the write version
  does not retroactively change already-written ciphertext, and does not
  stop that data from continuing to decrypt correctly — the newer key
  must therefore stay configured (not retired) for as long as any data
  written under it might still need to be read, exactly symmetric to the
  forward-rotation retiring rule in §3.
- Rollback is a config-only operation; it never regenerates or discards
  key material, so it carries no risk of data loss as long as the safe
  limits above are respected.

## 5. Compromised-key emergency path

This path is distinct from staged rotation because a compromised key
cannot be trusted to sit in "retiring" for an extended window — the
priority shifts from zero-downtime continuity to limiting exposure.

1. **Do not remove the compromised version's env var yet.** Removing it
   immediately makes all data still encrypted under it permanently
   unreadable (see §2, "retired"). Decide first whether that data needs to
   be read and re-encrypted, or whether losing access to it is acceptable.
2. **Generate a new key version immediately** (`PAYMENT_ENCRYPTION_KEY_V<N+1>`,
   a freshly generated value — see §7) and cut writes over
   (`PAYMENT_ENCRYPTION_KEY_VERSION=<N+1>`) as an expedited Stage 1+2,
   collapsed into a single deploy rather than the normal two-step rollout,
   since the priority is to stop using the compromised key for new writes
   as fast as possible.
3. **If the compromised key's exposure is severe enough that even
   continued read access is unacceptable** (e.g. the key leaked alongside
   enough ciphertext to make offline decryption feasible outside your
   infrastructure), treat it as retired immediately: remove its env var,
   accept that any un-migrated data under it becomes unreadable, and file
   that data loss as an explicit, logged operator decision — not a side
   effect discovered later.
4. **Evidence to capture**, without ever including key material itself:
   - Which key identifier (purpose + version number) was compromised.
   - Timestamp of the new active version's cutover.
   - Whether the compromised version was retired immediately (§5.3) or
     left retiring for a defined migration window (§5.2), and the
     window's end date if the latter.
   - `PaymentEncryptionKeyringService`'s own startup log lines (version
     numbers and counts only — see §6) from before and after the
     incident, as they show exactly which versions were loaded and active
     at each point in time.
5. **After the incident**, once the compromised version is fully retired,
   confirm via `test/crypto/key-rotation.spec.ts`-style verification (or
   an equivalent check against real data) that ciphertext under the
   retired version now fails closed with `UnknownKeyVersionError` rather
   than silently succeeding — this is the proof that the compromised key
   is actually gone from every running process, not just from the primary
   config source.

## 6. No key material in logs, metrics, or commands

Verified for every file touched in this work:

- `PaymentEncryptionKeyringService` logs only version numbers and counts
  (`"Loaded versions: [0, 1]"`, `"Configured active payment encryption key
  version 5 is not loaded"`) — never the key strings themselves. See
  `src/common/crypto/payment-encryption-keyring.service.ts`.
- `CredentialSigningKeyringService` follows the identical rule: startup
  diagnostics and the malformed-`VERIFY_UNTIL` warning log only version
  numbers, key IDs (`earnproof-v<N>`, non-secret by construction), and
  timestamps — never a secret. See
  `src/common/crypto/credential-signing-keyring.service.ts`.
- `protected-amount.ts`'s error paths (`UnknownKeyVersionError`, the
  32-byte decode-length error) include the key **version number** for
  operator diagnosis, never the key material.
- `VerificationEventService` follows the same rule for
  `VERIFICATION_HASH_SALT_*` — its warnings reference version numbers and
  counts only.
- `WebhookSigningService`, `session.service.ts`, and `auth-token.service.ts`
  do not log their secrets; grepped for `logger.*secret`, `logger.*[Kk]ey`,
  and raw secret variable names across `src/auth/`, `src/credentials/`,
  `src/webhooks/`, and `src/common/crypto/` as part of this change with no
  hits. `credentials.service.ts`'s `credential_verify` log line includes
  `keyId` on an `unsupported_key` result — a non-secret identifier, never
  the secret it names.
- None of the four payment-encryption consumer call sites
  (`payments.service.ts`, `proofs.service.ts`,
  `webhook-delivery.service.ts`, `webhooks.service.ts`) log the key,
  ciphertext keys, or decrypted plaintext amounts — only IDs and outcomes.

Operators: never pass key material as a CLI argument (visible in shell
history and process listings) — use environment variables set via the
deployment platform's secret store, exactly as `PAYMENT_ENCRYPTION_KEY` is
today.

## 7. Generating new key versions

```
# Payment encryption key (32 bytes, base64) — for PAYMENT_ENCRYPTION_KEY_V<N>
openssl rand -base64 32

# Equivalent, hex-encoded (also accepted)
openssl rand -hex 32
```

The same commands apply to `VERIFICATION_HASH_SALT_V<N>` and
`CREDENTIAL_SIGNING_SECRET_V<N>` values (credential signing has no minimum
length beyond the 8-character floor `env.validation.ts` enforces, but a
generated 32-byte value is a reasonable default). Neither command, nor its
output, should ever appear in application logs, CI logs, or shell history
retained on a shared system — generate directly into the secret manager
where possible (`op run`, `aws secretsmanager`, `vault kv put`, etc.,
depending on deployment environment) rather than printing to a terminal
that gets logged.

## 8. Credential signing key rotation

`CredentialSigningKeyringService`
(`src/common/crypto/credential-signing-keyring.service.ts`) versions
`CREDENTIAL_SIGNING_SECRET` using the same loading convention as
`PaymentEncryptionKeyringService`: `CREDENTIAL_SIGNING_SECRET_V0`, `_V1`,
... loaded sequentially until the first gap, with the legacy unversioned
`CREDENTIAL_SIGNING_SECRET` treated as an implicit version 0 when
`CREDENTIAL_SIGNING_SECRET_V0` is not set. `CREDENTIAL_SIGNING_KEY_VERSION`
selects the active signing version.

Credential signing differs from payment encryption in two ways:

- **The key identifier travels with the credential, not the ciphertext.**
  Every newly-issued credential's `proof` block carries a non-secret
  `keyId` (`earnproof-v<N>`, from `CredentialSigningKeyringService.activeKeyId`
  / the `keyId()` / `versionFromKeyId()` helpers) alongside the signature.
  `CredentialsService.verifyCredential` (`src/credentials/credentials.service.ts`)
  reads `keyId` to select which secret to verify against — the same
  dual-read principle as payment encryption's `enc:v<N>:` prefix, applied
  to a signed document instead of ciphertext. A credential with no `keyId`
  (issued before this feature existed) is treated as legacy version 0.
- **A verify-only key can have an explicit, time-bounded overlap window.**
  Because there is no ciphertext that must keep decrypting forever, an
  operator demoting a version from active to verify-only may set
  `CREDENTIAL_SIGNING_SECRET_V<N>_VERIFY_UNTIL` (an ISO-8601 instant). Past
  that instant, `CredentialSigningKeyringService.isUsableForVerification(N)`
  returns `false` and `CredentialsService.verifyCredential` returns
  `unsupported_key` for any credential still claiming that key — even
  though the secret is technically still loaded. A version with no
  `VERIFY_UNTIL` set never expires on its own; it stays verify-only
  indefinitely until retired (its `_V<N>` env var removed). The **active**
  version is never subject to a deadline, regardless of configuration.

The same four-stage shape as §3 applies:

1. **Introduce** `CREDENTIAL_SIGNING_SECRET_V1`, leave `CREDENTIAL_SIGNING_KEY_VERSION`
   unset (or `0`) — new credentials still sign with v0.
2. **Cut writes over**: set `CREDENTIAL_SIGNING_KEY_VERSION=1`. New
   credentials are signed with v1 and carry `keyId: "earnproof-v1"`.
   Credentials already issued under v0 keep verifying, since v0 is still
   loaded and its `keyId` (`earnproof-v0`) is still recognized.
3. **Retiring**: optionally set `CREDENTIAL_SIGNING_SECRET_V0_VERIFY_UNTIL`
   to a deadline once existing v0-signed credentials are expected to have
   expired or been re-issued, bounding how long v0 stays trusted for
   verification without having to remove it immediately.
4. **Retire**: remove `CREDENTIAL_SIGNING_SECRET_V0` entirely (after any
   `VERIFY_UNTIL` deadline has passed, or directly if none was set). Any
   credential still claiming `keyId: "earnproof-v0"` now verifies as
   `unsupported_key` rather than silently failing signature comparison or,
   worse, being checked against the wrong key.

`test/crypto/credential-signing-key-rotation.spec.ts` rehearses this exact
sequence, including the bounded-overlap-window and restart steps, with
synthetic test secrets — the credential-signing equivalent of
`test/crypto/key-rotation.spec.ts`.

## 9. Deferred: session signing

`SESSION_SECRET` is a single, unversioned key today
(`src/auth/session.service.ts`, `src/auth/auth-token.service.ts`). This
pass does not add versioning code for it. This is a scoped trade-off, not
an oversight: session tokens are short-lived (12-hour default TTL — see
`DEFAULT_TTL_SECONDS` in `session.service.ts`) and the session store is a
database lookup by hash, not a self-contained signed token in the primary
flow (`AuthTokenService`, which does sign self-contained tokens, is already
marked `@deprecated` in favor of `SessionService`). Rotating
`SESSION_SECRET` without a dual-read path simply invalidates all
outstanding sessions — an acceptable, bounded blast radius (users
re-authenticate) rather than a silent-corruption risk.

**Operator policy in the meantime**: rotating `SESSION_SECRET` is a hard
cutover — plan it for a low-traffic window and expect all active sessions
to be invalidated.

## 10. Why webhook HMAC secrets are not globally rotated

`WebhookSigningService` (`src/webhooks/webhook-signing.service.ts`) signs
outbound webhook deliveries using a **per-webhook-endpoint** secret, stored
encrypted (via the payment-encryption keyring — see §1) in the `Webhook`
row itself, not a single global secret. This is already the correct
rotation model for this purpose:

- Each integrator's endpoint has an independent secret; rotating one
  endpoint's secret cannot affect any other endpoint's verification.
- `WebhooksService.rotateSecret` (see `src/webhooks/webhooks.service.ts`)
  already generates a new random secret, encrypts it with the current
  active payment-encryption key, and returns the raw value to the caller
  exactly once — the standard "rotate a per-entity secret" pattern.
- There is deliberately no "global webhook signing key version" to
  introduce: doing so would only add a layer of indirection without a
  corresponding safety benefit, since blast radius is already contained
  per-endpoint.

The one dependency worth noting: rotating the **payment-encryption key**
(§3) changes how webhook secrets are encrypted at rest, but does not
require touching individual webhook secrets — `WebhookDeliveryService` and
`WebhooksService` both decrypt via `PaymentEncryptionKeyringService`,
which transparently dual-reads across payment-encryption key versions
exactly like any other protected-amount ciphertext.

## 11. Operator rehearsal checklist

Use this checklist to rehearse a payment-encryption key rotation in a
non-production environment before ever running it against production
data. `test/crypto/key-rotation.spec.ts` automates the equivalent sequence
with synthetic keys; this checklist is the operator-facing version against
a real (non-production) deployment.

1. [ ] Generate a new key: `openssl rand -base64 32`. Store it in the
       secret manager as `PAYMENT_ENCRYPTION_KEY_V<N+1>`. Confirm it never
       appears in shell history or CI logs.
2. [ ] Deploy with the new version configured but `PAYMENT_ENCRYPTION_KEY_VERSION`
       unchanged. Confirm `PaymentEncryptionKeyringService`'s startup log
       shows the new version in `Loaded versions` and no error about the
       active version.
3. [ ] Confirm existing data (payments, webhook secrets) still reads
       correctly — spot-check a few known records through the normal
       application flow (not by inspecting ciphertext directly).
4. [ ] Cut writes over: set `PAYMENT_ENCRYPTION_KEY_VERSION=<N+1>`, deploy.
       Confirm a newly-created record's ciphertext is prefixed
       `enc:v<N+1>:` and an old record's is still readable.
5. [ ] Restart the process (or redeploy with no config change) and confirm
       both old and new records still decrypt — this proves dual-read
       survives a fresh process, not just an in-memory cache.
6. [ ] After the agreed retiring window, remove `PAYMENT_ENCRYPTION_KEY_V<N>`
       (the old version) and redeploy. Confirm any remaining old-version
       ciphertext now fails with `UnknownKeyVersionError` in logs (not a
       silent failure) and that this was expected/accepted per §3 Stage 4.
7. [ ] Record the rehearsal outcome (versions involved, timestamps, any
       deviations from this checklist) using the evidence fields in §5 as
       a template, even for a routine (non-emergency) rotation — this
       gives the next rotation, or an eventual real incident, a known-good
       baseline to compare against.
