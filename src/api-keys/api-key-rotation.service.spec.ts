import { ConflictException, NotFoundException } from "@nestjs/common";
import { ApiKeyRotationStatus, ApiKeyScope, ResourceStatus } from "@prisma/client";
import { ApiKeyRotationService } from "./api-key-rotation.service";
import { ROTATION_REVOCATION_REASONS } from "./api-key-rotation.types";

describe("ApiKeyRotationService", () => {
  let service: ApiKeyRotationService;
  let mockPrisma: any;
  let mockQuotas: any;
  let mockReceiptService: any;
  let fixedNow: Date;

  const orgId = "org_123";
  const oldKeyId = "key_old_1";
  const newKeyId = "key_new_2";
  const familyId = "fam_abc_1";
  const actorId = "user_admin_999";

  beforeEach(() => {
    fixedNow = new Date("2026-10-21T12:00:00.000Z");

    mockPrisma = {
      $transaction: jest.fn(async (cb) => cb(mockPrisma)),
      $queryRaw: jest.fn().mockResolvedValue([{ now: fixedNow }]),
      apiKey: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: oldKeyId }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      apiKeyRotation: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      apiKeyCutoverReceipt: {
        create: jest.fn(),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: "audit_1" }),
      },
    };

    mockQuotas = {
      assertCapacity: jest.fn().mockResolvedValue(undefined),
    };

    mockReceiptService = {
      create: jest.fn().mockResolvedValue({ id: "receipt_mock_123" }),
    };

    const mockClock = {
      now: () => fixedNow,
    };

    service = new ApiKeyRotationService(
      mockPrisma,
      mockQuotas,
      mockReceiptService,
      mockClock as any,
    );
  });

  describe("calculateScopeIntersection", () => {
    it("returns common scopes between old and replacement keys", () => {
      const oldScopes = [ApiKeyScope.PROOF_VERIFY, ApiKeyScope.PAYMENT_READ, ApiKeyScope.PROOF_READ];
      const newScopes = [ApiKeyScope.PROOF_VERIFY, ApiKeyScope.PAYMENT_READ, ApiKeyScope.PAYMENT_WRITE];

      const result = service.calculateScopeIntersection(oldScopes, newScopes);
      expect(result).toEqual([ApiKeyScope.PROOF_VERIFY, ApiKeyScope.PAYMENT_READ]);
    });

    it("returns empty array if no scopes overlap", () => {
      const oldScopes = [ApiKeyScope.PROOF_VERIFY];
      const newScopes = [ApiKeyScope.PAYMENT_WRITE];

      const result = service.calculateScopeIntersection(oldScopes, newScopes);
      expect(result).toEqual([]);
    });
  });

  describe("evaluateScopeIntersection & boundary deadlines", () => {
    const overlapExpiresAt = new Date("2026-10-21T13:00:00.000Z");

    it("allows old key within scope intersection when now < overlapExpiresAt", async () => {
      fixedNow = new Date("2026-10-21T12:30:00.000Z"); // Before deadline
      mockPrisma.apiKeyRotation.findFirst.mockResolvedValueOnce({
        id: "rot_1",
        familyId,
        oldKeyId,
        newKeyId,
        status: ApiKeyRotationStatus.IN_OVERLAP,
        overlapExpiresAt,
        newKey: {
          scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }, { scope: ApiKeyScope.PAYMENT_WRITE }],
        },
      });

      const oldScopes = [ApiKeyScope.PROOF_VERIFY, ApiKeyScope.PAYMENT_READ];
      const evaluation = await service.evaluateScopeIntersection(oldKeyId, oldScopes, orgId);

      expect(evaluation.allowed).toBe(true);
      expect(evaluation.effectiveScopes).toEqual([ApiKeyScope.PROOF_VERIFY]);
      expect(evaluation.isOldKeyInOverlap).toBe(true);
    });

    it("rejects old key at exact expiration boundary (now === overlapExpiresAt)", async () => {
      fixedNow = new Date("2026-10-21T13:00:00.000Z"); // Exactly at deadline
      mockPrisma.apiKeyRotation.findFirst.mockResolvedValueOnce({
        id: "rot_1",
        familyId,
        oldKeyId,
        newKeyId,
        status: ApiKeyRotationStatus.IN_OVERLAP,
        overlapExpiresAt,
        newKey: {
          scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }],
        },
      });

      const oldScopes = [ApiKeyScope.PROOF_VERIFY];
      const evaluation = await service.evaluateScopeIntersection(oldKeyId, oldScopes, orgId);

      expect(evaluation.allowed).toBe(false);
      expect(evaluation.reason).toContain("Rotation overlap deadline expired");
      expect(mockPrisma.apiKeyRotation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "rot_1" },
          data: { status: ApiKeyRotationStatus.EXPIRED },
        }),
      );
    });

    it("rejects old key after expiration deadline (now > overlapExpiresAt)", async () => {
      fixedNow = new Date("2026-10-21T13:00:01.000Z"); // 1s past deadline
      mockPrisma.apiKeyRotation.findFirst.mockResolvedValueOnce({
        id: "rot_1",
        familyId,
        oldKeyId,
        newKeyId,
        status: ApiKeyRotationStatus.IN_OVERLAP,
        overlapExpiresAt,
        newKey: {
          scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }],
        },
      });

      const oldScopes = [ApiKeyScope.PROOF_VERIFY];
      const evaluation = await service.evaluateScopeIntersection(oldKeyId, oldScopes, orgId);

      expect(evaluation.allowed).toBe(false);
    });

    it("restricts replacement key to scope intersection during active overlap", async () => {
      fixedNow = new Date("2026-10-21T12:30:00.000Z");
      mockPrisma.apiKeyRotation.findFirst
        .mockResolvedValueOnce(null) // oldKeyId query
        .mockResolvedValueOnce({
          id: "rot_1",
          familyId,
          oldKeyId,
          newKeyId,
          status: ApiKeyRotationStatus.IN_OVERLAP,
          overlapExpiresAt,
          oldKey: {
            scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }],
          },
        }); // newKeyId query

      const replacementScopes = [ApiKeyScope.PROOF_VERIFY, ApiKeyScope.PAYMENT_READ];
      const evaluation = await service.evaluateScopeIntersection(newKeyId, replacementScopes, orgId);

      expect(evaluation.allowed).toBe(true);
      expect(evaluation.effectiveScopes).toEqual([ApiKeyScope.PROOF_VERIFY]);
      expect(evaluation.isOldKeyInOverlap).toBe(false);
    });

    it("gives replacement key its full requested scopes once cutover is complete", async () => {
      fixedNow = new Date("2026-10-21T12:30:00.000Z");
      mockPrisma.apiKeyRotation.findFirst
        .mockResolvedValueOnce(null) // oldKeyId query
        .mockResolvedValueOnce({
          id: "rot_1",
          familyId,
          oldKeyId,
          newKeyId,
          status: ApiKeyRotationStatus.CUTOVER,
          overlapExpiresAt,
          oldKey: {
            scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }],
          },
        }); // newKeyId query

      const replacementScopes = [ApiKeyScope.PROOF_VERIFY, ApiKeyScope.PAYMENT_READ];
      const evaluation = await service.evaluateScopeIntersection(newKeyId, replacementScopes, orgId);

      expect(evaluation.allowed).toBe(true);
      expect(evaluation.effectiveScopes).toEqual([ApiKeyScope.PROOF_VERIFY, ApiKeyScope.PAYMENT_READ]);
    });
  });

  describe("old-key usage attribution", () => {
    it("increments oldKeyUsageCount and records lastOldKeyUsedAt", async () => {
      await service.recordOldKeyUsage(oldKeyId);

      expect(mockPrisma.apiKeyRotation.updateMany).toHaveBeenCalledWith({
        where: {
          oldKeyId,
          status: ApiKeyRotationStatus.IN_OVERLAP,
          overlapExpiresAt: { gt: fixedNow },
        },
        data: {
          oldKeyUsageCount: { increment: 1 },
          lastOldKeyUsedAt: fixedNow,
        },
      });
    });
  });

  describe("earlyCutover", () => {
    const overlapExpiresAt = new Date("2026-10-21T13:00:00.000Z");

    it("terminates overlap, revokes old key, updates rotation status, and produces immutable receipt", async () => {
      const rotationRow = {
        id: "rot_1",
        organizationId: orgId,
        familyId,
        oldKeyId,
        newKeyId,
        status: ApiKeyRotationStatus.IN_OVERLAP,
        overlapExpiresAt,
        oldKeyUsageCount: 7,
        oldKey: {
          id: oldKeyId,
          prefix: "oldpref1",
          scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }],
        },
        newKey: {
          id: newKeyId,
          prefix: "newpref2",
          scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }, { scope: ApiKeyScope.PAYMENT_READ }],
        },
      };

      mockPrisma.apiKeyRotation.findFirst.mockResolvedValueOnce(rotationRow);
      mockPrisma.apiKeyRotation.update.mockResolvedValueOnce({
        ...rotationRow,
        status: ApiKeyRotationStatus.CUTOVER,
        cutoverAt: fixedNow,
        cutoverById: actorId,
      });

      mockPrisma.apiKeyCutoverReceipt.create.mockImplementationOnce(async ({ data }: any) => ({
        id: "receipt_cutover_1",
        ...data,
      }));

      const result = await service.earlyCutover(oldKeyId, orgId, actorId);

      // Verify old key was retired/revoked
      expect(mockPrisma.apiKey.update).toHaveBeenCalledWith({
        where: { id: oldKeyId },
        data: {
          status: ResourceStatus.REVOKED,
          revokedAt: fixedNow,
        },
      });

      // Verify rotation updated to CUTOVER
      expect(mockPrisma.apiKeyRotation.update).toHaveBeenCalledWith({
        where: { id: "rot_1" },
        data: {
          status: ApiKeyRotationStatus.CUTOVER,
          cutoverAt: fixedNow,
          cutoverById: actorId,
        },
      });

      // Verify cutover receipt created with canonical hash and audit redaction
      expect(mockPrisma.apiKeyCutoverReceipt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          rotationId: "rot_1",
          familyId,
          oldKeyId,
          newKeyId,
          cutoverType: "EARLY_MANUAL",
          initiatedById: actorId,
          receiptHash: expect.any(String),
        }),
      });

      // Verify audit log created
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "api_key.cutover",
          resourceType: "api_key",
          resourceId: oldKeyId,
          metadata: expect.objectContaining({
            receiptId: "receipt_cutover_1",
            familyId,
            organizationId: orgId,
          }),
        }),
      });

      expect(result.rotation.status).toBe(ApiKeyRotationStatus.CUTOVER);
      expect(result.cutoverReceipt.receiptHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it("rejects cutover if already cut over with 409 Conflict", async () => {
      mockPrisma.apiKeyRotation.findFirst
        .mockResolvedValueOnce(null) // No IN_OVERLAP rotation
        .mockResolvedValueOnce({
          // Found CUTOVER rotation with receipt
          id: "rot_1",
          status: ApiKeyRotationStatus.CUTOVER,
          cutoverReceipt: { id: "rec_1" },
        });

      await expect(service.earlyCutover(oldKeyId, orgId, actorId)).rejects.toThrow(
        ConflictException,
      );
    });

    it("rejects cutover if no rotation exists with 404 NotFound", async () => {
      mockPrisma.apiKeyRotation.findFirst.mockResolvedValue(null);

      await expect(service.earlyCutover("unknown_key", orgId, actorId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("family revocation semantics", () => {
    it("compromise reason revokes BOTH old and replacement keys", async () => {
      mockPrisma.apiKeyRotation.findFirst.mockResolvedValueOnce({
        id: "rot_1",
        familyId,
        oldKeyId,
        newKeyId,
        status: ApiKeyRotationStatus.IN_OVERLAP,
        oldKey: { prefix: "old1", scopeAssignments: [] },
        newKey: { prefix: "new1", scopeAssignments: [] },
      });

      const result = await service.handleFamilyRevocation(
        oldKeyId,
        orgId,
        actorId,
        ROTATION_REVOCATION_REASONS.COMPROMISE,
      );

      expect(result.wasFamilyRevocation).toBe(true);
      expect(result.affectedKeyIds).toContain(oldKeyId);
      expect(result.affectedKeyIds).toContain(newKeyId);

      // Both keys marked revoked
      expect(mockPrisma.apiKey.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [oldKeyId, newKeyId] }, organizationId: orgId },
        data: { status: ResourceStatus.REVOKED, revokedAt: fixedNow },
      });

      // Rotation marked REVOKED
      expect(mockPrisma.apiKeyRotation.update).toHaveBeenCalledWith({
        where: { id: "rot_1" },
        data: {
          status: ApiKeyRotationStatus.REVOKED,
        },
      });
    });

    it("revoking old key with normal reason triggers cutover", async () => {
      mockPrisma.apiKeyRotation.findFirst.mockResolvedValueOnce({
        id: "rot_1",
        familyId,
        oldKeyId,
        newKeyId,
        status: ApiKeyRotationStatus.IN_OVERLAP,
        oldKeyUsageCount: 2,
        oldKey: { prefix: "old1", scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }] },
        newKey: { prefix: "new1", scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }] },
      });

      mockPrisma.apiKeyCutoverReceipt.create.mockResolvedValueOnce({
        id: "receipt_1",
        receiptHash: "sha256:abc",
      });

      const result = await service.handleFamilyRevocation(
        oldKeyId,
        orgId,
        actorId,
        "standard maintenance",
      );

      expect(result.wasFamilyRevocation).toBe(true);
      expect(mockPrisma.apiKey.update).toHaveBeenCalledWith({
        where: { id: oldKeyId },
        data: { status: ResourceStatus.REVOKED, revokedAt: fixedNow },
      });
      expect(mockPrisma.apiKeyRotation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "rot_1" },
          data: expect.objectContaining({ status: ApiKeyRotationStatus.CUTOVER }),
        }),
      );
    });

    it("revoking replacement key with normal reason aborts rotation and keeps old key active", async () => {
      mockPrisma.apiKeyRotation.findFirst.mockResolvedValueOnce({
        id: "rot_1",
        familyId,
        oldKeyId,
        newKeyId,
        status: ApiKeyRotationStatus.IN_OVERLAP,
        oldKey: { prefix: "old1", scopeAssignments: [] },
        newKey: { prefix: "new1", scopeAssignments: [] },
      });

      const result = await service.handleFamilyRevocation(
        newKeyId,
        orgId,
        actorId,
        ROTATION_REVOCATION_REASONS.ROTATION_ABORTED,
      );

      expect(result.wasFamilyRevocation).toBe(true);
      expect(result.affectedKeyIds).toEqual([newKeyId]);

      // Only replacement key revoked
      expect(mockPrisma.apiKey.update).toHaveBeenCalledWith({
        where: { id: newKeyId },
        data: { status: ResourceStatus.REVOKED, revokedAt: fixedNow },
      });

      // Rotation marked REVOKED
      expect(mockPrisma.apiKeyRotation.update).toHaveBeenCalledWith({
        where: { id: "rot_1" },
        data: { status: ApiKeyRotationStatus.REVOKED },
      });
    });
  });

  describe("inspectRotation", () => {
    it("returns comprehensive rotation family metadata and effective scopes", async () => {
      const overlapExpiresAt = new Date("2026-10-21T13:00:00.000Z");
      fixedNow = new Date("2026-10-21T12:15:00.000Z");

      mockPrisma.apiKeyRotation.findFirst.mockResolvedValueOnce({
        id: "rot_1",
        familyId,
        oldKeyId,
        newKeyId,
        status: ApiKeyRotationStatus.IN_OVERLAP,
        overlapExpiresAt,
        oldKeyUsageCount: 42,
        lastOldKeyUsedAt: fixedNow,
        oldKey: {
          id: oldKeyId,
          prefix: "oldpref1",
          name: "Old Key",
          status: ResourceStatus.ACTIVE,
          scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }, { scope: ApiKeyScope.PAYMENT_READ }],
          createdAt: new Date("2026-10-01"),
          lastUsedAt: fixedNow,
        },
        newKey: {
          id: newKeyId,
          prefix: "newpref2",
          name: "New Key",
          status: ResourceStatus.ACTIVE,
          scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }],
          createdAt: new Date("2026-10-21"),
          lastUsedAt: null,
        },
        cutoverReceipt: null,
      });

      const inspect = await service.inspectRotation(oldKeyId, orgId);

      expect(inspect.familyId).toBe(familyId);
      expect(inspect.status).toBe(ApiKeyRotationStatus.IN_OVERLAP);
      expect(inspect.isOverlapExpired).toBe(false);
      expect(inspect.effectiveScopes).toEqual([ApiKeyScope.PROOF_VERIFY]);
      expect(inspect.oldKeyUsage.totalRequests).toBe(42);
      expect(inspect.oldKey.id).toBe(oldKeyId);
      expect(inspect.replacementKey.id).toBe(newKeyId);
    });
  });
});
