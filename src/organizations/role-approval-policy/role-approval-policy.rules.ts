import { OrganizationMemberRole } from "@prisma/client";

/**
 * Organization role approval policy rules (#298).
 *
 * Pure functions only, so every boundary can be pinned in a unit test without
 * a database. The service owns persistence, authorization and concurrency; this
 * file owns what a valid policy is.
 *
 * Platform minimums are a floor an organization can raise but never lower:
 *
 * - OWNER and ADMIN are always protected roles.
 * - At least one approval is always required, and at most five.
 * - Only OWNER and ADMIN may ever approve.
 * - Approvals expire between 15 minutes and 7 days after the request.
 * - Separation of duties is fixed: the requester never approves their own
 *   change, the member whose role changes never approves it, and one approver
 *   counts once. These are not policy fields an organization can switch off;
 *   an input that tries to is reported as a violation.
 */

export const ORGANIZATION_ROLES: readonly OrganizationMemberRole[] = [
  "OWNER",
  "ADMIN",
  "MEMBER",
  "VIEWER",
];

export const PLATFORM_PROTECTED_ROLES: readonly OrganizationMemberRole[] = [
  "OWNER",
  "ADMIN",
];

export const PERMITTED_APPROVER_ROLES: readonly OrganizationMemberRole[] = [
  "OWNER",
  "ADMIN",
];

export const MIN_REQUIRED_APPROVALS = 1;
export const MAX_REQUIRED_APPROVALS = 5;
export const MIN_APPROVAL_EXPIRY_MINUTES = 15;
export const MAX_APPROVAL_EXPIRY_MINUTES = 7 * 24 * 60;

/** Version reported for an organization that has never stored a policy. */
export const DEFAULT_POLICY_VERSION = 0;

/** Separation-of-duties invariants. Reported on every policy; never stored. */
export interface SeparationOfDuties {
  selfApprovalProhibited: true;
  targetApprovalProhibited: true;
  distinctApproversRequired: true;
}

export const SEPARATION_OF_DUTIES: SeparationOfDuties = {
  selfApprovalProhibited: true,
  targetApprovalProhibited: true,
  distinctApproversRequired: true,
};

/** The settable part of a policy, normalized. */
export interface RoleApprovalPolicyRules {
  protectedRoles: OrganizationMemberRole[];
  approverRoles: OrganizationMemberRole[];
  requiredApprovals: number;
  approvalExpiryMinutes: number;
  ownerChangesRequireOwnerApproval: boolean;
}

/** Policy input as received, before validation. */
export interface RoleApprovalPolicyInput {
  protectedRoles: string[];
  approverRoles: string[];
  requiredApprovals: number;
  approvalExpiryMinutes: number;
  ownerChangesRequireOwnerApproval: boolean;
  /** Accepted only so an attempt to disable it can be reported, never stored. */
  selfApprovalProhibited?: boolean;
  /** Accepted only so an attempt to disable it can be reported, never stored. */
  targetApprovalProhibited?: boolean;
}

export const DEFAULT_ROLE_APPROVAL_POLICY: RoleApprovalPolicyRules = {
  protectedRoles: [...PLATFORM_PROTECTED_ROLES],
  approverRoles: [...PERMITTED_APPROVER_ROLES],
  requiredApprovals: 1,
  approvalExpiryMinutes: 24 * 60,
  ownerChangesRequireOwnerApproval: true,
};

/** Stable violation codes. Clients may branch on these; messages may change. */
export type PolicyViolationCode =
  | "UNKNOWN_ROLE"
  | "PROTECTED_ROLES_BELOW_PLATFORM_MINIMUM"
  | "APPROVER_ROLES_EMPTY"
  | "APPROVER_ROLE_NOT_PERMITTED"
  | "OWNER_APPROVAL_REQUIRES_OWNER_APPROVER"
  | "REQUIRED_APPROVALS_OUT_OF_RANGE"
  | "APPROVAL_EXPIRY_OUT_OF_RANGE"
  | "SELF_APPROVAL_CANNOT_BE_ENABLED"
  | "TARGET_APPROVAL_CANNOT_BE_ENABLED";

