import {
  DEFAULT_ROLE_APPROVAL_POLICY,
  diffRoleApprovalPolicies,
  evaluateRoleChange,
  MAX_APPROVAL_EXPIRY_MINUTES,
  MAX_REQUIRED_APPROVALS,
  MIN_APPROVAL_EXPIRY_MINUTES,
  MIN_REQUIRED_APPROVALS,
  normalizeRoleApprovalPolicy,
  RoleApprovalPolicyInput,
  rolesFromJson,
  validateRoleApprovalPolicy,
} from "./role-approval-policy.rules";

function input(overrides: Partial<RoleApprovalPolicyInput> = {}): RoleApprovalPolicyInput {
  return {
    protectedRoles: ["OWNER", "ADMIN"],
    approverRoles: ["OWNER", "ADMIN"],
    requiredApprovals: 2,
    approvalExpiryMinutes: 60,
    ownerChangesRequireOwnerApproval: true,
    ...overrides,
  };
}

const codes = (value: RoleApprovalPolicyInput) =>
  validateRoleApprovalPolicy(value).map((violation) => violation.code);

describe("role approval policy rules", () => {
  describe("platform minimums", () => {
    it("accepts a policy that meets every minimum", () => {
      expect(validateRoleApprovalPolicy(input())).toEqual([]);
    });

    it("accepts the platform default", () => {
      expect(validateRoleApprovalPolicy(DEFAULT_ROLE_APPROVAL_POLICY)).toEqual([]);
    });

    it("accepts extra protected roles (strengthening)", () => {
      expect(codes(input({ protectedRoles: ["OWNER", "ADMIN", "MEMBER", "VIEWER"] }))).toEqual([]);
    });

    it.each([
      [["ADMIN"]],
      [["OWNER"]],
      [["MEMBER"]],
      [[]],
    ])("rejects protected roles %j that drop a platform-protected role", (protectedRoles) => {
      expect(codes(input({ protectedRoles }))).toContain(
        "PROTECTED_ROLES_BELOW_PLATFORM_MINIMUM",
      );
    });

    it("rejects MEMBER or VIEWER as approvers", () => {
      expect(codes(input({ approverRoles: ["OWNER", "MEMBER"] }))).toEqual([
        "APPROVER_ROLE_NOT_PERMITTED",
      ]);
      expect(codes(input({ approverRoles: ["OWNER", "VIEWER"] }))).toEqual([
        "APPROVER_ROLE_NOT_PERMITTED",
      ]);
    });

    it("rejects an empty approver list", () => {
      expect(
        codes(input({ approverRoles: [], ownerChangesRequireOwnerApproval: false })),
      ).toEqual(["APPROVER_ROLES_EMPTY"]);
    });

    it("rejects owner-approval without OWNER as an approver role", () => {
      expect(codes(input({ approverRoles: ["ADMIN"] }))).toEqual([
        "OWNER_APPROVAL_REQUIRES_OWNER_APPROVER",
      ]);
      expect(
        codes(input({ approverRoles: ["ADMIN"], ownerChangesRequireOwnerApproval: false })),
      ).toEqual([]);
    });

    it("reports unknown roles instead of silently dropping them", () => {
      expect(codes(input({ protectedRoles: ["OWNER", "ADMIN", "ROOT"] }))).toEqual([
        "UNKNOWN_ROLE",
      ]);
    });
  });

  describe("exact boundaries", () => {
    it.each([
      [MIN_REQUIRED_APPROVALS, true],
      [MAX_REQUIRED_APPROVALS, true],
      [MIN_REQUIRED_APPROVALS - 1, false],
      [MAX_REQUIRED_APPROVALS + 1, false],
      [1.5, false],
    ])("requiredApprovals %p valid=%p", (requiredApprovals, valid) => {
      expect(codes(input({ requiredApprovals })).includes("REQUIRED_APPROVALS_OUT_OF_RANGE")).toBe(
        !valid,
      );
    });

    it.each([
      [MIN_APPROVAL_EXPIRY_MINUTES, true],
      [MAX_APPROVAL_EXPIRY_MINUTES, true],
      [MIN_APPROVAL_EXPIRY_MINUTES - 1, false],
      [MAX_APPROVAL_EXPIRY_MINUTES + 1, false],
    ])("approvalExpiryMinutes %p valid=%p", (approvalExpiryMinutes, valid) => {
      expect(
        codes(input({ approvalExpiryMinutes })).includes("APPROVAL_EXPIRY_OUT_OF_RANGE"),
      ).toBe(!valid);
    });
  });

  describe("separation of duties", () => {
    it("refuses an attempt to enable self-approval", () => {
      expect(codes(input({ selfApprovalProhibited: false }))).toEqual([
        "SELF_APPROVAL_CANNOT_BE_ENABLED",
      ]);
    });

    it("refuses an attempt to let the target approve their own change", () => {
      expect(codes(input({ targetApprovalProhibited: false }))).toEqual([
        "TARGET_APPROVAL_CANNOT_BE_ENABLED",
      ]);
    });

    it("accepts explicitly restating the invariants", () => {
      expect(
        codes(input({ selfApprovalProhibited: true, targetApprovalProhibited: true })),
      ).toEqual([]);
    });
  });

  it("reports every violation, in a deterministic order", () => {
    const bad = input({
      protectedRoles: ["MEMBER"],
      approverRoles: ["VIEWER"],
      requiredApprovals: 0,
      approvalExpiryMinutes: 0,
      selfApprovalProhibited: false,
    });

    expect(codes(bad)).toEqual([
      "PROTECTED_ROLES_BELOW_PLATFORM_MINIMUM",
      "APPROVER_ROLE_NOT_PERMITTED",
      "OWNER_APPROVAL_REQUIRES_OWNER_APPROVER",
      "REQUIRED_APPROVALS_OUT_OF_RANGE",
      "APPROVAL_EXPIRY_OUT_OF_RANGE",
      "SELF_APPROVAL_CANNOT_BE_ENABLED",
    ]);
    expect(codes(bad)).toEqual(codes(bad));
  });

  it("normalizes role order and never stores the separation-of-duty flags", () => {
    const normalized = normalizeRoleApprovalPolicy(
      input({ protectedRoles: ["MEMBER", "ADMIN", "OWNER"], selfApprovalProhibited: true }),
    );

    expect(normalized.protectedRoles).toEqual(["OWNER", "ADMIN", "MEMBER"]);
    expect(normalized).not.toHaveProperty("selfApprovalProhibited");
  });

  it("diffs field by field and reports nothing for an identical policy", () => {
    const current = normalizeRoleApprovalPolicy(input());
    expect(diffRoleApprovalPolicies(current, current)).toEqual([]);
    expect(
      diffRoleApprovalPolicies(current, { ...current, requiredApprovals: 3 }),
    ).toEqual([{ field: "requiredApprovals", from: 2, to: 3 }]);
  });

  describe("evaluateRoleChange", () => {
    const policy = normalizeRoleApprovalPolicy(input());

    it("requires approval when a protected role is granted", () => {
      expect(evaluateRoleChange(policy, "MEMBER", "ADMIN")).toMatchObject({
        approvalRequired: true,
        requiredApprovals: 2,
        ownerApprovalRequired: false,
        eligibleApproverRoles: ["OWNER", "ADMIN"],
      });
    });

    it("requires approval when a protected role is removed", () => {
      expect(evaluateRoleChange(policy, "ADMIN", null).approvalRequired).toBe(true);
    });

    it("does not require approval between unprotected roles", () => {
      expect(evaluateRoleChange(policy, "VIEWER", "MEMBER")).toMatchObject({
        approvalRequired: false,
        requiredApprovals: 0,
      });
    });

    it("restricts approvers to OWNER for OWNER changes when configured", () => {
      expect(evaluateRoleChange(policy, "ADMIN", "OWNER")).toMatchObject({
        ownerApprovalRequired: true,
        eligibleApproverRoles: ["OWNER"],
      });
    });

    it("always reports the separation-of-duty invariants", () => {
      expect(evaluateRoleChange(policy, null, "VIEWER").separationOfDuties).toEqual({
        selfApprovalProhibited: true,
        targetApprovalProhibited: true,
        distinctApproversRequired: true,
      });
    });
  });

  it("reads stored role JSON defensively", () => {
    expect(rolesFromJson(["ADMIN", "OWNER", "ROOT", 7])).toEqual(["OWNER", "ADMIN"]);
    expect(rolesFromJson("OWNER")).toEqual([]);
  });
});
