import { ResourceStatus } from "@prisma/client";
import {
  canAttestationAuthorizeIssuance,
  computeEffectiveAttestationStatus,
} from "./attestation-status";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const SKEW = 60_000; // 1 minute

function attestation(overrides: {
  status?: ResourceStatus;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}) {
  return {
    status: ResourceStatus.ACTIVE,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe("computeEffectiveAttestationStatus", () => {
  it("is ACTIVE when not expired, revoked, or suspended", () => {
    expect(
      computeEffectiveAttestationStatus(
        attestation({ expiresAt: new Date(NOW.getTime() + 3_600_000) }),
        NOW,
        SKEW,
      ),
    ).toBe("ACTIVE");
  });

  it("is EXPIRED once past expiry beyond the skew tolerance", () => {
    expect(
      computeEffectiveAttestationStatus(
        attestation({ expiresAt: new Date(NOW.getTime() - SKEW - 1) }),
        NOW,
        SKEW,
      ),
    ).toBe("EXPIRED");
  });

  it("treats the skew boundary deterministically (still ACTIVE at exactly expiry+skew)", () => {
    const expiresAt = new Date(NOW.getTime() - SKEW);
    expect(
      computeEffectiveAttestationStatus(attestation({ expiresAt }), NOW, SKEW),
    ).toBe("ACTIVE");
    // One millisecond past the boundary flips to EXPIRED.
    expect(
      computeEffectiveAttestationStatus(
        attestation({ expiresAt: new Date(expiresAt.getTime() - 1) }),
        NOW,
        SKEW,
      ),
    ).toBe("EXPIRED");
  });

  it("revocation wins over expiry", () => {
    expect(
      computeEffectiveAttestationStatus(
        attestation({
          revokedAt: NOW,
          expiresAt: new Date(NOW.getTime() - 10 * SKEW),
        }),
        NOW,
        SKEW,
      ),
    ).toBe("REVOKED");
    expect(
      computeEffectiveAttestationStatus(
        attestation({ status: ResourceStatus.REVOKED }),
        NOW,
        SKEW,
      ),
    ).toBe("REVOKED");
  });

  it("reports suspended and pending as-is", () => {
    expect(
      computeEffectiveAttestationStatus(
        attestation({ status: ResourceStatus.SUSPENDED }),
        NOW,
        SKEW,
      ),
    ).toBe("SUSPENDED");
    expect(
      computeEffectiveAttestationStatus(
        attestation({ status: ResourceStatus.PENDING }),
        NOW,
        SKEW,
      ),
    ).toBe("PENDING");
  });

  it("never expires an attestation with no expiry", () => {
    expect(
      computeEffectiveAttestationStatus(
        attestation({ expiresAt: null }),
        NOW,
        SKEW,
      ),
    ).toBe("ACTIVE");
  });
});

describe("canAttestationAuthorizeIssuance", () => {
  it("permits only an effectively ACTIVE attestation", () => {
    expect(
      canAttestationAuthorizeIssuance(
        attestation({ expiresAt: new Date(NOW.getTime() + SKEW) }),
        NOW,
        SKEW,
      ),
    ).toBe(true);
  });

  it("refuses an expired attestation", () => {
    expect(
      canAttestationAuthorizeIssuance(
        attestation({ expiresAt: new Date(NOW.getTime() - 2 * SKEW) }),
        NOW,
        SKEW,
      ),
    ).toBe(false);
  });

  it("refuses revoked, suspended, and pending attestations", () => {
    for (const status of [
      ResourceStatus.REVOKED,
      ResourceStatus.SUSPENDED,
      ResourceStatus.PENDING,
    ]) {
      expect(
        canAttestationAuthorizeIssuance(attestation({ status }), NOW, SKEW),
      ).toBe(false);
    }
  });
});
