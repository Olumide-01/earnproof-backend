import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { SignedCursorService } from "./signed-cursor.service";
import { SignedCursorKeyringService } from "./signed-cursor-keyring.service";
import {
  SignedCursorFailureReason,
  SignCursorParams,
  VerifySignedCursorParams,
} from "./signed-cursor.types";

const TEST_SECRET_V0 = "test-cursor-secret-v0-abcdefghij012345";
const TEST_SECRET_V1 = "test-cursor-secret-v1-abcdefghij012345";

describe("SignedCursorService", () => {
  let service: SignedCursorService;
  let keyring: SignedCursorKeyringService;
  let configService: ConfigService;

  const mockConfigService = {
    get: (key: string) => {
      const config: Record<string, any> = {
        cursorSigningSecret: TEST_SECRET_V0,
        cursorSigningKeyVersions: {
          0: TEST_SECRET_V0,
          1: TEST_SECRET_V1,
        },
        cursorSigningKeyVersion: 0,
        cursorSigningKeyVerifyUntil: {},
      };
      return config[key];
    },
    getOrThrow: (key: string) => {
      const val = mockConfigService.get(key);
      if (val === undefined) throw new Error(`Config key not found: ${key}`);
      return val;
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SignedCursorService,
        SignedCursorKeyringService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<SignedCursorService>(SignedCursorService);
    keyring = module.get<SignedCursorKeyringService>(SignedCursorKeyringService);
    configService = module.get<ConfigService>(ConfigService);
  });

  describe("sign", () => {
    it("should create a signed cursor token", () => {
      const params: SignCursorParams = {
        cursorId: "item-123",
        tenantId: "org-456",
        filterId: "filter-abc",
      };

      const token = service.sign(params);

      expect(token).toBeDefined();
      expect(typeof token).toBe("string");
      // Token should be base64url encoded (alphanumeric, dash, underscore)
      expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true);
    });

    it("should include default TTL when not specified", () => {
      const params: SignCursorParams = {
        cursorId: "item-123",
        tenantId: "org-456",
        filterId: "filter-abc",
      };

      const token = service.sign(params);

      // Decode and verify expiresAt is in the future
      const json = Buffer.from(token, "base64url").toString("utf8");
      const envelope = JSON.parse(json);

      const now = Date.now();
      const expiresAt = envelope.expiresAt;
      const ttlMs = expiresAt - now;

      // Should be roughly 15 minutes (900,000 ms), with small variance
      expect(ttlMs).toBeGreaterThan(14 * 60 * 1000);
      expect(ttlMs).toBeLessThan(16 * 60 * 1000);
    });

    it("should use custom TTL when specified", () => {
      const params: SignCursorParams = {
        cursorId: "item-123",
        tenantId: "org-456",
        filterId: "filter-abc",
        ttlSeconds: 300, // 5 minutes
      };

      const token = service.sign(params);

      const json = Buffer.from(token, "base64url").toString("utf8");
      const envelope = JSON.parse(json);

      const now = Date.now();
      const expiresAt = envelope.expiresAt;
      const ttlMs = expiresAt - now;

      // Should be roughly 5 minutes (300,000 ms)
      expect(ttlMs).toBeGreaterThan(4 * 60 * 1000);
      expect(ttlMs).toBeLessThan(6 * 60 * 1000);
    });

    it("should create a valid envelope structure", () => {
      const params: SignCursorParams = {
        cursorId: "item-123",
        tenantId: "org-456",
        filterId: "filter-abc",
      };

      const token = service.sign(params);

      const json = Buffer.from(token, "base64url").toString("utf8");
      const envelope = JSON.parse(json);

      expect(envelope).toHaveProperty("version", "1");
      expect(envelope).toHaveProperty("cursorId", "item-123");
      expect(envelope).toHaveProperty("tenantId", "org-456");
      expect(envelope).toHaveProperty("filterId", "filter-abc");
      expect(envelope).toHaveProperty("signature");
      expect(envelope).toHaveProperty("expiresAt");
      expect(typeof envelope.signature).toBe("string");
      expect(/^[a-f0-9]{64}$/.test(envelope.signature)).toBe(true);
    });
  });

  describe("verify", () => {
    it("should verify a valid signed cursor token", () => {
      const params: SignCursorParams = {
        cursorId: "item-123",
        tenantId: "org-456",
        filterId: "filter-abc",
      };

      const token = service.sign(params);

      const result = service.verify({
        token,
        tenantId: "org-456",
        filterId: "filter-abc",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.cursorId).toBe("item-123");
        expect(result.data.tenantId).toBe("org-456");
        expect(result.data.filterId).toBe("filter-abc");
      }
    });

    it("should reject a malformed token", () => {
      const result = service.verify({
        token: "not-base64url!!!",
        tenantId: "org-456",
        filterId: "filter-abc",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(SignedCursorFailureReason.MALFORMED);
      }
    });

    it("should reject a token with missing fields", () => {
      // Create a token with incomplete payload
      const incomplete = JSON.stringify({
        version: "1",
        // Missing other required fields
      });
      const token = Buffer.from(incomplete, "utf8").toString("base64url");

      const result = service.verify({
        token,
        tenantId: "org-456",
        filterId: "filter-abc",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(SignedCursorFailureReason.MISSING_FIELDS);
      }
    });

    it("should reject an expired token", () => {
      const params: SignCursorParams = {
        cursorId: "item-123",
        tenantId: "org-456",
        filterId: "filter-abc",
        ttlSeconds: 1, // 1 second TTL
      };

      const token = service.sign(params);

      // Wait for token to expire
      const expiryTime = Date.now() + 1100; // 1.1 seconds from now

      const result = service.verify({
        token,
        tenantId: "org-456",
        filterId: "filter-abc",
        nowMs: expiryTime,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(SignedCursorFailureReason.EXPIRED);
      }
    });

    it("should reject a token with mismatched tenant ID", () => {
      const params: SignCursorParams = {
        cursorId: "item-123",
        tenantId: "org-456",
        filterId: "filter-abc",
      };

      const token = service.sign(params);

      const result = service.verify({
        token,
        tenantId: "org-999", // Different tenant
        filterId: "filter-abc",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(SignedCursorFailureReason.TENANT_MISMATCH);
      }
    });

    it("should reject a token with mismatched filter ID", () => {
      const params: SignCursorParams = {
        cursorId: "item-123",
        tenantId: "org-456",
        filterId: "filter-abc",
      };

      const token = service.sign(params);

      const result = service.verify({
        token,
        tenantId: "org-456",
        filterId: "filter-xyz", // Different filter
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(SignedCursorFailureReason.FILTER_MISMATCH);
      }
    });

    it("should reject a tampered token (modified cursor ID)", () => {
      const params: SignCursorParams = {
        cursorId: "item-123",
        tenantId: "org-456",
        filterId: "filter-abc",
      };

      const token = service.sign(params);

      // Tamper with the token
      const json = Buffer.from(token, "base64url").toString("utf8");
      const envelope = JSON.parse(json);
      envelope.cursorId = "item-999"; // Modify the cursor ID
      const tamperedJson = JSON.stringify(envelope);
      const tamperedToken = Buffer.from(tamperedJson, "utf8").toString("base64url");

      const result = service.verify({
        token: tamperedToken,
        tenantId: "org-456",
        filterId: "filter-abc",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(SignedCursorFailureReason.SIGNATURE_INVALID);
      }
    });

    it("should reject a tampered token (modified filter ID)", () => {
      const params: SignCursorParams = {
        cursorId: "item-123",
        tenantId: "org-456",
        filterId: "filter-abc",
      };

      const token = service.sign(params);

      // Tamper with the token
      const json = Buffer.from(token, "base64url").toString("utf8");
      const envelope = JSON.parse(json);
      envelope.filterId = "filter-xyz"; // Modify the filter ID
      const tamperedJson = JSON.stringify(envelope);
      const tamperedToken = Buffer.from(tamperedJson, "utf8").toString("base64url");

      const result = service.verify({
        token: tamperedToken,
        tenantId: "org-456",
        filterId: "filter-abc",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // First check will be filter mismatch (expected filter doesn't match envelope)
        expect([
          SignedCursorFailureReason.FILTER_MISMATCH,
          SignedCursorFailureReason.SIGNATURE_INVALID,
        ]).toContain(result.reason);
      }
    });

    it("should reject a tampered token (modified signature)", () => {
      const params: SignCursorParams = {
        cursorId: "item-123",
        tenantId: "org-456",
        filterId: "filter-abc",
      };

      const token = service.sign(params);

      // Tamper with the signature
      const json = Buffer.from(token, "base64url").toString("utf8");
      const envelope = JSON.parse(json);
      // Flip a bit in the signature
      const sigBytes = Buffer.from(envelope.signature, "hex");
      sigBytes[0] = (sigBytes[0] + 1) & 0xff;
      envelope.signature = sigBytes.toString("hex");
      const tamperedJson = JSON.stringify(envelope);
      const tamperedToken = Buffer.from(tamperedJson, "utf8").toString("base64url");

      const result = service.verify({
        token: tamperedToken,
        tenantId: "org-456",
        filterId: "filter-abc",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(SignedCursorFailureReason.SIGNATURE_INVALID);
      }
    });

    it("should accept a valid token just before expiry", () => {
      const params: SignCursorParams = {
        cursorId: "item-123",
        tenantId: "org-456",
        filterId: "filter-abc",
        ttlSeconds: 60,
      };

      const token = service.sign(params);

      // Verify just before expiry (59 seconds later)
      const json = Buffer.from(token, "base64url").toString("utf8");
      const envelope = JSON.parse(json);
      const nowMs = envelope.expiresAt - 100; // 100ms before expiry

      const result = service.verify({
        token,
        tenantId: "org-456",
        filterId: "filter-abc",
        nowMs,
      });

      expect(result.ok).toBe(true);
    });

    it("should reject a token at exact expiry time", () => {
      const params: SignCursorParams = {
        cursorId: "item-123",
        tenantId: "org-456",
        filterId: "filter-abc",
        ttlSeconds: 60,
      };

      const token = service.sign(params);

      // Verify at exact expiry moment
      const json = Buffer.from(token, "base64url").toString("utf8");
      const envelope = JSON.parse(json);
      const nowMs = envelope.expiresAt; // Exactly at expiry

      const result = service.verify({
        token,
        tenantId: "org-456",
        filterId: "filter-abc",
        nowMs,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(SignedCursorFailureReason.EXPIRED);
      }
    });
  });

  describe("cross-tenant protection", () => {
    it("should prevent using a cursor across different tenants", () => {
      const params: SignCursorParams = {
        cursorId: "item-123",
        tenantId: "org-456",
        filterId: "filter-abc",
      };

      const token = service.sign(params);

      // Try to use with different tenant
      const result = service.verify({
        token,
        tenantId: "org-999",
        filterId: "filter-abc",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(SignedCursorFailureReason.TENANT_MISMATCH);
      }
    });
  });

  describe("cross-filter protection", () => {
    it("should prevent using a cursor with different filters", () => {
      const params: SignCursorParams = {
        cursorId: "item-123",
        tenantId: "org-456",
        filterId: "status=open&category=accuracy",
      };

      const token = service.sign(params);

      // Try to use with different filter
      const result = service.verify({
        token,
        tenantId: "org-456",
        filterId: "status=resolved&category=accuracy", // Different filter
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(SignedCursorFailureReason.FILTER_MISMATCH);
      }
    });
  });

  describe("round-trip consistency", () => {
    it("should round-trip the same values", () => {
      const testCases = [
        {
          cursorId: "simple-id",
          tenantId: "org-1",
          filterId: "filter-1",
        },
        {
          cursorId: "complex-id_with-special.chars",
          tenantId: "org_tenant_123",
          filterId: "status=open&limit=20",
        },
        {
          cursorId: "uuid-550e8400-e29b-41d4-a716-446655440000",
          tenantId: "org-550e8400-e29b-41d4-a716-446655440000",
          filterId: "hash-abc123def456",
        },
      ];

      for (const testCase of testCases) {
        const token = service.sign(testCase);

        const result = service.verify({
          token,
          tenantId: testCase.tenantId,
          filterId: testCase.filterId,
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.cursorId).toBe(testCase.cursorId);
          expect(result.data.tenantId).toBe(testCase.tenantId);
          expect(result.data.filterId).toBe(testCase.filterId);
        }
      }
    });
  });

  describe("signature verification consistency", () => {
    it("should produce consistent signatures for the same input", () => {
      const params: SignCursorParams = {
        cursorId: "item-123",
        tenantId: "org-456",
        filterId: "filter-abc",
        ttlSeconds: 60,
      };

      // Sign the same data multiple times synchronously
      // (signature will differ due to different expiresAt times, but structure is the same)
      const token1 = service.sign(params);
      const token2 = service.sign(params);

      // Both should verify successfully
      const result1 = service.verify({
        token: token1,
        tenantId: "org-456",
        filterId: "filter-abc",
      });

      const result2 = service.verify({
        token: token2,
        tenantId: "org-456",
        filterId: "filter-abc",
      });

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      // But they should be different tokens (different expiresAt)
      expect(token1).not.toBe(token2);
    });
  });

  describe("deterministic encoding", () => {
    it("should use base64url encoding correctly", () => {
      const params: SignCursorParams = {
        cursorId: "test",
        tenantId: "org",
        filterId: "filter",
      };

      const token = service.sign(params);

      // Should be decodable with base64url
      const json = Buffer.from(token, "base64url").toString("utf8");
      const envelope = JSON.parse(json);

      expect(envelope.cursorId).toBe("test");
    });
  });
});
