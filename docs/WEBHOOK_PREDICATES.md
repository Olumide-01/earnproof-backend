# Bounded Webhook Subscription Predicates (Issue #323)

## Overview

Webhook subscriptions now support optional **bounded predicates** that select events using typed operators over three public fields: `resource`, `outcome`, and `schemaVersion`. Predicates are versioned, declarative JSON structures with deterministic limits on nesting depth, node count, and evaluation budget, ensuring bounded evaluation time with no access to private payload fields.

**Key design goals:**
- Deterministic: same predicate + event always produces the same result
- Private-field-safe: predicates can only see (resource, outcome, schemaVersion); payload is unreachable
- Budget-aware: evaluation stops if a per-event budget is exceeded, failing closed (no delivery)
- Production-ready: comprehensive validation, error codes, migration path, and tests

---

## Predicate Grammar (v1)

### Root Structure

```typescript
interface PredicateV1 {
  predicateVersion: "1";    // Frozen version; unknown versions rejected
  logic: PredicateExpression; // Evaluation tree
}
```

### Operators

#### Atomic Operators

- **`eq`**: Exact match. Field equals a single value (string, number, boolean, or null).
  ```json
  { "op": "eq", "field": "resource", "value": "proof" }
  ```

- **`in`**: One-of match. Field is one of a list of values.
  ```json
  { "op": "in", "field": "outcome", "values": ["created", "verified"] }
  ```

#### Logical Operators

- **`and`**: All sub-expressions must match. Short-circuits on first false.
  ```json
  { "op": "and", "expressions": [{...}, {...}] }
  ```

- **`or`**: Any sub-expression must match. Short-circuits on first true.
  ```json
  { "op": "or", "expressions": [{...}, {...}] }
  ```

- **`not`**: Negates a single sub-expression.
  ```json
  { "op": "not", "expressions": [{...}] }
  ```

### Fields

Predicates can filter on three public fields:

- **`resource`**: Resource type (e.g., "proof", "attestation"). Derived from the first part of the event type.
- **`outcome`**: Outcome code (e.g., "created", "verified", "revoked"). Derived from the second part of the event type.
- **`schemaVersion`**: Payload schema version (e.g., "1"). From the envelope's schemaVersion field.

**Example event parsing:**
- Event type: `proof.created`
- Schema version: `1`
- Derived context:
  - `resource = "proof"`
  - `outcome = "created"`
  - `schemaVersion = "1"`

---

## Limits (Inclusive Boundaries)

All limits are **inclusive**: accepted at the limit, rejected one over.

| Limit | Value | Boundary |
|-------|-------|----------|
| predicateVersion length | ≤16 chars | "1" OK, "1-alpha" OK, "1" × 17 chars rejected |
| Tree depth | ≤4 | Depth 4 accepted, depth 5 rejected |
| Tree nodes | ≤32 | 32 nodes accepted, 33 rejected |
| Field value length | ≤256 bytes (UTF-8) | "x"×256 OK, ×257 rejected |
| In-list size | ≤16 items | 16 items accepted, 17 rejected |
| Evaluation budget | ≤256 node visits per event | 256 visits succeed, 257th triggers budget exhaustion |

---

## Validation Error Codes (400 VALIDATION_ERROR)

All validation failures return HTTP 400 with a deterministic error code:

| Code | Reason |
|------|--------|
| `PREDICATE_VERSION_UNKNOWN` | `predicateVersion` not in `["1"]` |
| `PREDICATE_MISSING_VERSION` | `predicateVersion` field absent |
| `PREDICATE_INVALID_OPERATOR` | `op` not in `["eq", "in", "and", "or", "not"]` |
| `PREDICATE_INVALID_FIELD` | `field` not in `["resource", "outcome", "schemaVersion"]` |
| `PREDICATE_MISSING_FIELD` | Required field missing (e.g., "field" in atomic expr) |
| `PREDICATE_MISSING_LOGIC` | `logic` field is required but absent |
| `PREDICATE_TOO_DEEP` | Nesting depth > 4 |
| `PREDICATE_TOO_MANY_NODES` | Total nodes in tree > 32 |
| `PREDICATE_VALUE_TOO_LONG` | Field value > 256 bytes (UTF-8) |
| `PREDICATE_IN_LIST_TOO_LARGE` | `values` array size > 16 |
| `PREDICATE_IN_LIST_EMPTY` | `values` array is empty |
| `PREDICATE_INVALID_VALUE_TYPE` | Value is not string, number, boolean, or null |
| `PREDICATE_MALFORMED_JSON` | JSON parse error |
| `PREDICATE_UNKNOWN_FIELD` | Object contains unknown keys (strict validation) |
| `PREDICATE_AND_EXPRESSIONS_TOO_FEW` | AND has fewer than 2 sub-expressions |
| `PREDICATE_OR_EXPRESSIONS_TOO_FEW` | OR has fewer than 2 sub-expressions |
| `PREDICATE_NOT_EXPRESSIONS_WRONG_COUNT` | NOT has != 1 sub-expression |

