import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  INestApplication,
  UnauthorizedException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Request } from "express";
import * as request from "supertest";
import { configureApp } from "../bootstrap";
import { AuthGuard } from "../common/guards/auth.guard";
import { AuthenticatedSession, AuthenticatedUser } from "../auth/auth.types";
import { TrustedSourcesController } from "./trusted-sources.controller";
import { TrustedSourcesService } from "./trusted-sources.service";

/**
 * HTTP-level tests for TrustedSourcesController (#108).
 *
 * `AuthGuard` does real session/DB lookups that already have their own
 * coverage elsewhere; what this file cares about is the CONTROLLER's own
 * behavior for each guard/service outcome, so `AuthGuard` is replaced with a
 * lightweight fake driven by a test marker header, and `TrustedSourcesService`
 * is a full mock (its own logic has its own spec file).
 */
describe("TrustedSourcesController (HTTP)", () => {
  let app: INestApplication;
  let service: {
    createTrustedSource: jest.Mock;
    listTrustedSources: jest.Mock;
    getTrustedSource: jest.Mock;
    updateTrustedSource: jest.Mock;
    deleteTrustedSource: jest.Mock;
  };

  const AUTHENTICATED_USER: AuthenticatedUser = {
    id: "user_1",
    walletAddress: "G".padEnd(56, "A"),
    walletHash: "sha256:abc",
    role: "WORKER",
  };
  // AuthGuard actually sets req.user to an AuthenticatedSession (adds
  // sessionId on top of AuthenticatedUser) — matched here so the fake guard
  // satisfies the same Express.Request type augmentation the real one does.
  const AUTHENTICATED_SESSION: AuthenticatedSession = {
    ...AUTHENTICATED_USER,
    sessionId: "session_1",
  };

  /** A fake AuthGuard: authenticates unless a test marker header says not to. */
  class FakeAuthGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest<Request>();
      if (req.headers["x-test-unauthenticated"] === "true") {
        throw new UnauthorizedException("Missing bearer token");
      }
      req.user = AUTHENTICATED_SESSION;
      return true;
    }
  }

  beforeAll(async () => {
    service = {
      createTrustedSource: jest.fn(),
      listTrustedSources: jest.fn(),
      getTrustedSource: jest.fn(),
      updateTrustedSource: jest.fn(),
      deleteTrustedSource: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [TrustedSourcesController],
      providers: [{ provide: TrustedSourcesService, useValue: service }],
    })
      .overrideGuard(AuthGuard)
      .useValue(new FakeAuthGuard())
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    Object.values(service).forEach((fn) => fn.mockReset());
  });

  const TRUSTED_SOURCE = {
    id: "ts_abc123",
    sourceAddress: "G".padEnd(56, "B"),
    displayName: "My Employer Account",
    sourceType: "stellar",
    issuer: null,
    status: "ACTIVE",
    createdAt: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
  };

  describe("POST /trusted-sources", () => {
    it("returns 201 and the created resource for a valid authenticated request", async () => {
      service.createTrustedSource.mockResolvedValue(TRUSTED_SOURCE);

      const res = await request(app.getHttpServer())
        .post("/api/v1/trusted-sources")
        .send({ sourceAddress: TRUSTED_SOURCE.sourceAddress });

      expect(res.status).toBe(201);
      expect(res.body).toEqual(TRUSTED_SOURCE);
      expect(service.createTrustedSource).toHaveBeenCalledWith(
        AUTHENTICATED_SESSION,
        expect.objectContaining({ sourceAddress: TRUSTED_SOURCE.sourceAddress }),
      );
    });

    it("returns 401 when the caller is not authenticated", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/trusted-sources")
        .set("x-test-unauthenticated", "true")
        .send({ sourceAddress: TRUSTED_SOURCE.sourceAddress });

      expect(res.status).toBe(401);
      expect(service.createTrustedSource).not.toHaveBeenCalled();
    });

    it("returns 422 (DTO validation error) when sourceAddress is missing", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/trusted-sources")
        .send({});

      expect(res.status).toBe(422);
      expect(service.createTrustedSource).not.toHaveBeenCalled();
    });

    it("returns 422 when sourceType is not one of the allowed values", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/trusted-sources")
        .send({
          sourceAddress: TRUSTED_SOURCE.sourceAddress,
          sourceType: "not-a-real-type",
        });

      expect(res.status).toBe(422);
      expect(service.createTrustedSource).not.toHaveBeenCalled();
    });

    it("propagates a BadRequestException from the service as 400 (e.g. invalid address / duplicate)", async () => {
      service.createTrustedSource.mockRejectedValue(
        new BadRequestException(
          "A trusted source with this address already exists for your account.",
        ),
      );

      const res = await request(app.getHttpServer())
        .post("/api/v1/trusted-sources")
        .send({ sourceAddress: TRUSTED_SOURCE.sourceAddress });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_INPUT");
    });
  });

  describe("GET /trusted-sources", () => {
    it("returns 200 with the user's trusted sources", async () => {
      service.listTrustedSources.mockResolvedValue({
        data: [TRUSTED_SOURCE],
        pageInfo: { hasMore: false, nextCursor: null },
      });

      const res = await request(app.getHttpServer()).get(
        "/api/v1/trusted-sources",
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: [TRUSTED_SOURCE],
        pageInfo: { hasMore: false, nextCursor: null },
      });
      expect(service.listTrustedSources).toHaveBeenCalledWith(
        AUTHENTICATED_SESSION,
        expect.objectContaining({}),
      );
    });

    it("passes query filters through to the service", async () => {
      service.listTrustedSources.mockResolvedValue({
        data: [],
        pageInfo: { hasMore: false, nextCursor: null },
      });

      await request(app.getHttpServer())
        .get("/api/v1/trusted-sources")
        .query({ sourceType: "stellar" });

      expect(service.listTrustedSources).toHaveBeenCalledWith(
        AUTHENTICATED_SESSION,
        expect.objectContaining({ sourceType: "stellar" }),
      );
    });

    it("returns 401 when the caller is not authenticated", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/trusted-sources")
        .set("x-test-unauthenticated", "true");

      expect(res.status).toBe(401);
      expect(service.listTrustedSources).not.toHaveBeenCalled();
    });
  });

  describe("GET /trusted-sources/:id", () => {
    it("returns 200 with the trusted source when owned by the caller", async () => {
      service.getTrustedSource.mockResolvedValue(TRUSTED_SOURCE);

      const res = await request(app.getHttpServer()).get(
        "/api/v1/trusted-sources/ts_abc123",
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual(TRUSTED_SOURCE);
    });

    it("returns 403 when the service reports the resource belongs to another user", async () => {
      service.getTrustedSource.mockRejectedValue(
        new ForbiddenException(
          "You do not have access to this trusted source.",
        ),
      );

      const res = await request(app.getHttpServer()).get(
        "/api/v1/trusted-sources/ts_other_user",
      );

      expect(res.status).toBe(403);
    });

    it("returns 401 when the caller is not authenticated", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/trusted-sources/ts_abc123")
        .set("x-test-unauthenticated", "true");

      expect(res.status).toBe(401);
      expect(service.getTrustedSource).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /trusted-sources/:id", () => {
    it("returns 200 with the updated resource", async () => {
      const updated = { ...TRUSTED_SOURCE, displayName: "Updated Name" };
      service.updateTrustedSource.mockResolvedValue(updated);

      const res = await request(app.getHttpServer())
        .patch("/api/v1/trusted-sources/ts_abc123")
        .send({ displayName: "Updated Name" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(updated);
      expect(service.updateTrustedSource).toHaveBeenCalledWith(
        AUTHENTICATED_SESSION,
        "ts_abc123",
        expect.objectContaining({ displayName: "Updated Name" }),
      );
    });

    it("returns 403 when updating a trusted source belonging to another user", async () => {
      service.updateTrustedSource.mockRejectedValue(
        new ForbiddenException(
          "You do not have access to this trusted source.",
        ),
      );

      const res = await request(app.getHttpServer())
        .patch("/api/v1/trusted-sources/ts_other_user")
        .send({ displayName: "Updated Name" });

      expect(res.status).toBe(403);
    });

    it("returns 401 when the caller is not authenticated", async () => {
      const res = await request(app.getHttpServer())
        .patch("/api/v1/trusted-sources/ts_abc123")
        .set("x-test-unauthenticated", "true")
        .send({ displayName: "Updated Name" });

      expect(res.status).toBe(401);
      expect(service.updateTrustedSource).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /trusted-sources/:id", () => {
    it("returns 200 with the deletion result", async () => {
      service.deleteTrustedSource.mockResolvedValue({
        id: "ts_abc123",
        status: "DELETED",
        retainedForHistory: true,
      });

      const res = await request(app.getHttpServer()).delete(
        "/api/v1/trusted-sources/ts_abc123",
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: "ts_abc123",
        status: "DELETED",
        retainedForHistory: true,
      });
    });

    it("returns 403 when deleting a trusted source belonging to another user", async () => {
      service.deleteTrustedSource.mockRejectedValue(
        new ForbiddenException(
          "You do not have access to this trusted source.",
        ),
      );

      const res = await request(app.getHttpServer()).delete(
        "/api/v1/trusted-sources/ts_other_user",
      );

      expect(res.status).toBe(403);
    });

    it("returns 401 when the caller is not authenticated", async () => {
      const res = await request(app.getHttpServer())
        .delete("/api/v1/trusted-sources/ts_abc123")
        .set("x-test-unauthenticated", "true");

      expect(res.status).toBe(401);
      expect(service.deleteTrustedSource).not.toHaveBeenCalled();
    });

    it("passes the correct user and ID to the service", async () => {
      service.deleteTrustedSource.mockResolvedValue({
        id: "ts_abc123",
        status: "DELETED",
      });

      await request(app.getHttpServer()).delete("/api/v1/trusted-sources/ts_abc123");

      expect(service.deleteTrustedSource).toHaveBeenCalledWith(
        AUTHENTICATED_SESSION,
        "ts_abc123",
      );
    });

    it("propagates an unhandled service error as 500", async () => {
      service.deleteTrustedSource.mockRejectedValue(
        new Error("Unexpected database error"),
      );

      const res = await request(app.getHttpServer()).delete(
        "/api/v1/trusted-sources/ts_abc123",
      );

      expect(res.status).toBe(500);
    });
  });

  describe("Request body validation and response DTO transformation", () => {
    it("POST accepts displayName as optional string", async () => {
      service.createTrustedSource.mockResolvedValue(TRUSTED_SOURCE);

      const res = await request(app.getHttpServer())
        .post("/api/v1/trusted-sources")
        .send({
          sourceAddress: TRUSTED_SOURCE.sourceAddress,
          displayName: "Custom Name",
        });

      expect(res.status).toBe(201);
      expect(service.createTrustedSource).toHaveBeenCalledWith(
        AUTHENTICATED_SESSION,
        expect.objectContaining({ displayName: "Custom Name" }),
      );
    });

    it("POST rejects if sourceAddress exceeds max length", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/trusted-sources")
        .send({
          sourceAddress: "G" + "X".repeat(200), // Way too long
        });

      expect(res.status).toBe(422);
      expect(service.createTrustedSource).not.toHaveBeenCalled();
    });

    it("POST rejects if displayName exceeds max length (120 chars)", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/trusted-sources")
        .send({
          sourceAddress: TRUSTED_SOURCE.sourceAddress,
          displayName: "X".repeat(121),
        });

      expect(res.status).toBe(422);
    });

    it("POST rejects if sourceType is not 'stellar' or missing", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/trusted-sources")
        .send({
          sourceAddress: TRUSTED_SOURCE.sourceAddress,
          sourceType: "invalid-type",
        });

      expect(res.status).toBe(422);
    });

    it("POST rejects if issuerId is empty string", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/trusted-sources")
        .send({
          sourceAddress: TRUSTED_SOURCE.sourceAddress,
          issuerId: "",
        });

      expect(res.status).toBe(422);
    });

    it("PATCH accepts displayName for update", async () => {
      const updated = { ...TRUSTED_SOURCE, displayName: "New Name" };
      service.updateTrustedSource.mockResolvedValue(updated);

      const res = await request(app.getHttpServer())
        .patch("/api/v1/trusted-sources/ts_abc123")
        .send({ displayName: "New Name" });

      expect(res.status).toBe(200);
      expect(res.body.displayName).toBe("New Name");
    });

    it("PATCH accepts issuerId for update", async () => {
      const updated = { ...TRUSTED_SOURCE, issuer: { id: "issuer_new" } };
      service.updateTrustedSource.mockResolvedValue(updated);

      const res = await request(app.getHttpServer())
        .patch("/api/v1/trusted-sources/ts_abc123")
        .send({ issuerId: "issuer_new" });

      expect(res.status).toBe(200);
      expect(service.updateTrustedSource).toHaveBeenCalledWith(
        AUTHENTICATED_SESSION,
        "ts_abc123",
        expect.objectContaining({ issuerId: "issuer_new" }),
      );
    });

    it("PATCH rejects if displayName exceeds max length", async () => {
      const res = await request(app.getHttpServer())
        .patch("/api/v1/trusted-sources/ts_abc123")
        .send({ displayName: "X".repeat(121) });

      expect(res.status).toBe(422);
    });

    it("PATCH rejects if issuerId is empty string", async () => {
      const res = await request(app.getHttpServer())
        .patch("/api/v1/trusted-sources/ts_abc123")
        .send({ issuerId: "" });

      expect(res.status).toBe(422);
    });

    it("GET list propagates service error as 500", async () => {
      service.listTrustedSources.mockRejectedValue(
        new Error("Database error"),
      );

      const res = await request(app.getHttpServer()).get(
        "/api/v1/trusted-sources",
      );

      expect(res.status).toBe(500);
    });

    it("GET by ID propagates unhandled service errors", async () => {
      service.getTrustedSource.mockRejectedValue(
        new Error("Unexpected error"),
      );

      const res = await request(app.getHttpServer()).get(
        "/api/v1/trusted-sources/ts_abc123",
      );

      expect(res.status).toBe(500);
    });

    it("POST rejects requests with unknown fields (whitelist)", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/trusted-sources")
        .send({
          sourceAddress: TRUSTED_SOURCE.sourceAddress,
          unknownField: "should-not-be-allowed",
        });

      expect(res.status).toBe(422);
    });

    it("PATCH rejects requests with unknown fields", async () => {
      const res = await request(app.getHttpServer())
        .patch("/api/v1/trusted-sources/ts_abc123")
        .send({
          displayName: "New Name",
          unknownField: "should-not-be-allowed",
        });

      expect(res.status).toBe(422);
    });

    it("GET filters are passed correctly to service", async () => {
      service.listTrustedSources.mockResolvedValue([]);

      await request(app.getHttpServer())
        .get("/api/v1/trusted-sources")
        .query({ sourceAddress: "GB", sourceType: "stellar" });

      expect(service.listTrustedSources).toHaveBeenCalledWith(
        AUTHENTICATED_SESSION,
        expect.objectContaining({ sourceAddress: "GB", sourceType: "stellar" }),
      );
    });
  });

  describe("HTTP method & status codes", () => {
    it("POST /trusted-sources creates a new resource (201)", async () => {
      service.createTrustedSource.mockResolvedValue(TRUSTED_SOURCE);

      const res = await request(app.getHttpServer())
        .post("/api/v1/trusted-sources")
        .send({ sourceAddress: TRUSTED_SOURCE.sourceAddress });

      expect(res.status).toBe(201);
    });

    it("GET /trusted-sources returns list (200)", async () => {
      service.listTrustedSources.mockResolvedValue([TRUSTED_SOURCE]);

      const res = await request(app.getHttpServer()).get(
        "/api/v1/trusted-sources",
      );

      expect(res.status).toBe(200);
    });

    it("GET /trusted-sources/:id returns resource (200)", async () => {
      service.getTrustedSource.mockResolvedValue(TRUSTED_SOURCE);

      const res = await request(app.getHttpServer()).get(
        "/api/v1/trusted-sources/ts_abc123",
      );

      expect(res.status).toBe(200);
    });

    it("PATCH /trusted-sources/:id updates resource (200)", async () => {
      service.updateTrustedSource.mockResolvedValue(TRUSTED_SOURCE);

      const res = await request(app.getHttpServer())
        .patch("/api/v1/trusted-sources/ts_abc123")
        .send({ displayName: "Updated" });

      expect(res.status).toBe(200);
    });

    it("DELETE /trusted-sources/:id deletes resource (200)", async () => {
      service.deleteTrustedSource.mockResolvedValue({
        id: "ts_abc123",
        status: "DELETED",
      });

      const res = await request(app.getHttpServer()).delete(
        "/api/v1/trusted-sources/ts_abc123",
      );

      expect(res.status).toBe(200);
    });
  });
});
