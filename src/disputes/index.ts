/**
 * Disputes Module Public API
 * 
 * Exports types, services, and DTOs related to proof dispute management.
 * This includes dispute lifecycle management and notification event types.
 */

// Services
export { DisputesService } from "./disputes.service";

// DTOs
export type { CreateDisputeDto, ListDisputesDto, AssignDisputeDto, ResolveDisputeDto } from "./disputes.service";
export {
  CreateDisputeDecisionNotificationDto,
  ParticipantsDto,
} from "./dto/dispute-decision-notification.dto";
export type {
  DisputeDecisionNotificationResponseDto,
} from "./dto/dispute-decision-notification.dto";

// Types and Enums
export type {
  DisputeDecisionNotificationPayload,
  DisputeDecisionNotificationCommand,
} from "./events/dispute-decision-notification.types";
export {
  DisputeNotificationEventType,
} from "./events/dispute-decision-notification.types";