---

## Evaluation Semantics

### Deterministic Replay

Re-evaluating the same event against the same predicate version **always** produces the same result:

- Event context is derived deterministically from the envelope
- Evaluation is a pure function of (predicate, context, budget)
- No external state, no timestamps, no randomness

### Budget Exhaustion (Fail Closed)

If a predicate evaluation exceeds the budget (256 node visits), delivery is **skipped**:

1. Evaluator tracks visited nodes during recursion
2. Before each operation, budget is checked
3. If `visited >= limit`, evaluation returns `match=false` with reason `EVALUATION_BUDGET_EXCEEDED`
4. Webhook delivery is not created; no retry is attempted

### Stale State During Delivery

If a subscription is **edited while an event is in flight**, the in-flight event uses the **predicate version from the delivery row at creation time**, not the updated subscription:

- When a delivery is created, `predicateSnapshot` is set to the subscription's current predicate
- Evaluator reads from `predicateSnapshot`, never from the subscription row
- If subscription is updated or deleted before delivery, in-flight delivery is unaffected

### Short-Circuit Evaluation

AND and OR operators short-circuit to reduce evaluation cost:

- **AND**: stops at first false sub-expression
- **OR**: stops at first true sub-expression
- Short-circuit prevents evaluating unnecessary branches

---

## API Endpoints

### Create Webhook with Predicate

**POST /api/v1/webhooks**

```json
{
  "url": "https://example.com/webhooks",
  "events": ["proof.created", "proof.verified"],
  "predicate": {
    "predicateVersion": "1",
    "logic": {
      "op": "eq",
      "field": "outcome",
      "value": "created"
    }
  }
}
```

Predicate is optional; existing subscriptions without predicates continue matching by event-type only.

### Preview Predicate

**POST /api/v1/webhooks/preview-predicate**

Test a predicate against a sample event **without creating a delivery** or modifying any state:

```json
{
  "predicate": {
    "predicateVersion": "1",
    "logic": {
      "op": "in",
      "field": "resource",
      "values": ["proof", "attestation"]
    }
  },
  "event": {
    "resource": "proof",
    "outcome": "created",
    "schemaVersion": "1"
  }
}
```

**Response (200 OK):**
```json
{
  "match": true,
  "reason": null,
  "visitedNodes": 2
}
```

- `match`: whether the predicate matched the event
- `reason`: why evaluation stopped (if not matched), e.g., "NO_MATCH", "EVALUATION_BUDGET_EXCEEDED"
- `visitedNodes`: number of predicate nodes visited (for debugging performance)

**Authorization:** Authenticated user with an active organization. Rate limited: 100 requests/minute.

---

## Examples

### Example 1: Match Only Created Events

```json
{
  "predicateVersion": "1",
  "logic": {
    "op": "eq",
    "field": "outcome",
    "value": "created"
  }
}
```

Matches events where outcome is exactly "created".

### Example 2: Match Proof or Attestation Resources

```json
{
  "predicateVersion": "1",
  "logic": {
    "op": "in",
    "field": "resource",
    "values": ["proof", "attestation"]
  }
}
```

Matches events where resource is either "proof" or "attestation".

### Example 3: Complex Filter: Proofs Only, Excluding Failed

```json
{
  "predicateVersion": "1",
  "logic": {
    "op": "and",
    "expressions": [
      { "op": "eq", "field": "resource", "value": "proof" },
      { "op": "not", "expressions": [
        { "op": "eq", "field": "outcome", "value": "failed" }
      ]}
    ]
  }
}
```

Matches if resource is "proof" AND outcome is not "failed".

### Example 4: Schema Version Check

```json
{
  "predicateVersion": "1",
  "logic": {
    "op": "eq",
    "field": "schemaVersion",
    "value": "1"
  }
}
```

Matches events with schema version "1".

---

## Migration and Backward Compatibility

### Prisma Schema Changes

- **Webhook.predicate**: New optional JSONB column (null for existing subscriptions)
- **WebhookDelivery.predicateSnapshot**: New optional JSONB column (snapshot of predicate at delivery time)

