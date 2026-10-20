# Dependency Health Hysteresis and Incident Timelines

## Overview

The health hysteresis system prevents transient dependency failures from triggering false incidents while preserving evidence of actual problems. It implements a sustained-failure and sustained-recovery policy that requires failures and recoveries to exceed configurable thresholds before state machine transitions occur.

## Concepts

### State Machine

Each dependency has at most one incident at a time. The incident lifecycle progresses through these states:

```
HEALTHY (default)
  ↓ (sustained failures exceed threshold)
UNHEALTHY
  ├─ (operator acknowledges) → ACKNOWLEDGED
  │   ├─ (sustained recovery) → RECOVERED → HEALTHY
  │   └─ (acknowledgement expires) → UNHEALTHY
  └─ (sustained recovery) → RECOVERED → HEALTHY
```

### Hysteresis Thresholds

**Failure threshold**: A dependency transitions to UNHEALTHY when consecutive probes fail at least N times within a configured window (default: 3 failures in 60 seconds).

**Recovery threshold**: A dependency transitions to RECOVERED when consecutive probes succeed at least M times within a configured window (default: 5 successes in 2 minutes).

**Transient failure isolation**: A single failure never creates an incident. Failures reset the failure counter once the failure window expires or a success is recorded. This prevents false alarms from brief hiccups.

### Immutable Timelines

Every state transition is recorded as an immutable `HealthTransition` entry. Transitions preserve:
- Reason code (e.g., `PROBE_TIMEOUT`, `SUSTAINED_FAILURE`)
- Status before and after
- Probe count in the window
- Duration since the previous transition
- Optional operator actor ID and note

This creates an audit trail of the incident lifecycle without rewriting history.

### Operator Acknowledgement

An operator can acknowledge an UNHEALTHY incident to suppress alerts for a bounded time window (5 minutes to 24 hours). Acknowledgements are immutable; once created, only expiration closes them. To un-acknowledge, close the incident instead.

An expired acknowledgement reverts the incident back to UNHEALTHY so operators cannot accidentally suppress recovery.

## Architecture

### HealthIncidentService

State machine implementation. Manages incident lifecycle and transitions.

**Key methods:**

- `recordProbe(dependencyName, success, reasonCode)` — Process probe result and update incident state
- `acknowledgeIncident(dependencyName, acknowledgedBy, note, expiresAt)` — Acknowledge UNHEALTHY incident
- `closeIncident(dependencyName, actorId, note)` — Manually close incident (admin override)
- `getIncident(dependencyName)` — Fetch incident by dependency name
- `listIncidents(status?)` — List incidents with optional status filter

**Concurrency**: Uses optimistic concurrency control with version counters. Update statements include `version: { increment: 1 }` to ensure exactly one winner in concurrent updates.

### HealthHysteresisService

Applies hysteresis to probe results, mapping probe statuses to incident reason codes.

**Key methods:**

- `applyHysteresis(dependencyName, probeResult)` — Record probe result in state machine
- `isIncident(dependencyName)` — Check if dependency is currently in incident state

This service is stateless; all state is persisted by HealthIncidentService.

### HealthService Integration

HealthService probes each dependency and caches results. After a fresh probe (not from cache), hysteresis is applied asynchronously via `applyHysteresisAsync()`.

The fire-and-forget pattern ensures probes remain fast even if incident state recording takes time. Errors are logged but do not fail the probe.

### IncidentsController

REST API for incident management. All endpoints require `ORG_ADMIN` scope via ApiKeyGuard + ScopesGuard.

**Endpoints:**

- `GET /health/incidents` — List all incidents
- `GET /health/incidents/{dependencyName}` — Get incident by dependency name
- `POST /health/incidents/{dependencyName}/acknowledge` — Acknowledge UNHEALTHY incident
- `POST /health/incidents/{dependencyName}/close` — Manually close incident

**Redaction**: All responses use stable reason codes and timestamps only. No raw errors, credentials, or diagnostics are exposed.

## Probe Status Mapping

