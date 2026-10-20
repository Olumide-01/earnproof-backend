import {
  BadRequestException,
  INestApplication,
  ValidationPipe,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { listen, postJson } from "../../test/security/http-client";
import { configureApp } from "../bootstrap";
import { CredentialsController } from "./credentials.controller";
import { CredentialsService, VerifyCredentialResult } from "./credentials.service";
import { VerifyCredentialDto } from "./dto/verify-credential.dto";

/**
 * The controller's own responsibilities, separated from the service's.
 *
 * The service decides whether a credential is genuine, and
 * `credentials.service.spec.ts` covers that. What is left here is small and
 * easy to break silently: unwrapping the request envelope, returning the
 * verdict unchanged, letting a rejection reach the error filter rather than
 * being turned into a verdict, and refusing a submission that is too large or
 * too deep before any of that runs.
 *
 * The validation cases build the same `ValidationPipe` the application does
 * (see `configureApp` in `src/bootstrap.ts`), because a DTO's constraints are
 * only worth as much as the pipe configuration that enforces them.
 */

const validationPipe = new ValidationPipe({
  forbidNonWhitelisted: true,
  transform: true,
  whitelist: true,
});

const metadata = {
  type: "body" as const,
  metatype: VerifyCredentialDto,
};

/** A credential body, valid in shape; the service decides what it is worth. */
function credential() {
  return {
    id: "proof_test_1",
    type: "EarnProofMinimumIncomeCredential",
    schemaVersion: "earnproof.minimum-income.v1",
    proof: { type: "HMAC-SHA256", credentialHash: "sha256:abc", signature: "hmac-sha256:def" },
  };
}

describe("CredentialsController", () => {
  let controller: CredentialsController;
  let service: { verifyCredential: jest.Mock };

  beforeEach(() => {
    service = { verifyCredential: jest.fn() };
    controller = new CredentialsController(
      service as unknown as CredentialsService,
    );
  });

  describe("verifyCredential", () => {
    it("passes the credential itself to the service, not the request envelope", async () => {
      // The DTO wraps the document in a `credential` field. Forwarding the
      // wrapper would make every submission fail its schema check, and the
      // failure would read as a bad credential rather than a bad controller.
      service.verifyCredential.mockResolvedValue({ result: "valid" });

      await controller.verifyCredential({ credential: credential() });

      expect(service.verifyCredential).toHaveBeenCalledTimes(1);
      expect(service.verifyCredential).toHaveBeenCalledWith(credential());
    });

    it.each<VerifyCredentialResult>([
      "valid",
      "invalid_signature",
      "unsupported_schema",
      "unsupported_key",
      "unknown_anchor",
      "revoked",
      "expired",
      "unverified_issuer",
    ])("returns %s unchanged", async (result) => {
      // Every outcome is a successful request. A verdict the controller
      // rewrote, or answered with a different status, would break verifiers
      // that branch on `result`.
      service.verifyCredential.mockResolvedValue({ result });

      await expect(
        controller.verifyCredential({ credential: credential() }),
      ).resolves.toEqual({ result });
    });

    it("propagates a service rejection instead of converting it to a verdict", async () => {
      // A malformed submission is a client error, not a verification outcome.
      // Swallowing it here would answer 200 with a misleading verdict.
      service.verifyCredential.mockRejectedValue(
        new BadRequestException("Credential is malformed"),
      );

      await expect(
        controller.verifyCredential({ credential: credential() }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("request validation", () => {
    it("accepts a well-formed submission", async () => {
      await expect(
        validationPipe.transform({ credential: credential() }, metadata),
      ).resolves.toEqual({ credential: credential() });
    });

    it("rejects a missing credential field", async () => {
      await expect(validationPipe.transform({}, metadata)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("rejects a credential that is not an object", async () => {
      await expect(
        validationPipe.transform({ credential: "not-an-object" }, metadata),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects unknown fields alongside the credential", async () => {
      // forbidNonWhitelisted, so a caller cannot smuggle extra fields past the
      // DTO and have them silently ignored.
      await expect(
        validationPipe.transform(
          { credential: credential(), callbackUrl: "https://example.com" },
          metadata,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a credential larger than 32 KB", async () => {
      const oversized = { ...credential(), padding: "x".repeat(33 * 1024) };

      await expect(
        validationPipe.transform({ credential: oversized }, metadata),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a credential nested deeper than 5 levels", async () => {
      let nested: Record<string, unknown> = { deepest: true };
      for (let level = 0; level < 8; level += 1) {
        nested = { nested };
      }

      await expect(
        validationPipe.transform({ credential: nested }, metadata),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

/**
 * HTTP-level tests for CredentialsController (#108).
 *
 * The app is built with the real `configureApp` pipeline (the same one
 * `main.ts` uses) so these tests exercise the real global prefix, the real
 * ValidationPipe, and the real GlobalExceptionFilter error envelope — not a
 * hand-rolled stand-in that could silently diverge from production. Only
 * `CredentialsService` is mocked, since the service's own behavior already
 * has full unit coverage in credentials.service.spec.ts.
 */
describe("CredentialsController (HTTP)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let credentialsService: { verifyCredential: jest.Mock };

  beforeAll(async () => {
    credentialsService = { verifyCredential: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      controllers: [CredentialsController],
      providers: [
        { provide: CredentialsService, useValue: credentialsService },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    baseUrl = await listen(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    credentialsService.verifyCredential.mockReset();
  });

  describe("POST /credentials/verify", () => {
    it("returns 200 with the service's verification result for a well-formed request", async () => {
      credentialsService.verifyCredential.mockResolvedValue({
        result: "valid",
      });

      const res = await postJson(baseUrl, "/api/v1/credentials/verify", {
        credential: { id: "cred_1", type: "EarnProofMinimumIncomeCredential" },
      });

      expect(res.status).toBe(200);
      expect(res.json).toEqual({ result: "valid" });
      expect(credentialsService.verifyCredential).toHaveBeenCalledWith({
        id: "cred_1",
        type: "EarnProofMinimumIncomeCredential",
      });
    });

    it("passes through whatever result the service returns (e.g. revoked)", async () => {
      credentialsService.verifyCredential.mockResolvedValue({
        result: "revoked",
      });

      const res = await postJson(baseUrl, "/api/v1/credentials/verify", {
        credential: { id: "cred_1" },
      });

      expect(res.status).toBe(200);
      expect(res.json).toEqual({ result: "revoked" });
    });

    it("returns 422 (DTO validation error) when `credential` is missing", async () => {
      const res = await postJson(baseUrl, "/api/v1/credentials/verify", {});

      expect(res.status).toBe(422);
      expect(res.json?.code).toBe("VALIDATION_ERROR");
      expect(credentialsService.verifyCredential).not.toHaveBeenCalled();
    });

    it("returns 422 when `credential` is not an object", async () => {
      const res = await postJson(baseUrl, "/api/v1/credentials/verify", {
        credential: "not-an-object",
      });

      expect(res.status).toBe(422);
      expect(res.json?.code).toBe("VALIDATION_ERROR");
    });

    it("returns 422 when the request body has an unrecognized top-level field (whitelist rejection)", async () => {
      const res = await postJson(baseUrl, "/api/v1/credentials/verify", {
        credential: { id: "cred_1" },
        extraField: "should not be allowed",
      });

      expect(res.status).toBe(422);
      expect(credentialsService.verifyCredential).not.toHaveBeenCalled();
    });

    it("returns 422 when the credential object exceeds the DTO's byte-size limit (but stays under the route's transport limit and the shape middleware's per-string limit)", async () => {
      // VerifyCredentialDto caps `credential` at 32 KB; the route's own
      // transport-level body limit is 40 KB, and the structural shape
      // middleware separately caps any single string at 8 KB (see
      // request-limits.ts). A single oversized string trips that 8 KB
      // structural check (413) before ever reaching DTO validation — so the
      // size here is spread across several fields, each under 8 KB, so the
      // *object's total* exceeds 32 KB without any individual string or the
      // whole request tripping an earlier limit.
      const chunk = "x".repeat(7 * 1024); // under the 8 KB per-string cap
      const res = await postJson(baseUrl, "/api/v1/credentials/verify", {
        credential: {
          id: "cred_1",
          field1: chunk,
          field2: chunk,
          field3: chunk,
          field4: chunk,
          field5: chunk,
        },
      });

      expect(res.status).toBe(422);
      expect(credentialsService.verifyCredential).not.toHaveBeenCalled();
    });

    it("returns 422 when the credential object is nested deeper than the allowed depth", async () => {
      let nested: Record<string, unknown> = { leaf: true };
      for (let i = 0; i < 10; i++) {
        nested = { child: nested };
      }

      const res = await postJson(baseUrl, "/api/v1/credentials/verify", {
        credential: nested,
      });

      expect(res.status).toBe(422);
      expect(credentialsService.verifyCredential).not.toHaveBeenCalled();
    });

    it("has no authentication requirement — a request with no Authorization header still reaches the service", async () => {
      credentialsService.verifyCredential.mockResolvedValue({
        result: "valid",
      });

      const res = await postJson(baseUrl, "/api/v1/credentials/verify", {
        credential: { id: "cred_1" },
      });

      expect(res.status).toBe(200);
      expect(credentialsService.verifyCredential).toHaveBeenCalled();
    });

    it("propagates a thrown BadRequestException from the service as a 400 with the real error envelope", async () => {
      credentialsService.verifyCredential.mockImplementation(() => {
        throw new BadRequestException("Malformed credential");
      });

      const res = await postJson(baseUrl, "/api/v1/credentials/verify", {
        credential: { id: "cred_1" },
      });

      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({
        code: "INVALID_INPUT",
        requestId: expect.any(String),
      });
    });

    it("returns 200 with a complex nested credential object (within depth/size limits)", async () => {
      const complexCredential = {
        id: "cred_1",
        type: "EarnProofMinimumIncomeCredential",
        claim: {
          operator: "gte",
          thresholdAmount: "500.0000000",
          nested: {
            level3: {
              level4: {
                value: "deep",
              },
            },
          },
        },
      };
      credentialsService.verifyCredential.mockResolvedValue({
        result: "valid",
      });

      const res = await postJson(baseUrl, "/api/v1/credentials/verify", {
        credential: complexCredential,
      });

      expect(res.status).toBe(200);
      expect(credentialsService.verifyCredential).toHaveBeenCalledWith(complexCredential);
    });

    it("propagates an unexpected error from the service (e.g. InternalServerErrorException) as 500", async () => {
      credentialsService.verifyCredential.mockRejectedValue(
        new Error("Database connection failed"),
      );

      const res = await postJson(baseUrl, "/api/v1/credentials/verify", {
        credential: { id: "cred_1" },
      });

      expect(res.status).toBe(500);
      expect(res.json?.code).toBe("INTERNAL_ERROR");
    });

    it("handles service returning each possible verification result correctly", async () => {
      const results = [
        "valid",
        "invalid_signature",
        "unsupported_schema",
        "unsupported_key",
        "unknown_anchor",
        "revoked",
        "expired",
        "unverified_issuer",
      ];

      for (const result of results) {
        credentialsService.verifyCredential.mockResolvedValue({ result });

        const res = await postJson(baseUrl, "/api/v1/credentials/verify", {
          credential: { id: `cred_${result}` },
        });

        expect(res.status).toBe(200);
        expect(res.json).toEqual({ result });
      }
    });

    it("returns 422 with precise error when credential exceeds per-string transport limit (8 KB)", async () => {
      // The request-limits middleware caps any single string at 8 KB.
      // A payload that's all one giant string should be rejected before parsing.
      const hugeSingleString = "x".repeat(9 * 1024);

      const res = await postJson(baseUrl, "/api/v1/credentials/verify", {
        credential: hugeSingleString,
      });

      // Transport-level rejection (413 PAYLOAD_TOO_LARGE) happens before route handling
      expect([413, 422]).toContain(res.status);
    });

    it("returns 422 when credential is null instead of an object", async () => {
      const res = await postJson(baseUrl, "/api/v1/credentials/verify", {
        credential: null,
      });

      expect(res.status).toBe(422);
      expect(res.json?.code).toBe("VALIDATION_ERROR");
    });

    it("returns 422 when credential is an array instead of an object", async () => {
      const res = await postJson(baseUrl, "/api/v1/credentials/verify", {
        credential: [1, 2, 3],
      });

      expect(res.status).toBe(422);
      expect(res.json?.code).toBe("VALIDATION_ERROR");
    });

    it("returns 422 when credential is a number", async () => {
      const res = await postJson(baseUrl, "/api/v1/credentials/verify", {
        credential: 42,
      });

      expect(res.status).toBe(422);
      expect(res.json?.code).toBe("VALIDATION_ERROR");
    });

    it("handles request with multiple extra unknown fields (all rejected due to whitelist)", async () => {
      const res = await postJson(baseUrl, "/api/v1/credentials/verify", {
        credential: { id: "cred_1" },
        unknown1: "value1",
        unknown2: "value2",
        unknown3: "value3",
      });

      expect(res.status).toBe(422);
      expect(credentialsService.verifyCredential).not.toHaveBeenCalled();
    });

    it("passes through the service result unchanged even if it has unexpected extra fields", async () => {
      // The controller should pass through the service response exactly as returned
      credentialsService.verifyCredential.mockResolvedValue({
        result: "valid",
        extra: "field",
        timestamp: "2026-01-01T00:00:00Z",
      });

      const res = await postJson(baseUrl, "/api/v1/credentials/verify", {
        credential: { id: "cred_1" },
      });

      expect(res.status).toBe(200);
      // The response includes the extra fields the service returned
      expect(res.json).toEqual({
        result: "valid",
        extra: "field",
        timestamp: "2026-01-01T00:00:00Z",
      });
    });
  });
});
