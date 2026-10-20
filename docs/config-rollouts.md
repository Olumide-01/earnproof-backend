# Configuration Rollouts

Configuration changes get immutable signed snapshots, semantic comparison
across environments, staged canary rollout behind health gates, and recorded
rollback evidence.

This service is the **system of record** for which configuration an
environment is moving to and whether each stage was healthy. It does not
apply configuration: instances read their own environment and ask the cohort
endpoint whether they are in the current canary.

Code: [`src/config/config-snapshot.ts`](../src/config/config-snapshot.ts)
(snapshots, signatures, diffs), [`src/deployments/config-rollout.ts`](../src/deployments/config-rollout.ts)
(stages, gates, transitions), [`src/deployments/config-rollout.service.ts`](../src/deployments/config-rollout.service.ts).

## Snapshots

A snapshot is the effective configuration (the output of `configuration()`)
flattened to dot paths and sorted, for one environment
(`DEPLOYMENT_ENVIRONMENT`, default `NODE_ENV`).

### Secrets are excluded

Exclusion is deliberately over-eager: a non-secret that is excluded costs a
line in a diff; a secret that is included is a leak everywhere snapshots are
stored and shown. A path is excluded when:

- any path segment contains a secret word (`secret`, `password`, `token`,
  `key`, `salt`, `seed`, `mnemonic`, `private`, `credential`, `dsn`, `cookie`,
  `cert`, ...), or is a connection URL key (`databaseUrl`, `redisUrl`, ...); or
- the value looks like key material regardless of its key: a Stellar secret
  seed, a PEM block, a JWT, long hex, long mixed-case base64, or a URL with
  embedded credentials.

Excluded entries are recorded as `{ path, reason }` only — never a value,
length or hash. Public values such as `stellar.networkPassphrase`, public
keys and contract ids are kept.

### Identity and signatures

- `contentHash` is `sha256` over schema, environment, entries and exclusions
  (not the capture time), so capturing unchanged configuration returns the
  existing snapshot (`created: false`). Snapshots are append-only.
- The signature is HMAC-SHA256 over schema, environment, capture time and
  content hash. The key is `CONFIG_SNAPSHOT_SIGNING_SECRET`; without it, a
  purpose-bound key is derived from `CREDENTIAL_SIGNING_SECRET`
  (`keyId: derived-credential`), so the credential key itself never signs
  snapshots. With neither, capture returns `503`.
- Verification checks the hash, the signature (constant-time) and re-applies
  secret exclusion, so even a correctly signed document carrying a secret is
  refused (`secret_present`).

### Environment comparison

Environments usually have separate databases. Export a snapshot from one
environment (`GET …/snapshots/:id`) and import it into another
(`POST …/snapshots/import`); import requires a valid signature under the same
signing key. `GET …/snapshots/compare?base=&target=` returns a semantic diff:
`added`, `removed`, `changed` (with `before`/`after`, comparing canonically
and reporting type changes), and `excludedAdded`/`excludedRemoved` (paths
only). Output is sorted by path.

## Rollouts

`POST /deployments/config/rollouts` starts a rollout of a snapshot into an
environment with canary `stages` (default `CONFIG_ROLLOUT_DEFAULT_STAGES`,
`5,25,100`): strictly increasing whole percentages from at least 1, ending at
100. The baseline (restored on rollback) defaults to the environment's last
completed rollout. **At most one open rollout per environment** is enforced by
a unique key.

```
CANARY ──gate fails──▶ BLOCKED ──rollback──▶ ROLLED_BACK
  │  ▲                                      ▲
  │  └─ promote (stage < last) ─┐           │
  │                             │           │
  └──── rollback ───────────────┼───────────┘
        promote (last stage) ───┴──▶ COMPLETED
```

### Health gates

`POST …/rollouts/:id/gates` submits evidence `{ name, passed, observedAt }`
for the current stage. The gate passes only if:

- every `CONFIG_ROLLOUT_REQUIRED_GATE_CHECKS` check is present, and every
  submitted check (required or extra) passed;
- no check name is duplicated;
- every check was observed **during the current stage**
  (`observedAt ≥ stageStartedAt`) — evidence from an earlier stage or rollout
  cannot be replayed;
- no check is from the future (`observedAt ≤ now`) or older than
  `CONFIG_ROLLOUT_MAX_GATE_EVIDENCE_AGE_MS` (exactly max age is accepted).

A failed gate **blocks** the rollout. A blocked rollout cannot be gated or
promoted again; the only way forward is a recorded rollback.

### Promotion

`POST …/promote` requires a passing gate for the current stage evaluated no
more than `CONFIG_ROLLOUT_GATE_VALIDITY_MS` ago (exactly at the limit is
accepted). It advances the stage and resets the gate, so every stage needs
its own evidence. Promoting the final (100%) stage completes the rollout.

### Rollback

`POST …/rollback` with a bounded reason (`health_gate_failed`,
`operator_request`, `incident`) rolls back a canary or blocked rollout. The
`ROLLED_BACK` event records the restored and abandoned snapshot ids, the
status at rollback and the failing gate's event id. Completed rollouts are
final; roll forward with a new rollout of the baseline instead.

### Stale state and replay

Every transition carries `expectedVersion`. It is applied together with its
event only if the stored version still matches, so a stale or replayed
decision returns `409` with a stable `code` (`stale_version`, `stale_stage`,
`not_in_canary`, `not_open`, `gate_required`, `gate_expired`) and changes
nothing. Of two concurrent promotions, exactly one wins.

### Canary cohorts

`GET …/rollouts/:id/cohort?instanceId=` tells an instance which snapshot to
run. Membership is `sha256(rolloutId, instanceId)` mapped to `[0, 10000)` and
compared with `percent × 100`: deterministic, different per rollout, and
monotonic — an instance in the 5% cohort is also in the 25% cohort. Completed
rollouts assign everyone the new snapshot; rolled-back rollouts assign
everyone the baseline; a blocked rollout keeps its existing canaries until an
explicit rollback.

## Authorization

Every route requires a bearer session with role `ADMIN`. Actors are recorded
on every event. Events hold codes, ids, numbers and timestamps — never
configuration values.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DEPLOYMENT_ENVIRONMENT` | `NODE_ENV` | Environment slug for captured snapshots. |
| `CONFIG_SNAPSHOT_SIGNING_SECRET` | derived | Dedicated snapshot signing key (32+ chars). |
| `CONFIG_ROLLOUT_REQUIRED_GATE_CHECKS` | `readiness,error_rate,latency` | Checks every gate must contain. |
| `CONFIG_ROLLOUT_MAX_GATE_EVIDENCE_AGE_MS` | `900000` | Maximum evidence age at evaluation. |
| `CONFIG_ROLLOUT_GATE_VALIDITY_MS` | `3600000` | How long a passing gate allows promotion. |
| `CONFIG_ROLLOUT_DEFAULT_STAGES` | `5,25,100` | Default canary stages. |
