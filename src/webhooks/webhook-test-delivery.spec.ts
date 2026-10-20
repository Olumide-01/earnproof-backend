import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { AuthGuard } from "../common/guards/auth.guard";
import { encryptProtectedAmount } from "../common/crypto/protected-amount";
import { startReceiver } from "../../scripts/webhook-receiver/receiver";
import {
  HEADERS,
  verifyWebhookSignature,
} from "../../scripts/webhook-receiver/verifier";
import { CreateWebhookDto } from "./dto/create-webhook.dto";
import { WebhookDeliveryService } from "./webhook-delivery.service";
import {
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_TEST_EVENT_TYPE,
} from "./webhook-event.types";
import { WebhookSigningService } from "./webhook-signing.service";
import {
  SsrfBlockedError,
  assertSafeWebhookDestination,
} from "./webhook-ssrf-guard";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";

// The real guard resolves DNS and refuses loopback. Tests that talk to a local
// server stub it to "allowed"; the destination-rejection test stubs a block.
jest.mock("./webhook-ssrf-guard", () => {
  const actual = jest.requireActual("./webhook-ssrf-guard");
  return {
    ...actual,
    assertSafeWebhookDestination: jest.fn().mockResolvedValue(undefined),
  };
});

const guardMock = assertSafeWebhookDestination as jest.MockedFunction<
  typeof assertSafeWebhookDestination
>;

const ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const RAW_SECRET = "test-raw-signing-secret-32bytes!";
const SECRET_ENCRYPTED = encryptProtectedAmount(
  RAW_SECRET,
  new Map([[0, ENCRYPTION_KEY]]),
  0,
);

function makeConfig() {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === "paymentEncryptionKey") return ENCRYPTION_KEY;
      throw new Error(`Unexpected config key: ${key}`);
    }),
  };
}

/** A Prisma double that fails the test on any delivery-table access. */
function makeDeliveryPrisma() {
  return {
    webhookDelivery: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    auditLog: { create: jest.fn() },
  };
}

function makeService(prisma = makeDeliveryPrisma()) {
  const service = new WebhookDeliveryService(
    prisma as never,
    new WebhookSigningService(),
    makeConfig() as never,
  );
  return { service, prisma };
}

const HOOK = {
  id: "webhook_1",
  url: "https://receiver.example.com/hook",
  secretEncrypted: SECRET_ENCRYPTED,
};

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  redirect: string | undefined;
  signal: AbortSignal | undefined;
}

