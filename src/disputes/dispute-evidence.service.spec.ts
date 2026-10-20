/**
 * Unit tests for DisputeEvidenceService
 *
 * Coverage:
 *  - Positive: openDispute, submitManifest, listManifests, resolve, reject.
 *  - Negative: proof not found, dispute not found, empty reason, empty algorithms.
 *  - Terminal state: RESOLVED/REJECTED disputes reject new manifests.
 *  - Replay detection: duplicate manifestHash throws.
 *  - Authorization: assertDisputeAccess — owner vs admin vs stranger.
 *  - Contract reconciliation: recordContractConfirmation happy/conflict paths.
 *  - Boundary: storageRef URI is hashed, raw URI never stored.
 *  - Determinism: same inputs → same manifestHash.
 *  - Static helpers: buildManifestHash, hashStorageUri.
 */

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { DisputeEvidenceService, MANIFEST_VERSION } from "./dispute-evidence.service";

// ─── Mock factories ──────────────────────────────────────────────────────────

const PROOF_ID = "proof-001";
const DISPUTE_ID = "dispute-001";
const MANIFEST_ID = "manifest-001";

function makeDispute(overrides: Record<string, unknown> = {}) {
  return {
    id: DISPUTE_ID,
    proofId: PROOF_ID,
    status: "OPEN",
    reason: "incorrect-payment",
    openerHash: "sha256:opener",
    resolvedAt: null,
    resolution: null,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    _count: { manifests: 0 },
    proof: { userId: "user-001" },
    ...overrides,
  };
}

function makeManifest(overrides: Record<string, unknown> = {}) {
  return {
    id: MANIFEST_ID,
    disputeId: DISPUTE_ID,
    version: MANIFEST_VERSION,
    manifestHash: "sha256:abc123",
    submitterRole: "PROOF_OWNER",
    submitterHash: "sha256:submitter",
    algorithms: ["sha256"],
    storageRefs: [{ label: "evidence", refHash: "sha256:ref" }],
    contractTransactionHash: null,
    contractConfirmedAt: null,
    createdAt: new Date("2025-01-01"),
    ...overrides,
  };
}

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    proof: {
      findUnique: jest.fn().mockResolvedValue(
        "proof" in overrides ? (overrides.proof as unknown) : { id: PROOF_ID, status: "ACTIVE" },
      ),
    },
    proofDispute: {
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...makeDispute(), ...data }),
      ),
      findUnique: jest.fn().mockResolvedValue(
        "dispute" in overrides ? (overrides.dispute as unknown) : makeDispute(),
      ),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...makeDispute(), ...data }),
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
    disputeEvidenceManifest: {
      findUnique: jest.fn().mockResolvedValue(
        "manifest" in overrides ? (overrides.manifest as unknown) : null,
      ),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...makeManifest(), ...data }),
      ),
      findMany: jest.fn().mockResolvedValue(
        "manifests" in overrides ? (overrides.manifests as unknown) : [makeManifest()],
      ),
      update: jest.fn().mockResolvedValue(makeManifest()),
    },
  };
}

// ─── openDispute ─────────────────────────────────────────────────────────────

