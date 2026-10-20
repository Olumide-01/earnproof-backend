import { SetMetadata } from "@nestjs/common";
import { Request } from "express";

/**
 * Metadata key under which a route's batch throttle-cost resolver is stored.
 *
 * Read by {@link RoleAwareThrottlerGuard} at request time. Kept as an exported
 * symbol so the guard and the decorator cannot drift apart on a string literal.
 */
export const THROTTLE_COST_KEY = "throttle:cost";

/**
 * How many throttling tokens one request to a batch route consumes.
 *
 * A batch endpoint verifies N items in one HTTP call, so charging it a single
 * token would let a client do `limit` batches of the maximum size — orders of
 * magnitude more work than the same limit was sized for on the single-item
 * route. The resolver returns the item count so the guard can charge the bucket
 * proportionally: a batch of ten costs ten, and a caller's remaining budget
 * reflects the work actually requested rather than the number of calls made.
 *
 * The resolver runs after body parsing and DTO validation, so the collection it
 * inspects is already bounded by the route's own maximum; a returned value is
 * clamped to at least one by the guard.
 */
export type ThrottleCostResolver = (request: Request) => number;

/** Charge a route a per-request throttle cost derived from its body. */
export const ThrottleCost = (resolver: ThrottleCostResolver) =>
  SetMetadata(THROTTLE_COST_KEY, resolver);
