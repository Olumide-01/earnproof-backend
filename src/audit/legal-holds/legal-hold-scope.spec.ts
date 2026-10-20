import { AuditLegalHoldStatus } from "@prisma/client";
import {
  auditLogHoldExclusion,
  holdsInEffectWhere,
  isAuditRecordHeld,
  isHoldInEffect,
  HoldCoverage,
} from "./legal-hold-scope";

const NOW = new Date("2026-10-17T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

function timing(status: AuditLegalHoldStatus, approvalOffset: number, expiryOffset: number) {
  return { status, approvalDeadline: at(approvalOffset), expiresAt: at(expiryOffset) };
}

describe("legal hold scope", () => {
  describe("isHoldInEffect", () => {
    it.each<[AuditLegalHoldStatus, boolean]>([
      ["PENDING_APPROVAL", true],
      ["ACTIVE", true],
      ["RELEASE_PENDING", true],
      ["RELEASED", false],
      ["REJECTED", false],
    ])("%s in effect = %p before every deadline", (status, expected) => {
      expect(isHoldInEffect(timing(status, 1_000, 2_000), NOW)).toBe(expected);
    });

    it("stops protecting exactly at expiresAt (exclusive)", () => {
      expect(isHoldInEffect(timing("ACTIVE", 0, 1), NOW)).toBe(true);
      expect(isHoldInEffect(timing("ACTIVE", 0, 0), NOW)).toBe(false);
    });

    it("lapses a pending hold exactly at its approval deadline", () => {
      expect(isHoldInEffect(timing("PENDING_APPROVAL", 1, 5_000), NOW)).toBe(true);
      expect(isHoldInEffect(timing("PENDING_APPROVAL", 0, 5_000), NOW)).toBe(false);
    });

    it("ignores the approval deadline once approved", () => {
      expect(isHoldInEffect(timing("ACTIVE", -5_000, 5_000), NOW)).toBe(true);
    });
  });

  it("builds the same rule as a Prisma filter", () => {
    expect(holdsInEffectWhere(NOW)).toEqual({
      expiresAt: { gt: NOW },
      OR: [
        { status: { in: ["ACTIVE", "RELEASE_PENDING"] } },
        { status: "PENDING_APPROVAL", approvalDeadline: { gt: NOW } },
      ],
    });
  });

  describe("coverage", () => {
    const orgHold: HoldCoverage = {
      scope: "ORGANIZATION",
      organizationId: "org-a",
      rangeStart: at(-10_000),
      rangeEnd: at(-5_000),
    };
    const platformHold: HoldCoverage = { ...orgHold, scope: "PLATFORM", organizationId: null };

    it("covers both range bounds inclusively", () => {
      for (const offset of [-10_000, -7_500, -5_000]) {
        expect(isAuditRecordHeld({ organizationId: "org-a", createdAt: at(offset) }, [orgHold])).toBe(true);
      }
      for (const offset of [-10_001, -4_999]) {
        expect(isAuditRecordHeld({ organizationId: "org-a", createdAt: at(offset) }, [orgHold])).toBe(false);
      }
    });

    it("limits an organization hold to that organization", () => {
      const createdAt = at(-7_500);
      expect(isAuditRecordHeld({ organizationId: "org-b", createdAt }, [orgHold])).toBe(false);
      expect(isAuditRecordHeld({ organizationId: null, createdAt }, [orgHold])).toBe(false);
    });

    it("extends a platform hold to every organization and SYSTEM records", () => {
      const createdAt = at(-7_500);
      expect(isAuditRecordHeld({ organizationId: "org-b", createdAt }, [platformHold])).toBe(true);
      expect(isAuditRecordHeld({ organizationId: null, createdAt }, [platformHold])).toBe(true);
    });

    it("leaves the query unchanged when there are no holds", () => {
      expect(auditLogHoldExclusion([])).toEqual({});
    });

    it("excludes each hold, guarding the organization match against NULL", () => {
      expect(auditLogHoldExclusion([orgHold, platformHold])).toEqual({
        NOT: [
          {
            organizationId: { equals: "org-a", not: null },
            createdAt: { gte: orgHold.rangeStart, lte: orgHold.rangeEnd },
          },
          { createdAt: { gte: orgHold.rangeStart, lte: orgHold.rangeEnd } },
        ],
      });
    });
  });
});