| Probe Status | Maps To | Reason Code |
|---|---|---|
| `ok` | Success | `SUSTAINED_RECOVERY` |
| `degraded` | Failure | `PROBE_DEGRADED` |
| `timeout` | Failure | `PROBE_TIMEOUT` |
| `error` | Failure | `PROBE_ERROR` |
| `disabled` | Success | `SUSTAINED_RECOVERY` (no incident) |
| `not_configured` | Success | `SUSTAINED_RECOVERY` (no incident) |

## Database Schema

### HealthIncident

Persists incident state and configuration.

```prisma
model HealthIncident {
  id                           String                  @id
  dependencyName               String                  @unique
  status                       HealthIncidentStatus
  reasonCode                   HealthIncidentReasonCode?
  configVersion                Int
  failureThreshold             Int
  recoveryThreshold            Int
  failureWindowMs              BigInt
  recoveryWindowMs             BigInt
  openedAt                     DateTime?
  acknowledgedAt               DateTime?
  closedAt                     DateTime?
  currentProbeCount            Int
  probeCountWindowStart        DateTime?
  totalFailedProbes            Int
  totalSuccessfulProbes        Int
  version                      Int
  createdAt                    DateTime
  updatedAt                    DateTime
  transitions                  HealthTransition[]
  acknowledgement              HealthIncidentAcknowledgement?
}
```

### HealthTransition

Immutable log of state transitions.

```prisma
model HealthTransition {
  id                    String
  incidentId            String
  reason                HealthIncidentReasonCode
  status                HealthIncidentStatus
  probeCount            Int
  durationMs            BigInt
  actorId               String?
  note                  String?
  createdAt             DateTime
}
```

### HealthIncidentAcknowledgement

Operator acknowledgement record.

```prisma
model HealthIncidentAcknowledgement {
  id                    String
  incidentId            String    @unique
  acknowledgedBy        String
  note                  String
  expiresAt             DateTime
  createdAt             DateTime
}
```

### Enums

**HealthIncidentStatus:**
- `HEALTHY` — No incident open
- `UNHEALTHY` — Sustained failures detected
- `ACKNOWLEDGED` — Operator acknowledged; tracking recovery
- `RECOVERED` — Incident closed; dependency recovered

**HealthIncidentReasonCode:**
- `PROBE_TIMEOUT` — Probe exceeded timeout
- `PROBE_ERROR` — Probe returned error
- `PROBE_DEGRADED` — Probe reported degraded operation
- `SUSTAINED_FAILURE` — Threshold of failures exceeded
- `SUSTAINED_RECOVERY` — Threshold of successes exceeded
- `OPERATOR_ACKNOWLEDGED` — Operator acknowledged incident

## Deterministic Behavior

All state transitions are deterministic and boundary-safe:

### Failure Window Expiration

If the failure window expires (elapsed > failureWindowMs) while in UNHEALTHY state, the probe count resets. This prevents old failures from accumulating forever.

```
Time: 0ms   → Probe 1 fails (count = 1)
Time: 20ms  → Probe 2 fails (count = 2)
Time: 50ms  → Probe 3 fails (count = 3, UNHEALTHY)
Time: 70ms  → Window expires, failure count reset
Time: 80ms  → Probe 4 fails (count = 1, still UNHEALTHY)
```

### Recovery Window Expiration

If the recovery window expires (elapsed > recoveryWindowMs) in UNHEALTHY or ACKNOWLEDGED state, the success count resets without leaving the incident.

```
Time: 0ms   → Incident UNHEALTHY
Time: 80ms  → Probe 1 succeeds (count = 1)
Time: 150ms → Window expires, success count reset
Time: 200ms → Probe 2 succeeds (count = 1)
```

### Acknowledgement Expiration

If an acknowledgement expires while the incident is ACKNOWLEDGED, the incident reverts to UNHEALTHY and probes continue tracking recovery.

```
Incident: ACKNOWLEDGED, expires at T+3600s
Time: T+3600s → Acknowledgement expires
Time: T+3601s → Next probe: back to UNHEALTHY tracking
```

### Probe Count Reset on Status Change

When a dependency transitions out of a failure/recovery state, the probe count resets. For example, a successful probe in UNHEALTHY resets the failure count and begins accumulating successes.