export interface PolicyViolation {
  code: PolicyViolationCode;
  field: string;
  message: string;
}

/**
 * Validates a proposed policy against the platform minimums.
 *
 * Returns every violation rather than the first, so a preview can show an
 * administrator the whole problem at once. Order is fixed (field order, then
 * role order) so the same input always yields the same list.
 */
export function validateRoleApprovalPolicy(
  input: RoleApprovalPolicyInput,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  for (const field of ["protectedRoles", "approverRoles"] as const) {
    for (const role of input[field]) {
      if (!isOrganizationRole(role)) {
        violations.push({
          code: "UNKNOWN_ROLE",
          field,
          message: `"${String(role).slice(0, 32)}" is not an organization role.`,
        });
      }
    }
  }

  const missingProtected = PLATFORM_PROTECTED_ROLES.filter(
    (role) => !input.protectedRoles.includes(role),
  );
  if (missingProtected.length > 0) {
    violations.push({
      code: "PROTECTED_ROLES_BELOW_PLATFORM_MINIMUM",
      field: "protectedRoles",
      message: `Protected roles must include ${missingProtected.join(", ")}.`,
    });
  }

  if (input.approverRoles.length === 0) {
    violations.push({
      code: "APPROVER_ROLES_EMPTY",
      field: "approverRoles",
      message: "At least one approver role is required.",
    });
  }

  for (const role of input.approverRoles) {
    if (isOrganizationRole(role) && !PERMITTED_APPROVER_ROLES.includes(role)) {
      violations.push({
        code: "APPROVER_ROLE_NOT_PERMITTED",
        field: "approverRoles",
        message: `${role} may not approve role changes.`,
      });
    }
  }

  if (
    input.ownerChangesRequireOwnerApproval &&
    !input.approverRoles.includes("OWNER")
  ) {
    // Otherwise no one could ever approve a change touching OWNER.
    violations.push({
      code: "OWNER_APPROVAL_REQUIRES_OWNER_APPROVER",
      field: "approverRoles",
      message:
        "approverRoles must include OWNER while ownerChangesRequireOwnerApproval is true.",
    });
  }

  if (
    !Number.isInteger(input.requiredApprovals) ||
    input.requiredApprovals < MIN_REQUIRED_APPROVALS ||
    input.requiredApprovals > MAX_REQUIRED_APPROVALS
  ) {
    violations.push({
      code: "REQUIRED_APPROVALS_OUT_OF_RANGE",
      field: "requiredApprovals",
      message:
        `requiredApprovals must be a whole number from ${MIN_REQUIRED_APPROVALS} ` +
        `to ${MAX_REQUIRED_APPROVALS}.`,
    });
  }

  if (
    !Number.isInteger(input.approvalExpiryMinutes) ||
    input.approvalExpiryMinutes < MIN_APPROVAL_EXPIRY_MINUTES ||
    input.approvalExpiryMinutes > MAX_APPROVAL_EXPIRY_MINUTES
  ) {
    violations.push({
      code: "APPROVAL_EXPIRY_OUT_OF_RANGE",
      field: "approvalExpiryMinutes",
      message:
        `approvalExpiryMinutes must be a whole number from ${MIN_APPROVAL_EXPIRY_MINUTES} ` +
        `to ${MAX_APPROVAL_EXPIRY_MINUTES}.`,
    });
  }

  if (input.selfApprovalProhibited === false) {
    violations.push({
      code: "SELF_APPROVAL_CANNOT_BE_ENABLED",
      field: "selfApprovalProhibited",
      message: "Self-approval is prohibited by the platform and cannot be enabled.",
    });
  }

  if (input.targetApprovalProhibited === false) {
    violations.push({
      code: "TARGET_APPROVAL_CANNOT_BE_ENABLED",
      field: "targetApprovalProhibited",
      message:
        "The member whose role changes may never approve that change; this cannot be enabled.",
    });
  }

  return violations;
}

