import { BadRequestException } from "@nestjs/common";
import { createHash } from "crypto";
import { WebhookSigningService } from "./webhook-signing.service";
import { WebhookVerificationService } from "./webhook-verification.service";

const RAW_SECRET = "test-raw-signing-secret-32bytes!";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildPrisma(challenges: Map<string, Record<string, unknown>>) {
  return {
    webhookVerificationChallenge: {
      updateMany: jest.fn().mockImplementation(
        ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          let count = 0;
          for (const row of challenges.values()) {
            if (where.webhookId && row.webhookId !== where.webhookId) continue;
            if ("usedAt" in where && where.usedAt === null && row.usedAt !== null) continue;
            if (where.tokenHash && row.tokenHash !== where.tokenHash) continue;
            const expiresAtFilter = where.expiresAt as { gt?: Date } | undefined;
            if (expiresAtFilter?.gt && (row.expiresAt as Date) <= expiresAtFilter.gt) {
              continue;
            }
            Object.assign(row, data);
            count += 1;
          }
          return Promise.resolve({ count });
        },
      ),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        const id = `challenge_${challenges.size + 1}`;
        challenges.set(id, { id, usedAt: null, ...data });
        return Promise.resolve({ id });
      }),
    },
  };
}

describe("WebhookVerificationService", () => {
  describe("issueChallenge", () => {
    it("stores only a hash of the token, never the raw value", async () => {
      const challenges = new Map<string, Record<string, unknown>>();
      const prisma = buildPrisma(challenges);
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });

      const service = new WebhookVerificationService(
        prisma as never,
        new WebhookSigningService(),
      );

      await service.issueChallenge("webhook_1", "https://example.com/hook", RAW_SECRET);

      expect(challenges.size).toBe(1);
      const stored = [...challenges.values()][0];
      expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(stored)).not.toMatch(/token.{0,5}[a-zA-Z0-9_-]{40}/);
    });

    it("delivers the challenge through the guarded transport with no-redirect and a signature", async () => {
      const challenges = new Map<string, Record<string, unknown>>();
      const prisma = buildPrisma(challenges);
      const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
      global.fetch = fetchMock as unknown as typeof fetch;

      const service = new WebhookVerificationService(
        prisma as never,
        new WebhookSigningService(),
      );

      await service.issueChallenge("webhook_1", "https://example.com/hook", RAW_SECRET);

      expect(fetchMock).toHaveBeenCalledWith(
        "https://example.com/hook",
        expect.objectContaining({
          method: "POST",
          redirect: "error",
          headers: expect.objectContaining({
            "X-EarnProof-Event": "webhook.verification",
            "X-EarnProof-Signature": expect.stringMatching(/^v1=[0-9a-f]{64}$/),
          }),
        }),
      );
    });

    it("invalidates any previously issued, still-unused challenge for the same webhook", async () => {
      const challenges = new Map<string, Record<string, unknown>>();
      const prisma = buildPrisma(challenges);
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });

      const service = new WebhookVerificationService(
        prisma as never,
        new WebhookSigningService(),
      );

      await service.issueChallenge("webhook_1", "https://example.com/hook", RAW_SECRET);
      const first = [...challenges.values()][0];
      expect(first.usedAt).toBeNull();

      await service.issueChallenge("webhook_1", "https://example.com/hook-v2", RAW_SECRET);

      expect(first.usedAt).not.toBeNull();
      expect(challenges.size).toBe(2);
    });

    it("does not throw when the destination is unreachable (best-effort delivery)", async () => {
      const challenges = new Map<string, Record<string, unknown>>();
      const prisma = buildPrisma(challenges);
      global.fetch = jest.fn().mockRejectedValue(new Error("network unreachable"));

      const service = new WebhookVerificationService(
        prisma as never,
        new WebhookSigningService(),
      );

      await expect(
        service.issueChallenge("webhook_1", "https://example.com/hook", RAW_SECRET),
      ).resolves.toMatchObject({ challengeId: expect.any(String) });
      expect(challenges.size).toBe(1);
    });

    it("does not throw when the destination is blocked by the SSRF guard", async () => {
      const challenges = new Map<string, Record<string, unknown>>();
      const prisma = buildPrisma(challenges);
      global.fetch = jest.fn();

      const service = new WebhookVerificationService(
        prisma as never,
        new WebhookSigningService(),
      );

      await expect(
        service.issueChallenge("webhook_1", "https://127.0.0.1/hook", RAW_SECRET),
      ).resolves.toMatchObject({ challengeId: expect.any(String) });
      // Blocked before any network call was attempted.
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("verifyChallenge", () => {
    it("consumes a valid, unexpired token exactly once", async () => {
      const token = "the-raw-token";
      const challenges = new Map<string, Record<string, unknown>>([
        [
          "challenge_1",
          {
            id: "challenge_1",
            webhookId: "webhook_1",
            tokenHash: sha256(token),
            usedAt: null,
            expiresAt: new Date(Date.now() + 60_000),
          },
        ],
      ]);
      const prisma = buildPrisma(challenges);

      const service = new WebhookVerificationService(
        prisma as never,
        new WebhookSigningService(),
      );

      await expect(service.verifyChallenge("webhook_1", token)).resolves.toBe(true);
    });

    it("rejects a replayed (already-used) token", async () => {
      const token = "the-raw-token";
      const challenges = new Map<string, Record<string, unknown>>([
        [
          "challenge_1",
          {
            id: "challenge_1",
            webhookId: "webhook_1",
            tokenHash: sha256(token),
            usedAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
          },
        ],
      ]);
      const prisma = buildPrisma(challenges);

      const service = new WebhookVerificationService(
        prisma as never,
        new WebhookSigningService(),
      );

      await expect(service.verifyChallenge("webhook_1", token)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("rejects an expired token (timeout scenario — no acknowledgement ever arrived in time)", async () => {
      const token = "the-raw-token";
      const challenges = new Map<string, Record<string, unknown>>([
        [
          "challenge_1",
          {
            id: "challenge_1",
            webhookId: "webhook_1",
            tokenHash: sha256(token),
            usedAt: null,
            expiresAt: new Date(Date.now() - 1_000),
          },
        ],
      ]);
      const prisma = buildPrisma(challenges);

      const service = new WebhookVerificationService(
        prisma as never,
        new WebhookSigningService(),
      );

      await expect(service.verifyChallenge("webhook_1", token)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("rejects an unknown token", async () => {
      const challenges = new Map<string, Record<string, unknown>>();
      const prisma = buildPrisma(challenges);

      const service = new WebhookVerificationService(
        prisma as never,
        new WebhookSigningService(),
      );

      await expect(
        service.verifyChallenge("webhook_1", "never-issued"),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects a token issued for a different webhook", async () => {
      const token = "the-raw-token";
      const challenges = new Map<string, Record<string, unknown>>([
        [
          "challenge_1",
          {
            id: "challenge_1",
            webhookId: "webhook_other",
            tokenHash: sha256(token),
            usedAt: null,
            expiresAt: new Date(Date.now() + 60_000),
          },
        ],
      ]);
      const prisma = buildPrisma(challenges);

      const service = new WebhookVerificationService(
        prisma as never,
        new WebhookSigningService(),
      );

      await expect(service.verifyChallenge("webhook_1", token)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