## Authorization

All incident endpoints require **ORG_ADMIN scope** on the API key.

- `ApiKeyGuard` — Validates API key signature and presence
- `ScopesGuard` — Enforces required scopes
- `@RequireScopes(ApiKeyScope.ORG_ADMIN)` — Declares ORG_ADMIN requirement

Missing or invalid API keys return 401. Insufficient scopes return 403.

## Redaction and Privacy

All incident responses expose only:

1. **Stable reason codes** — Never raw error text
2. **Timestamps** — When transitions occurred
3. **State machine info** — Current status, probe counts
4. **Metadata** — Operator note, TTL

Never exposed:
- Raw error messages
- Stack traces
- Connection strings
- Credentials or authentication material
- Raw probe output

## Testing

### Test Coverage

- **Positive cases**: Healthy probes, sustained failures, sustained recovery
- **Negative cases**: Transient failures, window expiration, acknowledgement expiration
- **Authorization cases**: Missing API key, insufficient scope
- **Boundary cases**: Exact threshold values, time window boundaries
- **Concurrency cases**: Optimistic concurrency, simultaneous updates

### Test Files

- `health-incident.service.spec.ts` — State machine unit tests
- `health-hysteresis.service.spec.ts` — Hysteresis application tests
- `incidents.controller.spec.ts` — API endpoint tests

### Running Tests

```bash
npm run test -- --testPathPattern=health-incident
npm run test -- --testPathPattern=health-hysteresis
npm run test -- --testPathPattern=incidents.controller
```

## Example Scenarios

### Scenario 1: Transient Database Hiccup

```
Time: 0s     → Database probe succeeds (count: 1, status: HEALTHY)
Time: 5s     → Database probe fails (count: 1, status: HEALTHY)
Time: 10s    → Database probe succeeds (count: 1, status: HEALTHY)
```

**Outcome**: No incident created. Single failure is isolated.

### Scenario 2: Sustained Database Outage

```
Time: 0s     → Probe 1 fails (count: 1, status: HEALTHY)
Time: 5s     → Probe 2 fails (count: 2, status: HEALTHY)
Time: 10s    → Probe 3 fails (count: 3, status: UNHEALTHY, openedAt: 10s)
Time: 15s    → Operator acknowledges with 1-hour TTL
             → Status: ACKNOWLEDGED, acknowledgedAt: 15s
Time: 20s    → Probe 4 succeeds (count: 1, status: ACKNOWLEDGED)
...
Time: 60s    → Probe 11 succeeds (count: 5, status: RECOVERED)
             → Incident closed, closedAt: 60s
```

**Outcome**: Incident created after 3 failures. Operator acknowledges. Recovery tracked. Incident auto-closed on sustained success.

### Scenario 3: Flapping Dependency (Hysteresis Prevents False Alerts)

```
Time: 0s     → Probe 1 fails (count: 1, status: HEALTHY)
Time: 30s    → Probe 2 succeeds (count: 0, status: HEALTHY)
Time: 60s    → Probe 3 fails (count: 1, status: HEALTHY)
Time: 90s    → Probe 4 succeeds (count: 0, status: HEALTHY)
Time: 120s   → Probe 5 fails (count: 1, status: HEALTHY)
```

**Outcome**: No incident despite repeated failures. Hysteresis prevents alert fatigue.

## Configuration

Default thresholds can be adjusted in the database schema or at runtime by updating the `HealthIncident` row:

```typescript
failureThreshold: 3        // failures to trigger UNHEALTHY
recoveryThreshold: 5       // successes to trigger RECOVERED
failureWindowMs: 60_000    // 1 minute window for failures
recoveryWindowMs: 120_000  // 2 minute window for recovery
```

## Future Enhancements

1. **Configurable thresholds** — Allow per-dependency configuration
2. **Webhook notifications** — Alert on state transitions
3. **Metrics export** — Prometheus metrics for incident timelines
4. **Auto-remediation** — Trigger corrective actions on thresholds
5. **Dependency correlation** — Track cascading failures across dependencies