### Existing Subscriptions

Subscriptions created before predicates are supported have `predicate = NULL`:

- Matching logic: event-type only (unchanged behavior)
- No migration of existing subscriptions needed
- No data loss or compatibility issues

### Migration File

`prisma/migrations/20260101100000_add_webhook_predicates/migration.sql`

---

## Validation Implementation

### Files

- **predicate.types.ts**: TypeScript types and version constants
- **predicate-limits.ts**: Limit constants (depth, nodes, budget, etc.)
- **predicate.dto.ts**: Nested DTO classes for class-validator
- **predicate.validators.ts**: Custom validators (depth, node count, field value length, strict field checking)
- **api-error.dto.ts**: Predicate error codes added to ApiErrorCode enum

### Validation Flow

1. Client sends predicate in request body
2. NestJS class-validator checks DTO structure
3. Custom validators (`@ValidatePredicateExpression`) recursively validate:
   - Tree depth ≤ 4
   - Node count ≤ 32
   - Field value length ≤ 256 bytes
   - No unknown fields (strict)
   - Operators and fields from allowlist
4. If validation fails, 400 response with deterministic error code
5. If validation passes, predicate is stored in Webhook.predicate

---

## Evaluation Implementation

### PredicateEvaluatorService

Pure function evaluator with no side effects:

```typescript
evaluate(predicate: Predicate, context: WebhookEventContext): EvaluationResult
```

Returns:
- `match`: whether predicate matched
- `reason`: if not matched (e.g., "NO_MATCH", "EVALUATION_BUDGET_EXCEEDED")
- `visited`: nodes visited (for debugging)

Features:
- Deterministic: same inputs always produce same output
- Budgeted: tracks node visits, fails closed at budget limit
- Short-circuiting: and/or stop early on match/no-match

### Integration in Webhook Dispatch

In `WebhookDeliveryService.enqueueForOrganizations`:

1. Query webhooks with `predicate` field selected
2. After event-type match:
   - If predicate exists, evaluate it
   - Derive context from event type and schema version
   - If evaluation fails or budget exceeded, skip delivery (fail closed)
   - Log reason (debug level)
3. Create WebhookDelivery with `predicateSnapshot` set to predicate at creation time
4. Schedule delivery as normal

---

## Testing

### Unit Tests

**PredicateEvaluatorService.spec.ts** (40+ tests):

- **Atomic operators**: eq, in (positive, negative, edge cases)
- **Logical operators**: and, or, not (short-circuit, nesting)
- **Boundary conditions**: exact depth/node limits, list size limits
- **Budget exhaustion**: deep nesting, adversarial predicates
- **Context derivation**: event type parsing, malformed events
- **Deterministic behavior**: identical inputs produce identical outputs
- **Error handling**: malformed expressions, unknown operators

### Integration Tests (Recommended)

- Full dispatch flow with predicates
- Cross-tenant authorization (no escape)
- Replay with predicate snapshot consistency
- Budget exhaustion during delivery

---

## Security Considerations

### Private Field Protection

- Predicates **cannot** access payload fields
- Only (resource, outcome, schemaVersion) are exposed to predicates
- By construction: evaluator never receives full payload

### Bounded Evaluation

- No eval, no dynamic property access, no regex from user input
- Tree depth, node count, and budget limits prevent DoS
- Evaluation terminates within bounded time (256 visits max)

### Tenant Isolation

- Predicates belong to webhook's organization (inherited from subscription)
- No cross-tenant predicate access or execution
- Preview endpoint requires authenticated user with active org

### Deterministic Behavior

- No randomness, timestamps, or side effects in evaluation
- Same predicate + event always produces same result
- Enables auditing, testing, and debugging

---

## Future Extensions

The v1 grammar is intentionally minimal to ensure safety and predictability. Future versions may support:

- Additional operators (range comparisons, string matching)
- Field references (e.g., comparing two fields)
- Schema-aware type coercion

All future changes will require a new `predicateVersion` and separate validation/evaluation logic to ensure existing subscriptions remain stable.

---

## References

- **Issue #323**: Add bounded webhook subscription predicates
- **Design artifact**: `docs/WEBHOOK_PREDICATES.md` (this document)
- **Migration**: `prisma/migrations/20260101100000_add_webhook_predicates/migration.sql`
- **Validator**: `src/webhooks/validation/predicate.validators.ts`
- **Evaluator**: `src/webhooks/services/predicate-evaluator.service.ts`
- **Preview service**: `src/webhooks/services/predicate-preview.service.ts`
