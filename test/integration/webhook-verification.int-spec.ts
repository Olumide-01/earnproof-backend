import { BadRequestException } from "@nestjs/common";
import { integrationDatabase } from "./harness/database";
import { seedOrganization, seedUser } from "./harness/fixtures";
import { WebhookSigningService } from "../../src/webhooks/webhook-signing.service";
import { WebhookVerificationService } from "../../src/webhooks/webhook-verification.service";

/**
 * Webhook destination-ownership verification challenges (issue #193).
 *
 * `WebhookVerificationChallenge.tokenHash` is unique and single-use enforcement
 * relies on an atomic conditional `updateMany` against the real table, so these
 * properties — replay rejection, cross-webhook isolation, and destination-change
 * invalidation — are asserted against Postgres rather than a mocked Prisma client.
 *
 * The destination used here (`https://example.com/...`) is a real, resolvable
 * host; `global.fetch` is stubbed so no network request actually leaves the
 * process, letting the test capture the token exactly as a real integrator's
 * endpoint would receive it in the delivered payload.
 */

const db = integrationDatabase();

const RAW_SECRET = "test-raw-signing-secret-32bytes!";

async function seedWebhookDirect(seed: string, url: string) {
  const user = await seedUser(db.prisma, seed);
  const organization = await seedOrganization(db.prisma, seed, user.id);
  const webhook = await db.prisma.webhook.create({
    data: {
      organizationId: organization.id,
      url,
      secretEncrypted: "unused-in-these-tests",
      events: ["proof.created"],
      status: "PENDING",
    },
  });
  return { organization, webhook };
}

function capturingFetch() {
  let capturedBody: string | undefined;
  const fn = jest.fn().mockImplementation((_url: string, init: { body: string }) => {
    capturedBody = init.body;
    return Promise.resolve({ ok: true, status: 200, text: async () => "" });
  });
  return { fn, getToken: () => (JSON.parse(capturedBody!) as { token: string }).token };
}

describe("webhook verification challenges", () => {
  it("success: a delivered token verifies and can only be consumed once", async () => {
    const { fn, getToken } = capturingFetch();
    global.fetch = fn as unknown as typeof fetch;

    const { webhook } = await seedWebhookDirect(
      "verify-success",
      "https://example.com/verify-hook-success",
    );
    const service = new WebhookVerificationService(
      db.prisma as never,
      new WebhookSigningService(),
    );

    await service.issueChallenge(webhook.id, webhook.url, RAW_SECRET);
    const token = getToken();

    await expect(service.verifyChallenge(webhook.id, token)).resolves.toBe(true);
  });

  it("replay: re-submitting the same (already-consumed) token is rejected", async () => {
    const { fn, getToken } = capturingFetch();
    global.fetch = fn as unknown as typeof fetch;

    const { webhook } = await seedWebhookDirect(
      "verify-replay",
      "https://example.com/verify-hook-replay",
    );
    const service = new WebhookVerificationService(
      db.prisma as never,
      new WebhookSigningService(),
    );

    await service.issueChallenge(webhook.id, webhook.url, RAW_SECRET);
    const token = getToken();

    await expect(service.verifyChallenge(webhook.id, token)).resolves.toBe(true);
    await expect(service.verifyChallenge(webhook.id, token)).rejects.toThrow(
      BadRequestException,
    );
  });

  it("concurrent replay: only one of two simultaneous submissions of the same token succeeds", async () => {
    const { fn, getToken } = capturingFetch();
    global.fetch = fn as unknown as typeof fetch;

    const { webhook } = await seedWebhookDirect(
      "verify-replay-race",
      "https://example.com/verify-hook-replay-race",
    );
    const service = new WebhookVerificationService(
      db.prisma as never,
      new WebhookSigningService(),
    );

    await service.issueChallenge(webhook.id, webhook.url, RAW_SECRET);
    const token = getToken();

    const results = await Promise.allSettled([
      service.verifyChallenge(webhook.id, token),
      service.verifyChallenge(webhook.id, token),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it("timeout: a token whose challenge expired before any acknowledgement arrived is rejected", async () => {
    const { fn, getToken } = capturingFetch();
    global.fetch = fn as unknown as typeof fetch;

    const { webhook } = await seedWebhookDirect(
      "verify-timeout",
      "https://example.com/verify-hook-timeout",
    );
    const service = new WebhookVerificationService(
      db.prisma as never,
      new WebhookSigningService(),
    );

    await service.issueChallenge(webhook.id, webhook.url, RAW_SECRET);
    const token = getToken();

    // Simulate the challenge's deterministic expiry elapsing with no
    // acknowledgement ever having arrived.
    await db.prisma.webhookVerificationChallenge.updateMany({
      where: { webhookId: webhook.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await expect(service.verifyChallenge(webhook.id, token)).rejects.toThrow(
      BadRequestException,
    );
  });

  it("destination mutation: issuing a new challenge for a changed URL invalidates the prior one", async () => {
    const { fn, getToken } = capturingFetch();
    global.fetch = fn as unknown as typeof fetch;

    const { webhook } = await seedWebhookDirect(
      "verify-mutation",
      "https://example.com/verify-hook-old",
    );
    const service = new WebhookVerificationService(
      db.prisma as never,
      new WebhookSigningService(),
    );

    await service.issueChallenge(webhook.id, webhook.url, RAW_SECRET);
    const oldToken = getToken();

    // Destination changes — a fresh challenge is issued for the new URL.
    await service.issueChallenge(
      webhook.id,
      "https://example.com/verify-hook-new",
      RAW_SECRET,
    );
    const newToken = getToken();

    await expect(service.verifyChallenge(webhook.id, oldToken)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.verifyChallenge(webhook.id, newToken)).resolves.toBe(true);
  });

  it("isolation: a token issued for one webhook does not verify another", async () => {
    const { fn, getToken } = capturingFetch();
    global.fetch = fn as unknown as typeof fetch;

    const { webhook: webhookA } = await seedWebhookDirect(
      "verify-isolation-a",
      "https://example.com/verify-hook-a",
    );
    const { webhook: webhookB } = await seedWebhookDirect(
      "verify-isolation-b",
      "https://example.com/verify-hook-b",
    );
    const service = new WebhookVerificationService(
      db.prisma as never,
      new WebhookSigningService(),
    );

    await service.issueChallenge(webhookA.id, webhookA.url, RAW_SECRET);
    const tokenForA = getToken();

    await expect(service.verifyChallenge(webhookB.id, tokenForA)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.verifyChallenge(webhookA.id, tokenForA)).resolves.toBe(true);
  });
});
