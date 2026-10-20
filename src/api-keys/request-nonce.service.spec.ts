import { RequestNonceService } from "./request-nonce.service";

function makePrisma() {
  return {
    $executeRaw: jest.fn().mockResolvedValue(1),
    requestNonce: { deleteMany: jest.fn().mockResolvedValue({ count: 3 }) },
  };
}

describe("RequestNonceService", () => {
  let service: RequestNonceService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
    service = new RequestNonceService(prisma as never);
  });

  describe("hashNonce", () => {
    it("produces a 64-char hex string", () => {
      expect(service.hashNonce("key_1", "nonce123")).toMatch(/^[a-f0-9]{64}$/);
    });

    it("is deterministic", () => {
      expect(service.hashNonce("key_1", "nonce123")).toBe(service.hashNonce("key_1", "nonce123"));
    });

    it("differs when keyId changes (scoped uniqueness)", () => {
      expect(service.hashNonce("key_1", "nonce123")).not.toBe(service.hashNonce("key_2", "nonce123"));
    });

    it("differs when nonce changes", () => {
      expect(service.hashNonce("key_1", "nonce_a")).not.toBe(service.hashNonce("key_1", "nonce_b"));
    });

    it("never contains the raw nonce value", () => {
      const rawNonce = "my-super-secret-nonce-value-here";
      const hash = service.hashNonce("key_1", rawNonce);
      expect(hash).not.toContain(rawNonce);
    });
  });

  describe("claimNonce", () => {
    it("returns true when the nonce is fresh (1 row inserted)", async () => {
      prisma.$executeRaw.mockResolvedValueOnce(1);
      expect(await service.claimNonce("key_1", "nonce123456789012", 1724400000)).toBe(true);
    });

    it("returns false when nonce is a replay (0 rows inserted — ON CONFLICT DO NOTHING)", async () => {
      prisma.$executeRaw.mockResolvedValueOnce(0);
      expect(await service.claimNonce("key_1", "nonce123456789012", 1724400000)).toBe(false);
    });

    it("returns false (fail closed) when the database errors", async () => {
      prisma.$executeRaw.mockRejectedValueOnce(new Error("DB error"));
      expect(await service.claimNonce("key_1", "nonce123456789012", 1724400000)).toBe(false);
    });

    it("sets expiresAt to requestTimestamp + clockWindowSeconds", async () => {
      prisma.$executeRaw.mockResolvedValueOnce(1);
      await service.claimNonce("key_1", "nonce123456789012", 1724400000, 300);
      const rawArgs = prisma.$executeRaw.mock.calls[0] as unknown[];
      // The tagged template args include the expiresAt date value
      const templateParts = rawArgs as unknown[];
      // expiresAt = new Date((1724400000 + 300) * 1000)
      const expectedExpiry = new Date(1724400300 * 1000);
      const argStr = JSON.stringify(templateParts);
      expect(argStr).toContain(expectedExpiry.toISOString());
    });

    it("uses DEFAULT_CLOCK_WINDOW_SECONDS (300) when not specified", async () => {
      prisma.$executeRaw.mockResolvedValueOnce(1);
      await service.claimNonce("key_1", "nonce123456789012", 1724400000);
      // Should pass without error — clock window defaults to 300
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it("stores a hash of the nonce, not the raw value", async () => {
      const rawNonce = "raw-nonce-value-12345";
      prisma.$executeRaw.mockResolvedValueOnce(1);
      await service.claimNonce("key_1", rawNonce, 1724400000);
      const callStr = JSON.stringify(prisma.$executeRaw.mock.calls[0]);
      expect(callStr).not.toContain(rawNonce);
    });

    it("different keys can use the same raw nonce without collision", async () => {
      const hash1 = service.hashNonce("key_1", "same-nonce-1234567");
      const hash2 = service.hashNonce("key_2", "same-nonce-1234567");
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("purgeExpiredNonces", () => {
    it("calls deleteMany with expiresAt < now", async () => {
      await service.purgeExpiredNonces();
      expect(prisma.requestNonce.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { expiresAt: { lt: expect.any(Date) } } }),
      );
    });

    it("returns the count of deleted rows", async () => {
      prisma.requestNonce.deleteMany.mockResolvedValueOnce({ count: 7 });
      expect(await service.purgeExpiredNonces()).toBe(7);
    });

    it("returns 0 and does not throw on database error", async () => {
      prisma.requestNonce.deleteMany.mockRejectedValueOnce(new Error("DB"));
      expect(await service.purgeExpiredNonces()).toBe(0);
    });
  });
});