function mockFetchResponse(status: number, text: string) {
  const captured: CapturedRequest[] = [];
  const fetchMock = jest.fn(async (url: string, init: RequestInit) => {
    captured.push({
      url,
      headers: init.headers as Record<string, string>,
      body: init.body as string,
      redirect: init.redirect,
      signal: init.signal ?? undefined,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, captured };
}

function mockFetchRejection(error: unknown) {
  const fetchMock = jest.fn().mockRejectedValue(error);
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function expectNoDeliveryPersistence(
  service: WebhookDeliveryService,
  prisma: ReturnType<typeof makeDeliveryPrisma>,
) {
  expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
  expect(prisma.webhookDelivery.update).not.toHaveBeenCalled();
  expect(prisma.auditLog.create).not.toHaveBeenCalled();
  // The per-endpoint FIFO chain is the business retry queue.
  expect(
    (service as unknown as { chains: Map<string, unknown> }).chains.size,
  ).toBe(0);
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  guardMock.mockReset();
  guardMock.mockResolvedValue(undefined);
});

describe("WebhookDeliveryService.sendTestDelivery", () => {
  describe("successful delivery", () => {
    it("returns 2xx diagnostics with timing and the redacted receiver body", async () => {
      const { service } = makeService();
      mockFetchResponse(200, '{"received":true}');

      const result = await service.sendTestDelivery(HOOK);

      expect(result).toMatchObject({
        webhookId: "webhook_1",
        eventType: WEBHOOK_TEST_EVENT_TYPE,
        synthetic: true,
        testEventVersion: "1",
        delivered: true,
        statusClass: "2xx",
        statusCode: 200,
        failureReason: null,
        response: { body: '{"received":true}', truncated: false, maxBytes: 1024 },
      });
      expect(result.eventId).toMatch(/^test_[0-9a-f-]{36}$/);
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(Date.parse(result.sentAt))).toBe(false);
    });

    it("sends an unmistakably synthetic, versioned envelope with no business data", async () => {
      const { service } = makeService();
      const { captured } = mockFetchResponse(204, "");

      const result = await service.sendTestDelivery(HOOK);
      const [request] = captured;
      const envelope = JSON.parse(request.body);

      expect(request.headers["X-EarnProof-Event"]).toBe("webhook.test");
      expect(request.headers["X-EarnProof-Delivery"]).toBe(result.eventId);
      expect(envelope).toEqual({
        specVersion: "1",
        id: result.eventId,
        event: "webhook.test",
        synthetic: true,
        createdAt: result.sentAt,
        data: {
          synthetic: true,
          testEventVersion: "1",
          webhookId: "webhook_1",
          message: expect.any(String),
        },
      });
      // Not a business event type, so no endpoint can subscribe to it.
      expect(WEBHOOK_EVENT_TYPES as readonly string[]).not.toContain(
        WEBHOOK_TEST_EVENT_TYPE,
      );
    });

    it("never writes a delivery row or enters the retry queue", async () => {
      const { service, prisma } = makeService();
      mockFetchResponse(200, "ok");
      await service.sendTestDelivery(HOOK);
      expectNoDeliveryPersistence(service, prisma);
    });

    it("never writes a delivery row or retries when the receiver fails", async () => {
      const { service, prisma } = makeService();
      const { fetchMock } = mockFetchResponse(500, "boom");
      await service.sendTestDelivery(HOOK);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expectNoDeliveryPersistence(service, prisma);
    });

    it("leaks neither the signing secret nor the signature in diagnostics", async () => {
      const { service } = makeService();
      const { captured } = mockFetchResponse(200, "ok");

      const result = await service.sendTestDelivery(HOOK);
      const serialised = JSON.stringify(result);

      expect(serialised).not.toContain(RAW_SECRET);
      expect(serialised).not.toContain(SECRET_ENCRYPTED);
      expect(serialised).not.toContain(
        captured[0].headers["X-EarnProof-Signature"],
      );
    });
  });

  describe("signature", () => {
    it("is produced by the production signing path and verifies with the reference verifier", async () => {
      const { service } = makeService();
      const { captured } = mockFetchResponse(200, "ok");
      const signSpy = jest.spyOn(WebhookSigningService.prototype, "sign");

      await service.sendTestDelivery(HOOK);
      const { headers, body } = captured[0];
      const timestamp = Number(headers["X-EarnProof-Timestamp"]);

      expect(signSpy).toHaveBeenCalledWith(
        RAW_SECRET,
        timestamp,
        headers["X-EarnProof-Delivery"],
        body,
      );
      expect(headers["X-EarnProof-Signature"]).toMatch(/^v1=[0-9a-f]{64}$/);

      const verified = verifyWebhookSignature({
        secrets: [RAW_SECRET],
        rawBody: Buffer.from(body, "utf8"),
        signatureHeader: headers["X-EarnProof-Signature"],
        timestampHeader: headers["X-EarnProof-Timestamp"],
        deliveryIdHeader: headers["X-EarnProof-Delivery"],
        nowSeconds: timestamp,
      });
      expect(verified).toEqual({
        ok: true,
        deliveryId: headers["X-EarnProof-Delivery"],
        timestamp,
      });
      signSpy.mockRestore();
    });

    it("does not verify under a different secret or a modified body", async () => {
      const { service } = makeService();
      const { captured } = mockFetchResponse(200, "ok");

      await service.sendTestDelivery(HOOK);
      const { headers, body } = captured[0];
      const base = {
        signatureHeader: headers["X-EarnProof-Signature"],
        timestampHeader: headers["X-EarnProof-Timestamp"],
        deliveryIdHeader: headers["X-EarnProof-Delivery"],
        nowSeconds: Number(headers["X-EarnProof-Timestamp"]),
      };

      expect(
        verifyWebhookSignature({
          ...base,
          secrets: ["some-other-secret"],
          rawBody: Buffer.from(body),
        }),
      ).toEqual({ ok: false, reason: "signature_mismatch" });
      expect(
        verifyWebhookSignature({
          ...base,
          secrets: [RAW_SECRET],
          rawBody: Buffer.from(body.replace('"synthetic":true', '"synthetic":false')),
        }),
      ).toEqual({ ok: false, reason: "signature_mismatch" });
    });

    it("reports signing_error without sending when the secret cannot be decrypted", async () => {
      const { service } = makeService();
      const { fetchMock } = mockFetchResponse(200, "ok");
      jest.spyOn(
        (service as unknown as { logger: { error: () => void } }).logger,
        "error",
      ).mockImplementation(() => undefined);

      const result = await service.sendTestDelivery({
        ...HOOK,
        secretEncrypted: "not-a-valid-ciphertext",
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        delivered: false,
        statusClass: "signing_error",
        statusCode: null,
        response: { body: null, truncated: false },
      });
    });
  });

  describe("timeout", () => {
    it("applies the delivery timeout and reports a timeout class", async () => {
      const { service } = makeService();
      const timeoutError = Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      });
      const fetchMock = mockFetchRejection(timeoutError);

      const result = await service.sendTestDelivery(HOOK);

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(result).toMatchObject({
        delivered: false,
        statusClass: "timeout",
        statusCode: null,
        failureReason: "delivery request timed out",
        response: { body: null, truncated: false },
      });
    });
  });

  describe("redirect", () => {
    it("never follows a redirect", async () => {
      const { service } = makeService();
      const { captured } = mockFetchResponse(200, "ok");
      await service.sendTestDelivery(HOOK);
      expect(captured[0].redirect).toBe("error");
    });

    it("reports redirect_rejected for a real 3xx answer, without following it", async () => {
      let targetHits = 0;
      const target: Server = createServer((_req, res) => {
        targetHits += 1;
        res.end("should never be reached");
      });
      await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
      const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/`;

      const redirector: Server = createServer((_req, res) => {
        res.writeHead(302, { Location: targetUrl });
        res.end();
      });
      await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/hook`;

      try {
        const { service, prisma } = makeService();
        const result = await service.sendTestDelivery({ ...HOOK, url });

        expect(result).toMatchObject({
          delivered: false,
          statusClass: "redirect_rejected",
          statusCode: null,
          failureReason: "delivery request failed",
        });
        expect(targetHits).toBe(0);
        expectNoDeliveryPersistence(service, prisma);
      } finally {
        await new Promise<void>((r) => redirector.close(() => r()));
        await new Promise<void>((r) => target.close(() => r()));
      }
    });
  });

  describe("rejected delivery", () => {
    it.each([
      [400, "4xx"],
      [401, "4xx"],
      [404, "4xx"],
      [500, "5xx"],
      [503, "5xx"],
    ])("classifies HTTP %i as %s", async (status, statusClass) => {
      const { service } = makeService();
      mockFetchResponse(status, "nope");

      const result = await service.sendTestDelivery(HOOK);

      expect(result).toMatchObject({
        delivered: false,
        statusClass,
        statusCode: status,
        failureReason: `HTTP ${status}`,
        response: { body: "nope" },
      });
    });

    it("rejects a blocked destination before sending and hides the policy detail", async () => {
      const { service, prisma } = makeService();
      const { fetchMock } = mockFetchResponse(200, "ok");
      guardMock.mockRejectedValueOnce(
        new SsrfBlockedError("receiver.example.com resolves to private address 10.0.0.5"),
      );

      const result = await service.sendTestDelivery(HOOK);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(guardMock).toHaveBeenCalledWith(HOOK.url);
      expect(result).toMatchObject({
        delivered: false,
        statusClass: "destination_rejected",
        statusCode: null,
        failureReason: "destination rejected by outbound destination policy",
      });
      expect(JSON.stringify(result)).not.toContain("10.0.0.5");
      expectNoDeliveryPersistence(service, prisma);
    });

    it("reports a connection failure as network_error", async () => {
      const { service } = makeService();
      mockFetchRejection(
        new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") }),
      );

      const result = await service.sendTestDelivery(HOOK);

      expect(result).toMatchObject({
        statusClass: "network_error",
        statusCode: null,
        failureReason: "delivery request failed",
      });
    });
  });

  describe("receiver compatibility (reference receiver)", () => {
    it("is accepted by the reference receiver holding the endpoint secret", async () => {
      const received: { deliveryId: string; eventType?: string; rawBody: Buffer }[] = [];
      const receiver = await startReceiver({
        secrets: [RAW_SECRET],
        onDelivery: (delivery) => received.push(delivery),
        log: () => undefined,
      });

      try {
        const { service } = makeService();
        const result = await service.sendTestDelivery({ ...HOOK, url: receiver.url });

        expect(result).toMatchObject({
          delivered: true,
          statusClass: "2xx",
          statusCode: 204,
        });
        expect(received).toHaveLength(1);
        expect(received[0].deliveryId).toBe(result.eventId);
        expect(received[0].eventType).toBe("webhook.test");
        expect(JSON.parse(received[0].rawBody.toString("utf8")).synthetic).toBe(true);
      } finally {
        await receiver.close();
      }
    });

    it("is rejected (4xx) by a receiver holding a different secret", async () => {
      const receiver = await startReceiver({
        secrets: ["a-different-secret"],
        log: () => undefined,
      });

      try {
        const { service } = makeService();
        const result = await service.sendTestDelivery({ ...HOOK, url: receiver.url });

        expect(result).toMatchObject({
          delivered: false,
          statusClass: "4xx",
          statusCode: 401,
        });
      } finally {
        await receiver.close();
      }
    });

    it("sends the headers the reference verifier reads", () => {
      // Header names the delivery path sets, lowercased as Node receives them.
      expect(HEADERS).toEqual({
        timestamp: "x-earnproof-timestamp",
        delivery: "x-earnproof-delivery",
        event: "x-earnproof-event",
        signature: "x-earnproof-signature",
      });
    });
  });

  describe("redaction and response-size boundaries", () => {
    it("redacts credential-like values in the receiver response", async () => {
      const { service } = makeService();
      mockFetchResponse(
        400,
        '{"token":"abc123","password":"hunter2","api_key":"k-999"} echoed Bearer eyJhbGciOi.xyz',
      );

      const result = await service.sendTestDelivery(HOOK);
      const body = result.response.body ?? "";

      expect(body).toContain("[REDACTED]");
      for (const leaked of ["abc123", "hunter2", "k-999", "eyJhbGciOi.xyz"]) {
        expect(body).not.toContain(leaked);
      }
    });

    it("keeps a body of exactly the limit intact", async () => {
      const { service } = makeService();
      mockFetchResponse(200, "a".repeat(1024));

      const result = await service.sendTestDelivery(HOOK);

      expect(result.response).toEqual({
        body: "a".repeat(1024),
        truncated: false,
        maxBytes: 1024,
      });
    });

    it("truncates a body one past the limit", async () => {
      const { service } = makeService();
      mockFetchResponse(200, "a".repeat(1025));

      const result = await service.sendTestDelivery(HOOK);

      expect(result.response).toEqual({
        body: "a".repeat(1024) + "…[truncated]",
        truncated: true,
        maxBytes: 1024,
      });
    });

    it("truncates a very large body to the same bound", async () => {
      const { service } = makeService();
      mockFetchResponse(500, "x".repeat(1_000_000));

      const result = await service.sendTestDelivery(HOOK);

      expect(result.response.truncated).toBe(true);
      expect(result.response.body).toHaveLength(1024 + "…[truncated]".length);
    });

    it("returns an empty (not null) body when the receiver sent none", async () => {
      const { service } = makeService();
      mockFetchResponse(204, "");

      const result = await service.sendTestDelivery(HOOK);

      expect(result.response).toEqual({ body: "", truncated: false, maxBytes: 1024 });
    });
  });
});

