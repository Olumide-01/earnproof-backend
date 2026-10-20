import { Injectable, Logger } from "@nestjs/common";
import { PredicateEvaluatorService } from "./predicate-evaluator.service";
import { PredicateDto } from "../dto/predicate.dto";
import { PredicatePreviewEventDto } from "../dto/predicate.dto";
import { Predicate, WebhookEventContext } from "../predicate.types";

/**
 * Service for previewing predicate evaluation without side effects.
 *
 * Allows clients to test a predicate against a sample event or event type,
 * seeing whether it matches and how many nodes were visited during evaluation.
 *
 * Design:
 * - Zero side effects: does not create deliveries, does not modify state
 * - Deterministic: same predicate + event always produces the same result
 * - Budget-aware: reports nodes visited, helping detect performance issues
 * - Fail closed: evaluation failures return match=false with a reason
 */
@Injectable()
export class PredicatePreviewService {
  private readonly logger = new Logger(PredicatePreviewService.name);

  constructor(private readonly predicateEvaluator: PredicateEvaluatorService) {}

  /**
   * Preview a predicate against a sample event.
   *
   * Returns:
   * - match: whether the predicate matched
   * - reason: why evaluation stopped (if not matched)
   * - visitedNodes: number of nodes visited during evaluation
   *
   * No side effects: does not create deliveries or modify any state.
   *
   * @param predicateDto The predicate to test (already validated)
   * @param eventDto The sample event to test against
   * @returns Preview result with match status and budget usage
   */
  preview(
    predicateDto: PredicateDto,
    eventDto: PredicatePreviewEventDto,
  ): {
    match: boolean;
    reason?: string;
    visitedNodes: number;
  } {
    // Convert DTO to predicate domain type
    const predicate: Predicate = {
      predicateVersion: predicateDto.predicateVersion,
      logic: predicateDto.logic as any,
    };

    // Create evaluation context from sample event
    const context: WebhookEventContext = {
      resource: eventDto.resource,
      outcome: eventDto.outcome,
      schemaVersion: eventDto.schemaVersion,
    };

    // Evaluate
    const result = this.predicateEvaluator.evaluate(predicate, context);

    this.logger.debug(
      `Predicate preview: match=${result.match}, reason=${result.reason ?? "none"}, visited=${result.visited}`,
    );

    return {
      match: result.match,
      reason: result.reason,
      visitedNodes: result.visited,
    };
  }
}