describe("DisputeEvidenceService — openDispute", () => {
  it("creates a dispute and returns result", async () => {
    const prisma = makePrisma();
    const svc = new DisputeEvidenceService(prisma as never);
    const result = await svc.openDispute({
      proofId: PROOF_ID,
      reason: "incorrect-payment",
      openerWalletHash: "sha256:wallet",
    });
    expect(result.proofId).toBe(PROOF_ID);
    expect(result.status).toBe("OPEN");
    expect(prisma.proofDispute.create).toHaveBeenCalledTimes(1);
  });

  it("throws NotFoundException when proof not found", async () => {
    const prisma = makePrisma({ proof: null });
    const svc = new DisputeEvidenceService(prisma as never);
    await expect(
      svc.openDispute({ proofId: "missing", reason: "x", openerWalletHash: "h" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("throws BadRequestException when reason is empty", async () => {
    const prisma = makePrisma();
    const svc = new DisputeEvidenceService(prisma as never);
    await expect(
      svc.openDispute({ proofId: PROOF_ID, reason: "   ", openerWalletHash: "h" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("stores openerHash as double-hash, not raw wallet", async () => {
    const prisma = makePrisma();
    const svc = new DisputeEvidenceService(prisma as never);
    await svc.openDispute({ proofId: PROOF_ID, reason: "r", openerWalletHash: "GRAWWALLET" });
    const callData = prisma.proofDispute.create.mock.calls[0][0].data;
    expect(callData.openerHash).not.toBe("GRAWWALLET");
    expect(callData.openerHash).toMatch(/^sha256:/);
  });
});

// ─── submitManifest ──────────────────────────────────────────────────────────

describe("DisputeEvidenceService — submitManifest", () => {
  it("creates a manifest and returns result", async () => {
    const prisma = makePrisma();
    const svc = new DisputeEvidenceService(prisma as never);
    const result = await svc.submitManifest({
      disputeId: DISPUTE_ID,
      submitterRole: "PROOF_OWNER",
      submitterWalletHash: "sha256:wallet",
      algorithms: ["sha256"],
      storageRefs: [{ label: "evidence", uri: "https://example.invalid/e1" }],
    });
    expect(result.disputeId).toBe(DISPUTE_ID);
    expect(result.manifestHash).toMatch(/^sha256:/);
  });

  it("hashes storage URIs — raw URIs never stored", async () => {
    const prisma = makePrisma();
    const svc = new DisputeEvidenceService(prisma as never);
    const rawUri = "https://example.invalid/raw-evidence";
    await svc.submitManifest({
      disputeId: DISPUTE_ID,
      submitterRole: "PROOF_OWNER",
      submitterWalletHash: "sha256:w",
      algorithms: ["sha256"],
      storageRefs: [{ label: "doc", uri: rawUri }],
    });
    const callData = prisma.disputeEvidenceManifest.create.mock.calls[0][0].data;
    const refs = callData.storageRefs as { label: string; refHash: string }[];
    expect(refs[0].refHash).not.toContain(rawUri);
    expect(refs[0].refHash).toMatch(/^sha256:/);
  });

  it("throws NotFoundException when dispute not found", async () => {
    const prisma = makePrisma({ dispute: null });
    const svc = new DisputeEvidenceService(prisma as never);
    await expect(
      svc.submitManifest({
        disputeId: "missing",
        submitterRole: "PROOF_OWNER",
        submitterWalletHash: "h",
        algorithms: ["sha256"],
        storageRefs: [],
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it("throws BadRequestException for empty algorithms", async () => {
    const prisma = makePrisma();
    const svc = new DisputeEvidenceService(prisma as never);
    await expect(
      svc.submitManifest({
        disputeId: DISPUTE_ID,
        submitterRole: "PROOF_OWNER",
        submitterWalletHash: "h",
        algorithms: [],
        storageRefs: [],
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

// ─── Terminal state ──────────────────────────────────────────────────────────

describe("DisputeEvidenceService — terminal state", () => {
  it.each(["RESOLVED", "REJECTED"])(
    "rejects new manifests when dispute is %s",
    async (status) => {
      const prisma = makePrisma({ dispute: makeDispute({ status }) });
      const svc = new DisputeEvidenceService(prisma as never);
      await expect(
        svc.submitManifest({
          disputeId: DISPUTE_ID,
          submitterRole: "PROOF_OWNER",
          submitterWalletHash: "h",
          algorithms: ["sha256"],
          storageRefs: [],
        }),
      ).rejects.toThrow(BadRequestException);
    },
  );

  it.each(["RESOLVED", "REJECTED"])(
    "cannot resolve a dispute already in terminal state %s",
    async (status) => {
      const prisma = makePrisma({ dispute: makeDispute({ status }) });
      const svc = new DisputeEvidenceService(prisma as never);
      await expect(
        svc.resolveDispute(
          { disputeId: DISPUTE_ID, resolution: "ok", adminWalletHash: "admin" },
          "RESOLVED",
        ),
      ).rejects.toThrow(BadRequestException);
    },
  );
});

// ─── Replay detection ────────────────────────────────────────────────────────

describe("DisputeEvidenceService — replay detection", () => {
  it("throws BadRequestException when manifestHash already exists", async () => {
    const prisma = makePrisma({
      manifest: makeManifest({ id: "existing-001" }),
    });
    const svc = new DisputeEvidenceService(prisma as never);
    await expect(
      svc.submitManifest({
        disputeId: DISPUTE_ID,
        submitterRole: "PROOF_OWNER",
        submitterWalletHash: "h",
        algorithms: ["sha256"],
        storageRefs: [],
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

// ─── Authorization ────────────────────────────────────────────────────────────

describe("DisputeEvidenceService — authorization", () => {
  it("allows ADMIN to access any dispute", async () => {
    const prisma = makePrisma({ dispute: makeDispute() });
    const svc = new DisputeEvidenceService(prisma as never);
    await expect(
      svc.assertDisputeAccess(DISPUTE_ID, "other-user", "ADMIN"),
    ).resolves.not.toThrow();
  });

  it("allows proof owner to access their dispute", async () => {
    const prisma = makePrisma({ dispute: makeDispute() });
    const svc = new DisputeEvidenceService(prisma as never);
    await expect(
      svc.assertDisputeAccess(DISPUTE_ID, "user-001", "WORKER"),
    ).resolves.not.toThrow();
  });

  it("throws ForbiddenException for non-owner non-admin", async () => {
    const prisma = makePrisma({ dispute: makeDispute() });
    const svc = new DisputeEvidenceService(prisma as never);
    await expect(
      svc.assertDisputeAccess(DISPUTE_ID, "stranger", "WORKER"),
    ).rejects.toThrow(ForbiddenException);
  });
});

// ─── Contract reconciliation ─────────────────────────────────────────────────

describe("DisputeEvidenceService — contract reconciliation", () => {
  it("records contract confirmation successfully", async () => {
    const prisma = makePrisma({
      manifest: makeManifest({ contractTransactionHash: null }),
    });
    const svc = new DisputeEvidenceService(prisma as never);
    await expect(
      svc.recordContractConfirmation(MANIFEST_ID, "txhash123", new Date()),
    ).resolves.not.toThrow();
    expect(prisma.disputeEvidenceManifest.update).toHaveBeenCalled();
  });

  it("throws BadRequestException when hash conflicts with existing", async () => {
    const prisma = makePrisma({
      manifest: makeManifest({ contractTransactionHash: "different-tx" }),
    });
    const svc = new DisputeEvidenceService(prisma as never);
    await expect(
      svc.recordContractConfirmation(MANIFEST_ID, "new-tx", new Date()),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws NotFoundException when manifest not found", async () => {
    const prisma = makePrisma({ manifest: null });
    const svc = new DisputeEvidenceService(prisma as never);
    await expect(
      svc.recordContractConfirmation("bad-id", "tx", new Date()),
    ).rejects.toThrow(NotFoundException);
  });
});

// ─── Determinism ─────────────────────────────────────────────────────────────

describe("DisputeEvidenceService — determinism", () => {
  it("buildManifestHash produces identical hash for identical inputs", () => {
    const body = {
      version: MANIFEST_VERSION,
      disputeId: "d1",
      submitterRole: "PROOF_OWNER",
      submitterHash: "sha256:h",
      algorithms: ["sha256"],
      storageRefs: [{ label: "doc", refHash: "sha256:r" }],
      contractTransactionHash: null,
    };
    const h1 = DisputeEvidenceService.buildManifestHash(body);
    const h2 = DisputeEvidenceService.buildManifestHash(body);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("hashStorageUri produces sha256: prefixed hash", () => {
    const h = DisputeEvidenceService.hashStorageUri("https://example.invalid/e");
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("different storage URIs produce different hashes", () => {
    const h1 = DisputeEvidenceService.hashStorageUri("https://example.invalid/a");
    const h2 = DisputeEvidenceService.hashStorageUri("https://example.invalid/b");
    expect(h1).not.toBe(h2);
  });
});

// ─── listManifests ────────────────────────────────────────────────────────────

describe("DisputeEvidenceService — listManifests", () => {
  it("returns manifests for a dispute", async () => {
    const prisma = makePrisma({ manifests: [makeManifest()] });
    const svc = new DisputeEvidenceService(prisma as never);
    const results = await svc.listManifests(DISPUTE_ID);
    expect(results).toHaveLength(1);
    expect(results[0].disputeId).toBe(DISPUTE_ID);
  });

  it("throws NotFoundException when dispute not found", async () => {
    const prisma = makePrisma({ dispute: null });
    const svc = new DisputeEvidenceService(prisma as never);
    await expect(svc.listManifests("missing")).rejects.toThrow(NotFoundException);
  });
});