describe("WebhooksService.sendTestDelivery", () => {
  function makeWebhooksService(webhook: Record<string, unknown> | null) {
    const prisma = {
      webhook: { findUnique: jest.fn().mockResolvedValue(webhook) },
      webhookDelivery: { create: jest.fn(), update: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    const delivery = {
      sendTestDelivery: jest.fn().mockResolvedValue({ statusClass: "2xx" }),
    };
    const service = new WebhooksService(
      prisma as never,
      delivery as never,
      makeConfig() as never,
    );
    return { service, prisma, delivery };
  }

  const owned = {
    id: "webhook_1",
    organizationId: "org_1",
    url: HOOK.url,
    secretEncrypted: SECRET_ENCRYPTED,
    status: "ACTIVE",
  };

  it("delivers to an active endpoint owned by the organisation", async () => {
    const { service, prisma, delivery } = makeWebhooksService(owned);

    await expect(service.sendTestDelivery("org_1", "webhook_1")).resolves.toEqual({
      statusClass: "2xx",
    });
    expect(delivery.sendTestDelivery).toHaveBeenCalledWith(owned);
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
  });

  it("refuses an endpoint of another organisation", async () => {
    const { service, delivery } = makeWebhooksService(owned);

    await expect(service.sendTestDelivery("org_2", "webhook_1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(delivery.sendTestDelivery).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown endpoint", async () => {
    const { service, delivery } = makeWebhooksService(null);

    await expect(service.sendTestDelivery("org_1", "missing")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(delivery.sendTestDelivery).not.toHaveBeenCalled();
  });

  it.each(["SUSPENDED", "DELETED"])("refuses a %s endpoint", async (status) => {
    const { service, delivery } = makeWebhooksService({ ...owned, status });

    await expect(service.sendTestDelivery("org_1", "webhook_1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(delivery.sendTestDelivery).not.toHaveBeenCalled();
  });
});

describe("WebhooksController.sendTestDelivery authorization", () => {
  function makeController() {
    const webhooksService = {
      sendTestDelivery: jest.fn().mockResolvedValue({ statusClass: "2xx" }),
    };
    const prisma = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ organizations: [{ id: "org_1" }] }),
      },
    };
    const controller = new WebhooksController(
      webhooksService as never,
      prisma as never,
    );
    return { controller, webhooksService, prisma };
  }

  const user = (role: string) => ({
    id: "user_1",
    walletAddress: "G".padEnd(56, "A"),
    walletHash: "hash",
    role,
  });

  it.each(["DEVELOPER", "ADMIN"])("allows %s", async (role) => {
    const { controller, webhooksService } = makeController();

    await controller.sendTestDelivery(user(role), "webhook_1");

    expect(webhooksService.sendTestDelivery).toHaveBeenCalledWith("org_1", "webhook_1");
  });

  it.each(["USER", "MEMBER", "VIEWER", ""])(
    "refuses role %p before touching the database or the network",
    async (role) => {
      const { controller, webhooksService, prisma } = makeController();

      await expect(controller.sendTestDelivery(user(role), "webhook_1")).rejects.toThrow(
        new ForbiddenException(
          "Only DEVELOPER or ADMIN users may send webhook test deliveries",
        ),
      );
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(webhooksService.sendTestDelivery).not.toHaveBeenCalled();
    },
  );

  it("refuses a user with no active organisation", async () => {
    const { controller, webhooksService, prisma } = makeController();
    prisma.user.findUnique.mockResolvedValue({ organizations: [] });

    await expect(
      controller.sendTestDelivery(user("ADMIN"), "webhook_1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(webhooksService.sendTestDelivery).not.toHaveBeenCalled();
  });

  it("keeps the replay role message unchanged", async () => {
    const { controller } = makeController();

    await expect(
      controller.replayDelivery(user("USER"), "delivery_1"),
    ).rejects.toThrow("Only DEVELOPER or ADMIN users may replay webhook deliveries");
  });

  it("is behind the session AuthGuard", () => {
    const guards = Reflect.getMetadata("__guards__", WebhooksController) as unknown[];
    expect(guards).toContain(AuthGuard);
  });

  it("uses the strict rate limiter", () => {
    const handler = WebhooksController.prototype.sendTestDelivery;
    // `@Throttle({ strict: {} })` opts in with the module-configured limit, so
    // the metadata key exists with an undefined (inherit) value.
    expect(Reflect.hasOwnMetadata("THROTTLER:LIMITstrict", handler)).toBe(true);
    expect(Reflect.getMetadata("THROTTLER:SKIPstrict", handler)).toBeUndefined();
    expect(Reflect.getMetadata("THROTTLER:SKIPdefault", handler)).toBe(true);
  });
});

describe("synthetic event type is not subscribable", () => {
  it("rejects webhook.test in an endpoint's event list", async () => {
    const dto = plainToInstance(CreateWebhookDto, {
      url: "https://receiver.example.com/hook",
      events: ["webhook.test"],
    });

    const errors = await validate(dto);

    expect(errors.map((e) => e.property)).toContain("events");
  });
});
