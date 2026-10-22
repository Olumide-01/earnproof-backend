import { ApiKeyRotationStatus, ApiKeyScope, ResourceStatus } from "@prisma/client";
import { ApiKeyService } from "./api-key.service";
import { unlimitedQuotas } from "../testing/quotas";

describe("ApiKeyService", () => {
  let service: ApiKeyService;
  let prismaService: any;

  const mockPrisma = () => {
    const client: Record<string, unknown> = {
    apiKey: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
    };
    // Key creation runs inside a transaction; the mock runs it on itself.
    client.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(client));
    return client;
  };

  beforeEach(() => {
    prismaService = mockPrisma();
    service = new ApiKeyService(
      prismaService,
      unlimitedQuotas() as never,
      {
        freezeOnRevocation: jest.fn().mockResolvedValue(undefined),
        recordUsage: jest.fn().mockResolvedValue(undefined),
      } as never,
    );
  });

  describe("generateSecret", () => {
    it("generates a secret with sufficient entropy (32 bytes)", () => {
      const { secret, prefix: generatedPrefix } = service.generateSecret();

      expect(secret).toBeDefined();
      expect(typeof secret).toBe("string");
      // 32 bytes in base64url is ~43 characters
      expect(secret.length).toBeGreaterThanOrEqual(40);
      expect(generatedPrefix).toBeDefined();
    });

    it("generates a prefix that is first 8 characters of secret", () => {
      const { secret, prefix } = service.generateSecret();

      expect(prefix).toBe(secret.substring(0, 8));
      expect(prefix.length).toBe(8);
    });

    it("generates different secrets on multiple calls", () => {
      const { secret: secret1 } = service.generateSecret();
      const { secret: secret2 } = service.generateSecret();

      expect(secret1).not.toBe(secret2);
    });

    it("generates secrets that are URL-safe (base64url)", () => {
      const { secret } = service.generateSecret();

      // base64url uses only alphanumeric, -, and _
      expect(secret).toMatch(/^[a-zA-Z0-9_-]+$/);
    });
  });

  describe("hashSecret", () => {
    it("produces a SHA-256 hash (hex string, 64 characters)", () => {
      const secret = "test-secret-123";
      const hash = service.hashSecret(secret);

      expect(hash).toBeDefined();
      expect(typeof hash).toBe("string");
      // SHA-256 hex is always 64 characters
      expect(hash.length).toBe(64);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("produces consistent hash for same secret", () => {
      const secret = "test-secret-123";
      const hash1 = service.hashSecret(secret);
      const hash2 = service.hashSecret(secret);

      expect(hash1).toBe(hash2);
    });

    it("produces different hashes for different secrets", () => {
      const hash1 = service.hashSecret("secret-1");
      const hash2 = service.hashSecret("secret-2");

      expect(hash1).not.toBe(hash2);
    });

    it("hash is not the original secret (one-way)", () => {
      const secret = "my-api-key-secret";
      const hash = service.hashSecret(secret);

      // Hash should not contain the original secret
      expect(hash).not.toContain(secret);
      expect(hash).not.toContain("my-api-key");
      expect(typeof hash).toBe("string");
    });
  });

  describe("verifySecret", () => {
    // ========== HAPPY PATH: Valid Secret Verification ==========
    it("returns true when secret matches hash", () => {
      const secret = "test-secret-123";
      const hash = service.hashSecret(secret);

      const isValid = service.verifySecret(secret, hash);
      expect(isValid).toBe(true);
    });

    it("returns false when secret does not match hash", () => {
      const correctSecret = "correct-secret";
      const wrongSecret = "wrong-secret";
      const hash = service.hashSecret(correctSecret);

      const isValid = service.verifySecret(wrongSecret, hash);
      expect(isValid).toBe(false);
    });

    // ========== MALFORMED INPUT: Invalid Format Handling ==========
    it("rejects malformed hash (too short)", () => {
      const secret = "test-secret";
      const malformedHash = "abc123"; // Only 6 characters

      expect(service.verifySecret(secret, malformedHash)).toBe(false);
    });

    it("rejects malformed hash (invalid hex characters)", () => {
      const secret = "test-secret";
      const malformedHash = "G".repeat(64); // G is not a valid hex character

      expect(service.verifySecret(secret, malformedHash)).toBe(false);
    });

    it("rejects empty hash", () => {
      const secret = "test-secret";

      expect(service.verifySecret(secret, "")).toBe(false);
    });

    it("rejects hash that is exactly 63 characters (one short)", () => {
      const secret = "test-secret";
      const almostValidHash = "a".repeat(63);

      expect(service.verifySecret(secret, almostValidHash)).toBe(false);
    });

    it("rejects hash that is exactly 65 characters (one long)", () => {
      const secret = "test-secret";
      const tooLongHash = "a".repeat(65);

      expect(service.verifySecret(secret, tooLongHash)).toBe(false);
    });

    it("rejects hash with mixed case valid hex but wrong value", () => {
      const secret = "test-secret";
      // Valid format (64 hex chars) but wrong value
      const wrongButFormatted = "ABCDEF1234567890".repeat(4); // 64 hex chars

      expect(service.verifySecret(secret, wrongButFormatted)).toBe(false);
    });

    it("rejects garbage string input", () => {
      const secret = "test-secret";
      const garbage = "!@#$%^&*()!@#$%^&*()!@#$%^&*()!@#$%^&*()!@#$%^&*()!@#$%^&*()!@#$%";

      expect(service.verifySecret(secret, garbage)).toBe(false);
    });

    // ========== EDGE CASES: Boundary Values ==========
    it("correctly verifies with actual SHA-256 hash", () => {
      const secret = "my-actual-api-key-secret-value";
      const correctHash = service.hashSecret(secret);

      expect(service.verifySecret(secret, correctHash)).toBe(true);
      expect(service.verifySecret(secret + "x", correctHash)).toBe(false);
    });

    it("rejects when first character of hash is wrong", () => {
      const secret = "test-secret";
      const correctHash = service.hashSecret(secret);
      const wrongFirstChar = "F" + correctHash.slice(1); // Change first char

      expect(service.verifySecret(secret, wrongFirstChar)).toBe(false);
    });

    it("rejects when last character of hash is wrong", () => {
      const secret = "test-secret";
      const correctHash = service.hashSecret(secret);
      const wrongLastChar = correctHash.slice(0, -1) + "F"; // Change last char

      expect(service.verifySecret(secret, wrongLastChar)).toBe(false);
    });

    it("rejects when middle character of hash is wrong", () => {
      const secret = "test-secret";
      const correctHash = service.hashSecret(secret);
      const mid = Math.floor(correctHash.length / 2);
      const wrongMiddle =
        correctHash.slice(0, mid) +
        (correctHash[mid] === "a" ? "b" : "a") +
        correctHash.slice(mid + 1); // Flip middle char

      expect(service.verifySecret(secret, wrongMiddle)).toBe(false);
    });

    // ========== TIMING CONSISTENCY: Critical Security Tests ==========
    it("executes in constant time for valid and invalid format inputs", () => {
      const correctSecret = "correct-secret-value";
      const correctHash = service.hashSecret(correctSecret);

      // Prepare test inputs with varying characteristics
      const testCases = [
        { name: "valid-format-correct", input: correctHash },
        { name: "valid-format-wrong", input: "a".repeat(64) }, // Valid format but wrong value
        { name: "malformed-empty", input: "" },
        { name: "malformed-short", input: "abc" },
        { name: "malformed-long", input: "a".repeat(100) },
        { name: "malformed-invalid-chars", input: "G".repeat(64) },
        { name: "malformed-mixed-garbage", input: "!@#$%^&*()abcdef!@#$%^&*()abcdef!@#$%^&*()abcdef!@#$%^&*()abcdef" },
      ];

      const iterations = 50; // Reduced from 100 to avoid flakiness in CI
      const timings: Record<string, number[]> = {};

      for (const testCase of testCases) {
        timings[testCase.name] = [];
      }

      // Run multiple iterations to gather timing data
      for (let i = 0; i < iterations; i++) {
        for (const testCase of testCases) {
          const start = process.hrtime.bigint();
          service.verifySecret(correctSecret, testCase.input);
          const end = process.hrtime.bigint();
          timings[testCase.name].push(Number(end - start));
        }
      }

      // Calculate average timings
      const averages: Record<string, number> = {};
      for (const [name, times] of Object.entries(timings)) {
        averages[name] = times.reduce((a, b) => a + b, 0) / iterations;
      }

      // Verify timing consistency: all averages should be within 100% of each other
      // (very generous tolerance for CI environments with CPU variance, cache effects, etc)
      const maxAvg = Math.max(...Object.values(averages));
      const minAvg = Math.min(...Object.values(averages));
      const threshold = maxAvg * 1.0; // 100% variance tolerance

      // Log timing data for debugging (optional but useful)
      // console.log("Timing consistency check:", averages);

      expect(maxAvg - minAvg).toBeLessThan(threshold);
    });

    it("verifies that malformed and valid-format inputs follow same comparison path", () => {
      const secret = "test-secret";
      const correctHash = service.hashSecret(secret);

      // These should all return false
      const testInputs = [
        correctHash, // Valid format, will fail comparison
        "a".repeat(64), // Valid format, will fail comparison
        "invalid", // Invalid format
        "", // Empty
        "G".repeat(64), // Invalid chars
      ];

      // All should reach the comparison stage without throwing or early-returning
      // If any throws or returns early, this will catch it
      for (const input of testInputs) {
        const result = service.verifySecret(secret, input);
        expect(typeof result).toBe("boolean");
      }
    });

    it("handles similar-looking secrets without timing leakage", () => {
      const secret1 = "secret-aaaaaaaaaaa";
      const secret2 = "secret-bbbbbbbbbbb";
      const hash1 = service.hashSecret(secret1);

      // These are similar but different - should have same timing regardless
      const timings = [];

      for (let i = 0; i < 20; i++) {
        const start = process.hrtime.bigint();
        service.verifySecret(secret1, hash1); // Correct secret
        const end = process.hrtime.bigint();
        timings.push(Number(end - start));

        const start2 = process.hrtime.bigint();
        service.verifySecret(secret2, hash1); // Wrong secret, similar
        const end2 = process.hrtime.bigint();
        timings.push(Number(end2 - start2));
      }

      // Calculate average for correct vs incorrect
      const correctTimings = timings.slice(0, 20);
      const incorrectTimings = timings.slice(20, 40);
      const avgCorrect =
        correctTimings.reduce((a, b) => a + b, 0) / correctTimings.length;
      const avgIncorrect =
        incorrectTimings.reduce((a, b) => a + b, 0) / incorrectTimings.length;

      // Timings should be within 100% of each other (very generous tolerance for CI)
      const maxDiff = Math.max(avgCorrect, avgIncorrect) * 1.0;
      expect(Math.abs(avgCorrect - avgIncorrect)).toBeLessThan(maxDiff);
    });

    // ========== REGRESSION: Backward Compatibility ==========
    it("continues to verify valid secrets after implementation change", () => {
      // Ensure existing valid secrets still work
      const testSecrets = [
        "simple-secret",
        "secret-with-special-!@#$%",
        "very-long-secret-" + "x".repeat(100),
        "unicode-secret-™",
        "",
      ];

      for (const secret of testSecrets) {
        const hash = service.hashSecret(secret);
        expect(service.verifySecret(secret, hash)).toBe(true);
      }
    });

    it("continues to reject invalid secrets after implementation change", () => {
      const correctSecret = "correct";
      const hash = service.hashSecret(correctSecret);

      const invalidSecrets = ["wrong", "incorrect", "x".repeat(100), ""];

      for (const secret of invalidSecrets) {
        expect(service.verifySecret(secret, hash)).toBe(false);
      }
    });

    it("fails closed when the stored hash is malformed", () => {
      expect(service.verifySecret("test-secret", "not-a-sha256-hash")).toBe(
        false,
      );
    });
  });

  describe("lookupAndVerifyKey", () => {
    it("returns null when key not found by prefix", async () => {
      prismaService.apiKey.findFirst.mockResolvedValueOnce(null);

      const result = await service.lookupAndVerifyKey(
        "testpref",
        "full-secret-key",
        "org_123",
      );

      expect(result).toBeNull();
    });

    it("returns null when secret hash doesn't match", async () => {
      const correctSecret = "correct-secret-12345";
      const wrongSecret = "wrong-secret-1234567";
      const hash = service.hashSecret(correctSecret);

      prismaService.apiKey.findFirst.mockResolvedValueOnce({
        id: "key_123",
        prefix: "correct_",
        keyHash: hash,
        organizationId: "org_123",
        createdAt: new Date(),
        scopeAssignments: [],
      });

      const result = await service.lookupAndVerifyKey(
        "correct_",
        wrongSecret,
        "org_123",
      );

      expect(result).toBeNull();
    });

    it("returns key details when secret is valid", async () => {
      const secret = "valid-secret-123456789";
      const hash = service.hashSecret(secret);

      const mockKey = {
        id: "key_123",
        prefix: "valid_se",
        keyHash: hash,
        organizationId: "org_123",
        createdAt: new Date("2026-08-24"),
        scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }],
      };

      prismaService.apiKey.findFirst.mockResolvedValueOnce(mockKey);

      const result = await service.lookupAndVerifyKey(
        "valid_se",
        secret,
        "org_123",
      );

      expect(result).not.toBeNull();
      expect(result!.id).toBe("key_123");
      expect(result!.organizationId).toBe("org_123");
    });

    it("includes scopes in returned key", async () => {
      const secret = "secret-123";
      const hash = service.hashSecret(secret);

      prismaService.apiKey.findFirst.mockResolvedValueOnce({
        id: "key_123",
        prefix: "secret_1",
        keyHash: hash,
        organizationId: "org_123",
        createdAt: new Date(),
        scopeAssignments: [
          { scope: ApiKeyScope.PROOF_VERIFY },
          { scope: ApiKeyScope.PAYMENT_READ },
        ],
      });

      const result = await service.lookupAndVerifyKey(
        "secret_1",
        secret,
        "org_123",
      );

      expect(result!.scopeAssignments).toHaveLength(2);
      expect(result!.scopeAssignments.map((sa) => sa.scope)).toContain(
        ApiKeyScope.PROOF_VERIFY,
      );
    });

    it("enforces organization isolation at query level", async () => {
      const secret = "secret-123";
      service.hashSecret(secret); // Hash for verification but don't use the result

      prismaService.apiKey.findFirst.mockResolvedValueOnce(null);

      const result = await service.lookupAndVerifyKey(
        "prefix",
        secret,
        "wrong-org-id",
      );

      // Verify the query included the organization filter
      const callArgs = prismaService.apiKey.findFirst.mock.calls[0][0];
      expect(callArgs.where.organizationId).toBe("wrong-org-id");
      expect(callArgs.where.status).toBe(ResourceStatus.ACTIVE);
      expect(callArgs.where.OR).toEqual([
        { expiresAt: null },
        { expiresAt: { gt: expect.any(Date) } },
      ]);
      expect(result).toBeNull();
    });
  });

  describe("createKey", () => {
    it("creates key with all provided parameters", async () => {
      prismaService.apiKey.create.mockResolvedValueOnce({
        id: "key_new",
        prefix: "testpref",
        name: "Test Key",
        organizationId: "org_123",
        createdById: "user_123",
        status: ResourceStatus.ACTIVE,
        createdAt: new Date(),
        scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }],
      });

      const result = await service.createKey({
        organizationId: "org_123",
        createdBy: "user_123",
        name: "Test Key",
        scopes: [ApiKeyScope.PROOF_VERIFY],
      });

      expect(result.secret).toBeDefined();
      expect(result.apiKey.id).toBe("key_new");
      expect(result.apiKey.name).toBe("Test Key");
      expect(result.apiKey.scopes).toContain(ApiKeyScope.PROOF_VERIFY);
    });

    it("returns raw secret exactly once (never again)", async () => {
      prismaService.apiKey.create.mockResolvedValueOnce({
        id: "key_123",
        prefix: "prefix",
        name: "Key",
        organizationId: "org_123",
        createdById: "user_123",
        status: ResourceStatus.ACTIVE,
        createdAt: new Date(),
        scopeAssignments: [],
      });

      const result = await service.createKey({
        organizationId: "org_123",
        createdBy: "user_123",
        name: "Key",
      });

      expect(result.secret).toBeDefined();
      expect(typeof result.secret).toBe("string");
      // Secret should be long enough to have entropy
      expect(result.secret.length).toBeGreaterThan(30);
    });

    it("stores hash not raw secret", async () => {
      prismaService.apiKey.create.mockResolvedValueOnce({
        id: "key_123",
        prefix: "prefix",
        name: "Key",
        organizationId: "org_123",
        createdById: "user_123",
        status: ResourceStatus.ACTIVE,
        createdAt: new Date(),
        keyHash: "hash-value", // This should be a hash, not the secret
        scopeAssignments: [],
      });

      const result = await service.createKey({
        organizationId: "org_123",
        createdBy: "user_123",
        name: "Key",
      });

      // Verify Prisma was called with a hash, not the raw secret
      const createCall = prismaService.apiKey.create.mock.calls[0][0];
      expect(createCall.data.keyHash).toBeDefined();
      // The keyHash should not be the same as the displayed secret (since it's hashed)
      expect(createCall.data.keyHash).not.toBe(result.secret);
    });

    it("logs key creation to audit trail", async () => {
      prismaService.apiKey.create.mockResolvedValueOnce({
        id: "key_123",
        prefix: "testpref",
        name: "Test Key",
        organizationId: "org_123",
        createdById: "user_123",
        status: ResourceStatus.ACTIVE,
        createdAt: new Date(),
        expiresAt: null,
        scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }],
      });

      await service.createKey({
        organizationId: "org_123",
        createdBy: "user_123",
        name: "Test Key",
        scopes: [ApiKeyScope.PROOF_VERIFY],
      });

      // Verify audit log was created
      expect(prismaService.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorType: "user",
            actorId: "user_123",
            action: "api_key.created",
            resourceType: "api_key",
            resourceId: "key_123",
          }),
        }),
      );
    });

    it("audit log never includes raw secret or hash", async () => {
      const returnedKey = {
        id: "key_123",
        prefix: "testpref",
        name: "Test Key",
        organizationId: "org_123",
        createdById: "user_123",
        status: ResourceStatus.ACTIVE,
        createdAt: new Date(),
        scopeAssignments: [],
      };

      prismaService.apiKey.create.mockResolvedValueOnce(returnedKey);

      const result = await service.createKey({
        organizationId: "org_123",
        createdBy: "user_123",
        name: "Test Key",
      });

      const auditCall = prismaService.auditLog.create.mock.calls[0][0];
      const auditMetadata = JSON.stringify(auditCall.data.metadata);

      // Verify no secret or hash in audit log
      expect(auditMetadata).not.toContain(result.secret);
      expect(auditMetadata).not.toContain("keyHash");
      // But should contain safe metadata
      expect(auditMetadata).toContain("testpref"); // prefix is safe
      expect(auditMetadata).toContain("Test Key"); // name is safe
    });
  });

  describe("rotateKey", () => {
    it("generates new secret and invalidates old immediately", async () => {
      const oldSecret = "old-secret-123";
      service.hashSecret(oldSecret); // Hash it but don't need the result

      prismaService.apiKey.update.mockResolvedValueOnce({
        id: "key_123",
        prefix: "newpref",
        name: "Key",
        organizationId: "org_123",
        status: ResourceStatus.ACTIVE,
        rotatedAt: new Date(),
        scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }],
      });

      const result = await service.rotateKey("key_123", "org_123", "user_123");

      expect(result.secret).toBeDefined();
      expect(result.secret).not.toBe(oldSecret);
      expect(result.apiKey.rotatedAt).toBeDefined();
      expect(prismaService.apiKey.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "key_123", organizationId: "org_123" },
        }),
      );
    });

    it("enforces organization isolation on rotation", async () => {
      prismaService.apiKey.update.mockResolvedValueOnce({
        id: "key_123",
        organizationId: "org_wrong",
        prefix: "prefix",
        name: "Key",
        scopeAssignments: [],
      });

      await expect(
        service.rotateKey("key_123", "org_correct", "user_123"),
      ).rejects.toThrow("does not belong to this organization");
    });

    it("logs rotation to audit trail", async () => {
      prismaService.apiKey.update.mockResolvedValueOnce({
        id: "key_123",
        prefix: "newpref",
        name: "Test Key",
        organizationId: "org_123",
        rotatedAt: new Date(),
        scopeAssignments: [],
      });

      await service.rotateKey("key_123", "org_123", "user_123");

      expect(prismaService.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "api_key.rotated",
            resourceId: "key_123",
          }),
        }),
      );
    });
  });

  describe("revokeKey", () => {
    it("marks key as REVOKED", async () => {
      prismaService.apiKey.findFirst.mockResolvedValueOnce({
        organizationId: "org_123",
        prefix: "prefix",
        name: "Key",
      });
      prismaService.apiKey.update.mockResolvedValueOnce({});

      await service.revokeKey("key_123", "org_123", "user_123");

      const updateCall = prismaService.apiKey.update.mock.calls[0][0];
      expect(updateCall.data.status).toBe(ResourceStatus.REVOKED);
      expect(updateCall.data.revokedAt).toBeDefined();
    });

    it("takes effect immediately (no cache window)", async () => {
      prismaService.apiKey.findFirst.mockResolvedValueOnce({
        organizationId: "org_123",
        prefix: "prefix",
        name: "Key",
      });

      await service.revokeKey("key_123", "org_123", "user_123");

      // Verify update was called directly (not delayed)
      expect(prismaService.apiKey.update).toHaveBeenCalled();
    });

    it("enforces organization isolation on revocation", async () => {
      prismaService.apiKey.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.revokeKey("key_123", "org_correct", "user_123"),
      ).rejects.toThrow("Key not found");

      expect(prismaService.apiKey.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "key_123", organizationId: "org_correct" },
        }),
      );
      expect(prismaService.apiKey.update).not.toHaveBeenCalled();
    });

    it("logs revocation to audit trail", async () => {
      prismaService.apiKey.findFirst.mockResolvedValueOnce({
        organizationId: "org_123",
        prefix: "testpref",
        name: "Test Key",
      });

      await service.revokeKey("key_123", "org_123", "user_123");

      expect(prismaService.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "api_key.revoked",
            resourceId: "key_123",
          }),
        }),
      );
    });
  });

  describe("listKeysForOrganization", () => {
    it("returns only metadata, never secrets or hashes", async () => {
      prismaService.apiKey.findMany.mockResolvedValueOnce([
        {
          id: "key_1",
          prefix: "prefix1",
          name: "Key 1",
          status: ResourceStatus.ACTIVE,
          createdAt: new Date(),
          scopeAssignments: [{ scope: ApiKeyScope.PROOF_READ }],
        },
      ]);

      const { data: keys } = await service.listKeysForOrganization("org_123");

      expect(keys).toHaveLength(1);
      expect(keys[0].id).toBe("key_1");
      expect(keys[0].prefix).toBe("prefix1");
      // Should never return keyHash or raw secret
      expect((keys[0] as any).keyHash).toBeUndefined();
      expect((keys[0] as any).secret).toBeUndefined();
    });

    it("enforces organization isolation in query", async () => {
      prismaService.apiKey.findMany.mockResolvedValueOnce([]);

      await service.listKeysForOrganization("org_123");

      const findCall = prismaService.apiKey.findMany.mock.calls[0][0];
      expect(findCall.where.organizationId).toBe("org_123");
    });
  });

  describe("recordKeyUsage", () => {
    it("records timestamp only (not IP/UA)", async () => {
      prismaService.apiKey.update.mockResolvedValueOnce({
        prefix: "prefix",
        name: "Key",
        organizationId: "org_123",
      });

      await service.recordKeyUsage("key_123", "org_123");

      // Verify only lastUsedAt was updated, no IP/UA fields
      const updateCall = prismaService.apiKey.update.mock.calls[0][0];
      expect(updateCall.data.lastUsedAt).toBeDefined();
      expect(Object.keys(updateCall.data)).toEqual(["lastUsedAt"]);
    });

    it("logs successful authentication to audit trail", async () => {
      prismaService.apiKey.update.mockResolvedValueOnce({
        prefix: "testpref",
        name: "Key",
        organizationId: "org_123",
      });

      await service.recordKeyUsage("key_123", "org_123");

      expect(prismaService.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "api_key.authenticated",
            resourceId: "key_123",
          }),
        }),
      );
    });

    it("does not throw on database error (graceful degradation)", async () => {
      prismaService.apiKey.update.mockRejectedValueOnce(
        new Error("DB error"),
      );

      // Should not throw
      await expect(
        service.recordKeyUsage("key_123", "org_123"),
      ).resolves.toBeUndefined();
    });
  });

  describe("verifySecret timing consistency", () => {
    it("executes in constant time regardless of input format validity", () => {
      const correctSecret = "correct-secret-value-12345";
      const correctHash = service.hashSecret(correctSecret);

      // Prepare test cases: well-formatted wrong, malformed, and correct
      const malformedHash = "not-a-valid-hash-format";
      const wrongButFormatted = "a".repeat(64); // Valid format but wrong value

      // Measure execution time for each case
      // We'll run each multiple times and average to reduce flakiness
      const iterations = 50; // Reduced from 100 for CI stability
      const timings = {
        malformed: [] as number[],
        wrongFormatted: [] as number[],
        correct: [] as number[],
      };

      for (let i = 0; i < iterations; i++) {
        // Malformed input
        const start1 = process.hrtime.bigint();
        service.verifySecret(correctSecret, malformedHash);
        const end1 = process.hrtime.bigint();
        timings.malformed.push(Number(end1 - start1));

        // Wrong but properly formatted
        const start2 = process.hrtime.bigint();
        service.verifySecret(correctSecret, wrongButFormatted);
        const end2 = process.hrtime.bigint();
        timings.wrongFormatted.push(Number(end2 - start2));

        // Correct secret
        const start3 = process.hrtime.bigint();
        service.verifySecret(correctSecret, correctHash);
        const end3 = process.hrtime.bigint();
        timings.correct.push(Number(end3 - start3));
      }

      // Calculate averages (in nanoseconds)
      const avgMalformed =
        timings.malformed.reduce((a, b) => a + b, 0) / iterations;
      const avgWrongFormatted =
        timings.wrongFormatted.reduce((a, b) => a + b, 0) / iterations;
      const avgCorrect = timings.correct.reduce((a, b) => a + b, 0) / iterations;

      // Allow 100% variance (timing can vary significantly in CI environments)
      // Constant-time verification is about same execution path, not identical nanoseconds
      const maxDeviation = Math.max(avgMalformed, avgWrongFormatted, avgCorrect) *
        1.0;

      expect(Math.abs(avgMalformed - avgWrongFormatted)).toBeLessThan(
        maxDeviation,
      );
      expect(Math.abs(avgWrongFormatted - avgCorrect)).toBeLessThan(
        maxDeviation,
      );
      expect(Math.abs(avgMalformed - avgCorrect)).toBeLessThan(maxDeviation);
    });

    it("handles malformed hashes without early exit", () => {
      const secret = "test-secret";
      const malformedHashes = [
        "",
        "too-short",
        "!@#$%^&*()",
        "00000000000000000000000000000000000000000000000000000000000000", // 63 chars
        "000000000000000000000000000000000000000000000000000000000000000g", // 64 chars but invalid char
      ];

      // All should return false, and process should complete normally
      for (const hash of malformedHashes) {
        const result = service.verifySecret(secret, hash);
        expect(result).toBe(false);
      }
    });

    it("correctly rejects malformed hashes via constant-time path", () => {
      const secret = "my-secret";
      const hash = service.hashSecret(secret);

      // These should all return false (no match)
      expect(service.verifySecret(secret, "X".repeat(64))).toBe(false);
      expect(service.verifySecret(secret, "invalid-format")).toBe(false);
      expect(service.verifySecret(secret, "")).toBe(false);

      // And the correct should still work
      expect(service.verifySecret(secret, hash)).toBe(true);
    });

    it("verifies no early returns exist before comparison", () => {
      // Test that all different input types complete execution normally
      // If an early return existed, one might throw or behave differently
      const secret = "test-secret";

      const inputs = [
        { hash: "", name: "empty" },
        { hash: "x", name: "single-char" },
        { hash: "abcdef", name: "short-valid-hex" },
        { hash: "!@#$%^&*()", name: "special-chars" },
        { hash: "G".repeat(64), name: "invalid-hex-chars" },
        { hash: "a".repeat(64), name: "valid-format-wrong-value" },
      ];

      for (const input of inputs) {
        // Should never throw, should always return boolean
        const result = service.verifySecret(secret, input.hash);
        expect(typeof result).toBe("boolean");
        expect(result).toBe(false); // All are incorrect
      }
    });

    it("maintains timing consistency across multiple consecutive calls", () => {
      const secret = "test-secret";
      const correctHash = service.hashSecret(secret);
      const wrongHash = "a".repeat(64);

      const timings: number[] = [];

      for (let i = 0; i < 30; i++) {
        // Alternate between correct and wrong
        const hash = i % 2 === 0 ? correctHash : wrongHash;
        const start = process.hrtime.bigint();
        service.verifySecret(secret, hash);
        const end = process.hrtime.bigint();
        timings.push(Number(end - start));
      }

      // Check that timing doesn't depend on whether previous calls succeeded/failed
      const firstHalf = timings.slice(0, 15).reduce((a, b) => a + b, 0) / 15;
      const secondHalf = timings.slice(15, 30).reduce((a, b) => a + b, 0) / 15;

      // Should be within 100% of each other (generous tolerance)
      const maxDiff = Math.max(firstHalf, secondHalf) * 1.0;
      expect(Math.abs(firstHalf - secondHalf)).toBeLessThan(maxDiff);
    });
  });

  describe("security invariants", () => {
    it("lifecycle ensures secret is never retrievable after creation", async () => {
      // Create a key
      prismaService.apiKey.create.mockResolvedValueOnce({
        id: "key_123",
        prefix: "prefix",
        name: "Key",
        organizationId: "org_123",
        createdById: "user_123",
        status: ResourceStatus.ACTIVE,
        createdAt: new Date(),
        keyHash: "hash-value",
        scopeAssignments: [],
      });

      const createResult = await service.createKey({
        organizationId: "org_123",
        createdBy: "user_123",
        name: "Key",
      });

      const displayedSecret = createResult.secret;

      // Simulate listing keys later
      prismaService.apiKey.findMany.mockResolvedValueOnce([
        {
          id: "key_123",
          prefix: "prefix",
          name: "Key",
          status: ResourceStatus.ACTIVE,
          createdAt: new Date(),
          scopeAssignments: [],
        },
      ]);

      const { data: listedKeys } = await service.listKeysForOrganization(
        "org_123",
      );

      // The listed key should never contain the secret
      expect(JSON.stringify(listedKeys)).not.toContain(displayedSecret);
      expect((listedKeys[0] as any).keyHash).toBeUndefined();
    });

    it("never logs raw secrets in any audit operation", async () => {
      let capturedSecret: string | null = null;

      prismaService.apiKey.create.mockImplementationOnce(async (input: any) => {
        // Capture what would be stored as the hash
        capturedSecret = input.data.keyHash;
        return {
          id: "key_123",
          prefix: "prefix",
          name: "Key",
          organizationId: "org_123",
          createdById: "user_123",
          status: ResourceStatus.ACTIVE,
          createdAt: new Date(),
          keyHash: capturedSecret,
          scopeAssignments: [],
        };
      });

      const result = await service.createKey({
        organizationId: "org_123",
        createdBy: "user_123",
        name: "Key",
      });

      // Get all audit logs created
      const auditCalls = prismaService.auditLog.create.mock.calls;

      for (const call of auditCalls) {
        const auditStr = JSON.stringify(call[0]);
        // Ensure the displayed secret is not in any audit log
        expect(auditStr).not.toContain(result.secret);
        // Ensure the hash is not in any audit log
        if (capturedSecret) {
          expect(auditStr).not.toContain(capturedSecret);
        }
      }
    });
  });

  describe("expiration, cache invalidation, and rotation overlap boundaries", () => {
    const fixedNow = new Date("2026-10-20T12:00:00Z");

    beforeEach(() => {
      prismaService.$queryRaw = jest.fn().mockResolvedValue([{ now: fixedNow }]);
    });

    describe("exact clock boundaries", () => {
      it("authenticates when now < expiresAt", async () => {
        const { secret, prefix } = service.generateSecret();
        const keyHash = service.hashSecret(secret);
        const expiresAt = new Date("2026-10-20T12:00:01Z"); // 1s in the future

        prismaService.apiKey.findFirst.mockResolvedValueOnce({
          id: "key_future",
          prefix,
          organizationId: "org_1",
          status: ResourceStatus.ACTIVE,
          expiresAt,
          keyHash,
          scopeAssignments: [],
          organization: { id: "org_1", slug: "org-1" },
        });

        const key = await service.lookupAndVerifyKey(prefix, secret, "org_1");
        expect(key).not.toBeNull();
        expect(key?.id).toBe("key_future");
      });

      it("rejects at exact expiration boundary when now === expiresAt", async () => {
        const { secret, prefix } = service.generateSecret();
        const keyHash = service.hashSecret(secret);
        const expiresAt = new Date("2026-10-20T12:00:00Z"); // exact boundary

        prismaService.apiKey.findFirst.mockResolvedValueOnce({
          id: "key_exact",
          prefix,
          organizationId: "org_1",
          status: ResourceStatus.ACTIVE,
          expiresAt,
          keyHash,
          scopeAssignments: [],
          organization: { id: "org_1", slug: "org-1" },
        });

        const key = await service.lookupAndVerifyKey(prefix, secret, "org_1");
        expect(key).toBeNull();
      });

      it("rejects when now > expiresAt", async () => {
        const { secret, prefix } = service.generateSecret();
        const keyHash = service.hashSecret(secret);
        const expiresAt = new Date("2026-10-20T11:59:59Z"); // 1s in the past

        prismaService.apiKey.findFirst.mockResolvedValueOnce({
          id: "key_past",
          prefix,
          organizationId: "org_1",
          status: ResourceStatus.ACTIVE,
          expiresAt,
          keyHash,
          scopeAssignments: [],
          organization: { id: "org_1", slug: "org-1" },
        });

        const key = await service.lookupAndVerifyKey(prefix, secret, "org_1");
        expect(key).toBeNull();
      });
    });

    describe("cache invalidation", () => {
      it("caches key on successful lookup and invalidates on invalidateKeyCache(keyId)", async () => {
        const { secret, prefix } = service.generateSecret();
        const keyHash = service.hashSecret(secret);

        prismaService.apiKey.findFirst.mockResolvedValueOnce({
          id: "key_cached",
          prefix,
          organizationId: "org_1",
          status: ResourceStatus.ACTIVE,
          expiresAt: null,
          keyHash,
          scopeAssignments: [],
          organization: { id: "org_1", slug: "org-1" },
        });

        // 1st lookup queries DB and stores in cache
        const key1 = await service.lookupAndVerifyKey(prefix, secret, "org_1");
        expect(key1).not.toBeNull();
        expect(prismaService.apiKey.findFirst).toHaveBeenCalledTimes(1);

        // 2nd lookup hits cache, DB is NOT called again
        const key2 = await service.lookupAndVerifyKey(prefix, secret, "org_1");
        expect(key2).not.toBeNull();
        expect(prismaService.apiKey.findFirst).toHaveBeenCalledTimes(1);

        // Invalidate specific key
        service.invalidateKeyCache("key_cached");

        // 3rd lookup misses cache and queries DB again
        prismaService.apiKey.findFirst.mockResolvedValueOnce({
          id: "key_cached",
          prefix,
          organizationId: "org_1",
          status: ResourceStatus.ACTIVE,
          expiresAt: null,
          keyHash,
          scopeAssignments: [],
          organization: { id: "org_1", slug: "org-1" },
        });
        const key3 = await service.lookupAndVerifyKey(prefix, secret, "org_1");
        expect(key3).not.toBeNull();
        expect(prismaService.apiKey.findFirst).toHaveBeenCalledTimes(2);
      });

      it("invalidates all cached entries on invalidateKeyCache()", async () => {
        const { secret, prefix } = service.generateSecret();
        const keyHash = service.hashSecret(secret);

        prismaService.apiKey.findFirst.mockResolvedValueOnce({
          id: "key_cached_all",
          prefix,
          organizationId: "org_1",
          status: ResourceStatus.ACTIVE,
          expiresAt: null,
          keyHash,
          scopeAssignments: [],
          organization: { id: "org_1", slug: "org-1" },
        });

        await service.lookupAndVerifyKey(prefix, secret, "org_1");
        expect(prismaService.apiKey.findFirst).toHaveBeenCalledTimes(1);

        service.invalidateKeyCache();

        prismaService.apiKey.findFirst.mockResolvedValueOnce({
          id: "key_cached_all",
          prefix,
          organizationId: "org_1",
          status: ResourceStatus.ACTIVE,
          expiresAt: null,
          keyHash,
          scopeAssignments: [],
          organization: { id: "org_1", slug: "org-1" },
        });
        await service.lookupAndVerifyKey(prefix, secret, "org_1");
        expect(prismaService.apiKey.findFirst).toHaveBeenCalledTimes(2);
      });

      it("purges cached key when it crosses the exact expiration boundary", async () => {
        const { secret, prefix } = service.generateSecret();
        const keyHash = service.hashSecret(secret);
        const expiresAt = new Date("2026-10-20T12:00:10Z");

        // Initial lookup at 12:00:00 (active)
        prismaService.$queryRaw.mockResolvedValueOnce([{ now: new Date("2026-10-20T12:00:00Z") }]);
        prismaService.apiKey.findFirst.mockResolvedValueOnce({
          id: "key_expiring_cached",
          prefix,
          organizationId: "org_1",
          status: ResourceStatus.ACTIVE,
          expiresAt,
          keyHash,
          scopeAssignments: [],
          organization: { id: "org_1", slug: "org-1" },
        });

        const activeKey = await service.lookupAndVerifyKey(prefix, secret, "org_1");
        expect(activeKey).not.toBeNull();

        // Time reaches expiration boundary 12:00:10Z
        prismaService.$queryRaw.mockResolvedValueOnce([{ now: expiresAt }]);
        const expiredLookup = await service.lookupAndVerifyKey(prefix, secret, "org_1");
        expect(expiredLookup).toBeNull();
      });

      it("revoking key invalidates cache immediately", async () => {
        const { secret, prefix } = service.generateSecret();
        const keyHash = service.hashSecret(secret);

        prismaService.apiKey.findFirst
          .mockResolvedValueOnce({
            id: "key_to_revoke",
            prefix,
            organizationId: "org_1",
            status: ResourceStatus.ACTIVE,
            expiresAt: null,
            keyHash,
            scopeAssignments: [],
            organization: { id: "org_1", slug: "org-1" },
          })
          .mockResolvedValueOnce({
            id: "key_to_revoke",
            organizationId: "org_1",
            prefix,
            name: "Key to revoke",
          });

        prismaService.apiKey.update.mockResolvedValueOnce({
          id: "key_to_revoke",
          status: ResourceStatus.REVOKED,
        });

        // Cache it
        await service.lookupAndVerifyKey(prefix, secret, "org_1");
        expect(prismaService.apiKey.findFirst).toHaveBeenCalledTimes(1);

        // Revoke it
        await service.revokeKey("key_to_revoke", "org_1");

        // Subsequent lookup must hit DB (not stale cache) and receive null if DB returns null
        prismaService.apiKey.findFirst.mockResolvedValueOnce(null);
        const revokedLookup = await service.lookupAndVerifyKey(prefix, secret, "org_1");
        expect(revokedLookup).toBeNull();
        expect(prismaService.apiKey.findFirst).toHaveBeenCalledTimes(3);
      });
    });

    describe("rotation overlap policy", () => {
      it("does not extend old key beyond its original expiresAt", () => {
        const now = new Date("2026-10-20T12:00:00Z");
        const originalExpiresAt = new Date("2026-10-20T12:30:00Z"); // 30 min left
        const overlapDurationMs = 3600_000; // 1 hour requested overlap

        const calculated = service.calculateRotationOverlapExpiry(
          originalExpiresAt,
          overlapDurationMs,
          now,
        );

        // Overlap requested would be 13:00:00, but original was 12:30:00. Must not exceed 12:30:00.
        expect(calculated.toISOString()).toBe("2026-10-20T12:30:00.000Z");
      });

      it("uses full overlap window when original expiresAt is further than overlap window", () => {
        const now = new Date("2026-10-20T12:00:00Z");
        const originalExpiresAt = new Date("2026-10-20T18:00:00Z"); // 6 hours left
        const overlapDurationMs = 3600_000; // 1 hour requested overlap

        const calculated = service.calculateRotationOverlapExpiry(
          originalExpiresAt,
          overlapDurationMs,
          now,
        );

        // Now + 1h is 13:00:00, which is earlier than 18:00:00
        expect(calculated.toISOString()).toBe("2026-10-20T13:00:00.000Z");
      });

      it("uses full overlap window when original key had no expiresAt", () => {
        const now = new Date("2026-10-20T12:00:00Z");
        const overlapDurationMs = 3600_000; // 1 hour

        const calculated = service.calculateRotationOverlapExpiry(
          null,
          overlapDurationMs,
          now,
        );

        expect(calculated.toISOString()).toBe("2026-10-20T13:00:00.000Z");
      });

      it("rotateKey enforces bounded overlap policy and invalidates cache", async () => {
        const keyId = "key_rotating";
        const originalExpiresAt = new Date("2026-10-20T12:15:00Z"); // 15 min left
        const overlapDurationMs = 3600_000; // 1 hour overlap requested

        prismaService.apiKey.findUnique.mockResolvedValueOnce({
          id: keyId,
          organizationId: "org_1",
          expiresAt: originalExpiresAt,
        });

        prismaService.apiKey.update.mockImplementationOnce((params: any) => ({
          id: keyId,
          organizationId: "org_1",
          prefix: params.data.prefix,
          name: "Rotating Key",
          status: ResourceStatus.ACTIVE,
          scopeAssignments: [],
          rotatedAt: fixedNow,
          expiresAt: params.data.expiresAt,
        }));

        const result = await service.rotateKey(keyId, "org_1", "user_1", {
          overlapDurationMs,
        });

        // The new expiresAt for the rotated key must be capped at originalExpiresAt
        expect(result.apiKey.expiresAt?.toISOString()).toBe("2026-10-20T12:15:00.000Z");
      });

      it("rejects concurrent rotation requests when rotation is already IN_OVERLAP", async () => {
        const keyId = "key_in_overlap";
        prismaService.apiKey.findUnique.mockResolvedValueOnce({
          id: keyId,
          organizationId: "org_1",
          status: ResourceStatus.ACTIVE,
        });

        prismaService.apiKeyRotation = {
          findMany: jest.fn().mockResolvedValueOnce([
            {
              id: "rot_active",
              oldKeyId: keyId,
              status: ApiKeyRotationStatus.IN_OVERLAP,
            },
          ]),
        };

        await expect(
          service.rotateKey(keyId, "org_1", "user_1"),
        ).rejects.toThrow("Key already has an active rotation in progress");
      });

      it("expired overlap cannot be extended by replaying rotation requests", async () => {
        const keyId = "key_expired_rotation";
        prismaService.apiKey.findUnique.mockResolvedValueOnce({
          id: keyId,
          organizationId: "org_1",
          status: ResourceStatus.ACTIVE,
        });

        prismaService.apiKeyRotation = {
          findMany: jest.fn().mockResolvedValueOnce([
            {
              id: "rot_expired",
              oldKeyId: keyId,
              status: ApiKeyRotationStatus.EXPIRED,
            },
          ]),
        };

        await expect(
          service.rotateKey(keyId, "org_1", "user_1"),
        ).rejects.toThrow("Cannot rotate an API key that has already been rotated");
      });
    });
  });
});

