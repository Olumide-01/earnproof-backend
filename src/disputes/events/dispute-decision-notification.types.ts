import { DisputeCategory, DisputeStatus } from "@prisma/client";

/**
 * DisputeDecisionNotificationPayload
 * 
 * Emitted when a dispute reaches a decision (resolution, withdrawal, or expiry).
 * This event drives the creation of privacy-safe notifications for all participants.
 * 
 * Privacy guarantees:
 * - No sensitive proof data (claims, balances, hashes) included
 * - Only decision-relevant information disclosed
 * - Participants notified according to their authorization level
 * 
 * Event versions:
 * v1: Initial - includes disputeId, proofId, outcome, reason, participants
 */
export interface DisputeDecisionNotificationPayload {
  disputeId: string;
  proofId: string;
  organizationId: string;
  category: DisputeCategory;
  decisionType: "RESOLVED" | "WITHDRAWN" | "EXPIRED";
  status: DisputeStatus;
  
  // Resolution details (when decisionType is RESOLVED)
  resolutionOutcome?: string;  // e.g., "UPHELD", "REJECTED", "INCONCLUSIVE"
  resolutionReason?: string;   // Max 2000 chars, human-readable explanation
  resolvedBy?: string;         // User ID of resolver
  resolvedAt?: string;         // ISO timestamp
  
  // Withdrawal details (when decisionType is WITHDRAWN)
  withdrawnBy?: string;        // User ID who withdrew
  withdrawnAt?: string;        // ISO timestamp
  
  // Participant tracking for notification routing
  participants: {
    proofOwnerId: string;      // Proof creator / principal owner
    disputeSubmitterId: string; // Who initiated the dispute
    assignedReviewerId?: string; // Optional reviewer if assigned
  };
}

/**
 * DisputeNotificationEvent
 * 
 * Tracks dispute lifecycle events that trigger notifications:
 * - FILED: Initial dispute submission
 * - ASSIGNED: Dispute assigned to reviewer
 * - WITHDRAWN: Dispute withdrawn by submitter
 * - RESOLVED: Dispute resolved with outcome
 * - EXPIRED: Proof with dispute expired (stale-state cleanup)
 * 
 * These are emitted as domain events via the outbox pattern for
 * reliable, deduplicated async delivery.
 */
export enum DisputeNotificationEventType {
  FILED = "DISPUTE_FILED",
  ASSIGNED = "DISPUTE_ASSIGNED",
  WITHDRAWN = "DISPUTE_WITHDRAWN",
  RESOLVED = "DISPUTE_RESOLVED",
  EXPIRED = "DISPUTE_EXPIRED",
}

/**
 * DisputeDecisionNotificationCommand
 * 
 * Internal command used to trigger notification generation.
 * This is used by the dispute decision event handler.
 */
export interface DisputeDecisionNotificationCommand {
  disputeId: string;
  proofId: string;
  organizationId: string;
  category: DisputeCategory;
  decisionType: "RESOLVED" | "WITHDRAWN" | "EXPIRED";
  status: DisputeStatus;
  resolutionOutcome?: string;
  resolutionReason?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  withdrawnBy?: string;
  withdrawnAt?: string;
  proofOwnerId: string;
  disputeSubmitterId: string;
  assignedReviewerId?: string;
}
