import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";

/**
 * Approval intent receipt error taxonomy.
 *
 * Deterministic, semantic error codes that do not leak secrets or private material.
 */

/**
 * Approval was not found by the provided ID.
 */
export class ApprovalNotFoundError extends NotFoundException {
  readonly code = "APPROVAL_NOT_FOUND";

  constructor(approvalId: string) {
    super(`Approval ${approvalId} not found`);
  }
}

/**
 * Approval is not in a state where a receipt can be issued.
 *
 * The approval must be APPROVED. If it is PENDING, REJECTED, CANCELLED, or EXPIRED,
 * this error is raised.
 */
export class ApprovalNotConfirmedError extends ConflictException {
  readonly code = "APPROVAL_NOT_CONFIRMED";

  constructor(status: string) {
    super(`Approval is in state ${status}; cannot issue receipt. Only APPROVED approvals may have receipts.`);
  }
}

/**
 * The proposal referenced by the approval is in a terminal state.
 *
 * Receipts cannot be issued for approvals of proposals that have been EXECUTED,
 * CANCELLED, or EXPIRED. This prevents stale-state receipt generation.
 */
export class ProposalTerminalError extends ConflictException {
  readonly code = "PROPOSAL_TERMINAL";

  constructor(proposalId: string, status: string) {
    super(`Proposal ${proposalId} is in terminal state ${status}; cannot issue receipt.`);
  }
}

/**
 * The proposal state has changed since the approval was decided.
 *
 * This indicates a race condition or system inconsistency: the approval was decided
 * while the proposal was in a valid state, but the proposal has since transitioned
 * to a state incompatible with receipt issuance.
 */
export class StaleProposalStateError extends ConflictException {
  readonly code = "STALE_PROPOSAL_STATE";

  constructor(proposalId: string, expectedStatus: string, actualStatus: string) {
    super(
      `Proposal ${proposalId} state changed: expected ${expectedStatus} but found ${actualStatus}. ` +
        `Refresh and retry, or investigate if the proposal was manipulated.`,
    );
  }
}

/**
 * Caller is not authorized to access this receipt.
 *
 * Only the approver, related users, or system admins may retrieve a receipt.
 */
export class ReceiptAccessForbiddenError extends ForbiddenException {
  readonly code = "FORBIDDEN";

  constructor(reason: string = "Insufficient permissions to access this receipt") {
    super(reason);
  }
}

/**
 * Receipt signature verification failed.
 *
 * The cryptographic proof does not verify. This indicates either corruption,
 * a key mismatch, or an attack.
 */
export class ReceiptSignatureInvalidError extends BadRequestException {
  readonly code = "SIGNATURE_INVALID";

  constructor(receiptId: string) {
    super(`Receipt ${receiptId} signature verification failed.`);
  }
}

/**
 * The signing key used for this receipt is not available for verification.
 *
 * This occurs if the key was retired and its verification deadline has passed.
 */
export class ReceiptKeyUnavailableError extends BadRequestException {
  readonly code = "KEY_UNAVAILABLE";

  constructor(keyId: string) {
    super(`Signing key ${keyId} is not available for verification.`);
  }
}

/**
 * Receipt schema version is not recognized by the verifier.
 *
 * The receipt was signed with a schema version that this service does not support.
 * This may indicate a version mismatch or forward-compatibility issue.
 */
export class ReceiptUnknownSchemaError extends BadRequestException {
  readonly code = "UNKNOWN_SCHEMA";

  constructor(schemaVersion: string) {
    super(`Receipt schema version ${schemaVersion} is not supported.`);
  }
}

/**
 * Canonical encoding failed.
 *
 * The receipt data contains values that cannot be deterministically serialized
 * (e.g., non-finite numbers like NaN or Infinity).
 */
export class CanonicalEncodingError extends BadRequestException {
  readonly code = "CANONICAL_ENCODING_ERROR";

  constructor(reason: string) {
    super(`Cannot canonically encode receipt data: ${reason}`);
  }
}

/**
 * A receipt already exists for this approval.
 *
 * When a duplicate receipt request is made, this error is raised with 409 (Conflict)
 * if the request differs from the existing receipt, or 200 (OK) if it is identical
 * (idempotent).
 */
export class ReceiptAlreadyExistsError extends ConflictException {
  readonly code = "RECEIPT_EXISTS";

  constructor(approvalId: string) {
    super(`A receipt already exists for approval ${approvalId}.`);
  }
}
