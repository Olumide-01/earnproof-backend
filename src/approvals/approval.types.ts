/** Terminal states an {@link ApprovalRequest} can never leave once reached. */
export const TERMINAL_APPROVAL_STATUSES = [
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
  "EXECUTED",
] as const;
