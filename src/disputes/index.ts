/**
 * Disputes Module Public API
 * 
 * Exports types, services, and DTOs related to proof dispute management.
 * This includes dispute lifecycle management and notification event types.
 */

// Services
export { DisputesService } from "./disputes.service";

// DTOs
export { CreateDisputeDto, ListDisputesDto, AssignDisputeDto, ResolveDisputeDto } from "./disputes.service";
export {
  CreateDisputeDecisionNotificationDto,
  ParticipantsDto,
  DisputeDecisionNotificationResponseDto,
} from "./dto/dispute-decision-notification.dto";

// Types and Enums
export {
  DisputeDecisionNotificationPayload,
  DisputeNotificationEventType,
  DisputeDecisionNotificationCommand,
} from "./events/dispute-decision-notification.types";
