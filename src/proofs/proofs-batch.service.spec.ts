import { VerificationResult } from "@prisma/client";
import { VerificationEventService } from "../audit/verification-event.service";
import { ProofsService } from "./proofs.service";

const config = {
  getOrThrow: jest.fn((key: string) => {
    const values: Record<string, string> = {
      credentialSigningSecret: "test-signing-secret",
      paymentEncryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      "stellar.network": "testnet",
    };
    return values[key];
  }),
  get: jest.fn(() => undefined),
};

const verificationEventService = {
  recordEvent: jest.fn().mockResolvedValue(undefined),
  getAggregateStats: jest.fn().mockResolvedValue({}),
} as unknown as VerificationEventService;

function newService() {
  const prisma = {} as never;
  return new ProofsService(prisma, config as never, verificationEventService);
}

/** A minimal single-verify result, as verifyProof would return it. */
function single(result: VerificationResult, contractChecked = false) {
  return {
    result,
    status: "any",
    credential: { id: "x" },
    proof: {
      id: "x",
      contractStatus: contractChecked
        ? { checked: true, revoked: false, valid: true }
        : { checked: false, reason: "disabled" },
    },
  } as never;
}

describe("ProofsService.verifyProofsBatch", () => {
  it("returns one ordered result per submitted id, preserving duplicates", async () => {
    const service = newService();
    const spy = jest
      .spyOn(service, "verifyProof")
      .mockImplementation((id: string) =>
        Promise.resolve(
          id === "valid"
            ? single(VerificationResult.VALID)
            : single(VerificationResult.REVOKED),
        ),
      );

    const { results } = await service.verifyProofsBatch([
      "valid",
      "revoked",
      "valid",
    ]);

    expect(results.map((r) => r.id)).toEqual(["valid", "revoked", "valid"]);
    expect(results.map((r) => r.result)).toEqual([
      VerificationResult.VALID,
      VerificationResult.REVOKED,
      VerificationResult.VALID,
    ]);
    // "valid" appears twice but is looked up once (coalesced).
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("keeps missing, revoked, and expired states distinguishable", async () => {
    const service = newService();
    jest.spyOn(service, "verifyProof").mockImplementation((id: string) => {
      const map: Record<string, VerificationResult> = {
        missing: VerificationResult.UNKNOWN_PROOF,
        revoked: VerificationResult.REVOKED,
        expired: VerificationResult.EXPIRED,
      };
      return Promise.resolve(single(map[id]));
    });

    const { results } = await service.verifyProofsBatch([
      "missing",
      "revoked",
      "expired",
    ]);
    expect(results.map((r) => r.result)).toEqual([
      VerificationResult.UNKNOWN_PROOF,
      VerificationResult.REVOKED,
      VerificationResult.EXPIRED,
    ]);
  });

  it("falls back to an unchecked contract status for an unknown proof", async () => {
    const service = newService();
    // verifyProof returns no `proof` block for an unknown id.
    jest.spyOn(service, "verifyProof").mockResolvedValue({
      result: VerificationResult.UNKNOWN_PROOF,
      status: "unknown",
    } as never);

    const { results } = await service.verifyProofsBatch(["ghost"]);
    expect(results[0].contractStatus).toEqual({
      checked: false,
      reason: "unknown",
    });
  });

  it("reflects an unavailable anchoring dependency per item", async () => {
    const service = newService();
    jest
      .spyOn(service, "verifyProof")
      .mockResolvedValue(single(VerificationResult.VALID, false));

    const { results } = await service.verifyProofsBatch(["p1"]);
    expect(results[0].contractStatus.checked).toBe(false);
  });
});
