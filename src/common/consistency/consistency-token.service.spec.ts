import { ConsistencyTokenService } from "./consistency-token.service";

describe("ConsistencyTokenService", () => {
  let service: ConsistencyTokenService;

  beforeEach(() => {
    service = new ConsistencyTokenService();
  });

  const tenantA = "org-tenant-a";
  const tenantB = "org-tenant-b";

  describe("issue and verify", () => {
    it("issues a compact, signed consistency token for a resource", () => {
      const token = service.issueSingleResourceToken(
        tenantA,
        "proof",
        "proof-100",
        4,
        "testnet",
        "replica-1",
      );

      expect(typeof token).toBe("string");
      expect(token.split(".").length).toBe(3);

      const { payload, error } = service.parseAndVerify(token);
      expect(error).toBeUndefined();
      expect(payload?.tenantId).toBe(tenantA);
      expect(payload?.network).toBe("testnet");
      expect(payload?.resources[0]).toEqual({
        resourceType: "proof",
        resourceId: "proof-100",
        version: 4,
      });
    });

    it("fails closed on tampered signature", () => {
      const token = service.issueSingleResourceToken(
        tenantA,
        "proof",
        "proof-100",
        4,
      );
      const parts = token.split(".");
      const tampered = `${parts[0]}.${parts[1]}.tamperedSignature`;

      const result = service.validateConsistency(tampered, tenantA, {
        "proof:proof-100": 4,
      });

      expect(result.valid).toBe(false);
      expect(result.consistent).toBe(false);
      expect(result.reason).toBe("tampered");
    });

    it("fails closed on modified payload", () => {
      const token = service.issueSingleResourceToken(
        tenantA,
        "proof",
        "proof-100",
        4,
      );
      const parts = token.split(".");
      const tamperedBody = Buffer.from(
        JSON.stringify({ tenantId: tenantB, resources: [] }),
      ).toString("base64url");
      const tampered = `${parts[0]}.${tamperedBody}.${parts[2]}`;

      const result = service.validateConsistency(tampered, tenantB, {});
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("tampered");
    });

    it("fails closed on expired tokens", () => {
      const expiredToken = service.issueToken({
        tenantId: tenantA,
        resources: [{ resourceType: "proof", resourceId: "proof-100", version: 1 }],
        ttlMs: -100, // already expired
      });

      const result = service.validateConsistency(expiredToken, tenantA, {
        "proof:proof-100": 1,
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe("expired");
    });
  });

  describe("tenant isolation and authorization boundaries", () => {
    it("fails closed with tenant_mismatch when validated against another tenant", () => {
      const token = service.issueSingleResourceToken(
        tenantA,
        "proof",
        "proof-secret",
        1,
      );

      const result = service.validateConsistency(token, tenantB, {
        "proof:proof-secret": 1,
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe("tenant_mismatch");
      // Does not expose resource details or version
      expect(result.requiredVersion).toBeUndefined();
    });

    it("enforces network qualification when specified", () => {
      const token = service.issueSingleResourceToken(
        tenantA,
        "proof",
        "proof-1",
        2,
        "testnet",
      );

      const result = service.validateConsistency(
        token,
        tenantA,
        { "proof:proof-1": 2 },
        { network: "mainnet" },
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toBe("network_mismatch");
    });

    it("enforces projection qualification when specified", () => {
      const token = service.issueSingleResourceToken(
        tenantA,
        "proof",
        "proof-1",
        2,
        "testnet",
        "projections/eu-west",
      );

      const result = service.validateConsistency(
        token,
        tenantA,
        { "proof:proof-1": 2 },
        { projectionId: "projections/us-east" },
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toBe("projection_mismatch");
    });
  });

  describe("replica lag and out-of-order writes", () => {
    it("detects replica lag when observed version is lower than required", () => {
      const token = service.issueSingleResourceToken(
        tenantA,
        "payment",
        "pay-123",
        5,
      );

      const result = service.validateConsistency(token, tenantA, {
        "payment:pay-123": 3, // Replica is 2 versions behind
      });

      expect(result.valid).toBe(true);
      expect(result.consistent).toBe(false);
      expect(result.reason).toBe("replica_lag");
      expect(result.requiredVersion).toBe(5);
      expect(result.observedVersion).toBe(3);
      expect(result.lag).toBe(2);
    });

    it("reports consistent when replica has caught up to or passed required version", () => {
      const token = service.issueSingleResourceToken(
        tenantA,
        "payment",
        "pay-123",
        5,
      );

      const result = service.validateConsistency(token, tenantA, {
        "payment:pay-123": 5, // Fully consistent
      });

      expect(result.valid).toBe(true);
      expect(result.consistent).toBe(true);
      expect(result.lag).toBe(0);
      expect(result.reason).toBeUndefined();
    });

    it("handles missing resource on replica as not found", () => {
      const token = service.issueSingleResourceToken(
        tenantA,
        "proof",
        "proof-new",
        1,
      );

      const result = service.validateConsistency(token, tenantA, {});
      expect(result.valid).toBe(true);
      expect(result.consistent).toBe(false);
      expect(result.reason).toBe("resource_not_found");
    });

    it("validates multi-resource atomic consistency", () => {
      const multiToken = service.issueToken({
        tenantId: tenantA,
        resources: [
          { resourceType: "proof", resourceId: "p1", version: 10 },
          { resourceType: "attestation", resourceId: "a1", version: 2 },
        ],
      });

      // Proof is up to date, but attestation replica is lagging
      const lagging = service.validateConsistency(multiToken, tenantA, {
        "proof:p1": 10,
        "attestation:a1": 1,
      });

      expect(lagging.valid).toBe(true);
      expect(lagging.consistent).toBe(false);
      expect(lagging.reason).toBe("replica_lag");
      expect(lagging.requiredVersion).toBe(2);
      expect(lagging.observedVersion).toBe(1);
      expect(lagging.lag).toBe(1);

      // Both caught up
      const caughtUp = service.validateConsistency(multiToken, tenantA, {
        "proof:p1": 11,
        "attestation:a1": 2,
      });

      expect(caughtUp.valid).toBe(true);
      expect(caughtUp.consistent).toBe(true);
    });
  });

  describe("key rotation keyring semantics", () => {
    it("verifies tokens signed with older keys while primary key is rotated", () => {
      // Token issued with initial primary key "k1"
      const tokenK1 = service.issueSingleResourceToken(tenantA, "proof", "p1", 1);

      // Rotate primary key to "k2"
      service.addKey("k2", "new-secret-key-32-chars-long-second!", true);

      // Token issued with new primary key "k2"
      const tokenK2 = service.issueSingleResourceToken(tenantA, "proof", "p2", 1);

      // Both tokens remain valid
      expect(
        service.validateConsistency(tokenK1, tenantA, { "proof:p1": 1 }).valid,
      ).toBe(true);
      expect(
        service.validateConsistency(tokenK2, tenantA, { "proof:p2": 1 }).valid,
      ).toBe(true);
    });

    it("fails closed when an old key is revoked from the keyring", () => {
      const token = service.issueSingleResourceToken(tenantA, "proof", "p1", 1);

      // Revoke the key used to sign it
      service.revokeKey("k1");

      const res = service.validateConsistency(token, tenantA, { "proof:p1": 1 });
      expect(res.valid).toBe(false);
      expect(res.reason).toBe("unknown_key");
    });
  });
});