/**
 * Normalizes a valid input: deduplicated roles in canonical order. Call only
 * after {@link validateRoleApprovalPolicy} returned no violations.
 */
export function normalizeRoleApprovalPolicy(
  input: RoleApprovalPolicyInput,
): RoleApprovalPolicyRules {
  return {
    protectedRoles: canonicalRoles(input.protectedRoles),
    approverRoles: canonicalRoles(input.approverRoles),
    requiredApprovals: input.requiredApprovals,
    approvalExpiryMinutes: input.approvalExpiryMinutes,
    ownerChangesRequireOwnerApproval: input.ownerChangesRequireOwnerApproval,
  };
}

export interface PolicyFieldChange {
  field: keyof RoleApprovalPolicyRules;
  from: unknown;
  to: unknown;
}

/** Field-by-field difference, in a fixed field order. Empty means identical. */
export function diffRoleApprovalPolicies(
  current: RoleApprovalPolicyRules,
  proposed: RoleApprovalPolicyRules,
): PolicyFieldChange[] {
  const fields: (keyof RoleApprovalPolicyRules)[] = [
    "protectedRoles",
    "approverRoles",
    "requiredApprovals",
    "approvalExpiryMinutes",
    "ownerChangesRequireOwnerApproval",
  ];

  return fields
    .filter(
      (field) => JSON.stringify(current[field]) !== JSON.stringify(proposed[field]),
    )
    .map((field) => ({ field, from: current[field], to: proposed[field] }));
}

export interface RoleChangeEvaluation {
  approvalRequired: boolean;
  requiredApprovals: number;
  eligibleApproverRoles: OrganizationMemberRole[];
  ownerApprovalRequired: boolean;
  approvalExpiryMinutes: number;
  separationOfDuties: SeparationOfDuties;
}

/**
 * What a policy demands for one role change.
 *
 * `fromRole` is null when the change grants membership, `toRole` is null when
 * it removes it. A change touching a protected role on either side needs
 * approval: removing an ADMIN is as sensitive as granting one.
 */
export function evaluateRoleChange(
  policy: RoleApprovalPolicyRules,
  fromRole: OrganizationMemberRole | null,
  toRole: OrganizationMemberRole | null,
): RoleChangeEvaluation {
  const touched = [fromRole, toRole].filter(
    (role): role is OrganizationMemberRole => role !== null,
  );
  const approvalRequired = touched.some((role) =>
    policy.protectedRoles.includes(role),
  );
  const ownerApprovalRequired =
    approvalRequired &&
    policy.ownerChangesRequireOwnerApproval &&
    touched.includes("OWNER");

  return {
    approvalRequired,
    requiredApprovals: approvalRequired ? policy.requiredApprovals : 0,
    eligibleApproverRoles: ownerApprovalRequired
      ? policy.approverRoles.filter((role) => role === "OWNER")
      : [...policy.approverRoles],
    ownerApprovalRequired,
    approvalExpiryMinutes: policy.approvalExpiryMinutes,
    separationOfDuties: SEPARATION_OF_DUTIES,
  };
}

/** Reads a stored JSON role list defensively, dropping anything unknown. */
export function rolesFromJson(value: unknown): OrganizationMemberRole[] {
  if (!Array.isArray(value)) return [];
  return canonicalRoles(value.filter((role): role is string => typeof role === "string"));
}

function canonicalRoles(roles: readonly string[]): OrganizationMemberRole[] {
  return ORGANIZATION_ROLES.filter((role) => roles.includes(role));
}

function isOrganizationRole(role: string): role is OrganizationMemberRole {
  return (ORGANIZATION_ROLES as readonly string[]).includes(role);
}
