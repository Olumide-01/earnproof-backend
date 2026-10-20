import { HttpStatus, ServiceUnavailableException } from "@nestjs/common";
import type { Request, Response } from "express";
import {
  buildDeploymentMetadataDocument,
  loadDeploymentManifest,
  sealDeploymentMetadata,
  verifyDeploymentMetadata,
} from "../config/deployment-manifest";
import {
  DEPLOYMENT_METADATA_CACHE_CONTROL,
  HealthController,
} from "./health.controller";
import { HealthService } from "./health.service";
import { DependencyKind, DependencyStatus } from "./health.types";

function buildService(overrides: Partial<HealthService> = {}): HealthService {
  return {
    checkLiveness: jest.fn().mockReturnValue({
      status: "ok",
      service: "earnproof-api",
      timestamp: new Date().toISOString(),
    }),
    checkReadiness: jest.fn().mockResolvedValue({
      status: "ready",
      dependencies: [
        {
          name: "database",
          kind: DependencyKind.REQUIRED,
          status: DependencyStatus.OK,
        },
      ],
    }),
    checkDiagnostics: jest.fn().mockResolvedValue({
      status: "ready",
      dependencies: [],
    }),
    ...overrides,
  } as unknown as HealthService;
}

describe("HealthController", () => {
  describe("legacy aggregate endpoint", () => {
    // The existing /health contract is relied on by deployments and compose
    // healthchecks, so its shape must not drift.
    it("returns service health", async () => {
      const controller = new HealthController(buildService());

      await expect(controller.getHealth()).resolves.toMatchObject({
        status: "ok",
        service: "earnproof-api",
        database: "ok",
      });
    });

    it("reports unavailable when the database dependency is unhealthy", async () => {
      const controller = new HealthController(
        buildService({
          checkReadiness: jest.fn().mockResolvedValue({
            status: "not_ready",
            dependencies: [
              {
                name: "database",
                kind: DependencyKind.REQUIRED,
                status: DependencyStatus.ERROR,
                reason: "probe_failed",
              },
            ],
          }),
        } as Partial<HealthService>),
      );

      await expect(controller.getHealth()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe("liveness", () => {
    it("reports process availability", () => {
      const controller = new HealthController(buildService());

      expect(controller.getLiveness()).toMatchObject({
        status: "ok",
        service: "earnproof-api",
      });
    });

    it("does not consult readiness or any dependency", () => {
      const service = buildService();
      const controller = new HealthController(service);

      controller.getLiveness();

      // Liveness must never fail because a dependency is down; if it did, an
      // outage would cause the orchestrator to restart healthy replicas.
      expect(service.checkReadiness).not.toHaveBeenCalled();
      expect(service.checkDiagnostics).not.toHaveBeenCalled();
    });
  });

  describe("readiness", () => {
    it("returns the readiness payload when required dependencies are healthy", async () => {
      const controller = new HealthController(buildService());

      await expect(controller.getReadiness()).resolves.toMatchObject({
        status: "ready",
      });
    });

    it("throws 503 and includes which dependency blocked readiness", async () => {
      const notReady = {
        status: "not_ready",
        dependencies: [
          {
            name: "database",
            kind: DependencyKind.REQUIRED,
            status: DependencyStatus.TIMEOUT,
            reason: "probe_timeout",
          },
        ],
      };

      const controller = new HealthController(
        buildService({
          checkReadiness: jest.fn().mockResolvedValue(notReady),
        } as Partial<HealthService>),
      );

      await expect(controller.getReadiness()).rejects.toMatchObject({
        response: notReady,
      });
    });
  });

  describe("diagnostics", () => {
    it("returns the full dependency set", async () => {
      const diagnostics = {
        status: "ready",
        dependencies: [
          {
            name: "horizon",
            kind: DependencyKind.OPTIONAL,
            status: DependencyStatus.OK,
          },
        ],
      };

      const controller = new HealthController(
        buildService({
          checkDiagnostics: jest.fn().mockResolvedValue(diagnostics),
        } as Partial<HealthService>),
      );

      await expect(controller.getDiagnostics()).resolves.toEqual(diagnostics);
    });

    it("returns 200 even when a dependency is degraded", async () => {
      // Diagnostics is an inspection surface. Returning 503 here would tempt
      // operators to point load balancers at it, recreating the conflation of
      // liveness/readiness this module exists to remove.
      const controller = new HealthController(
        buildService({
          checkDiagnostics: jest.fn().mockResolvedValue({
            status: "not_ready",
            dependencies: [
              {
                name: "database",
                kind: DependencyKind.REQUIRED,
                status: DependencyStatus.ERROR,
              },
            ],
          }),
        } as Partial<HealthService>),
      );

      await expect(controller.getDiagnostics()).resolves.toMatchObject({
        status: "not_ready",
      });
    });
  });

  describe("deployment metadata", () => {
    const TESTNET = "Test SDF Network ; September 2015";

    function envelope() {
      const loaded = loadDeploymentManifest(
        JSON.stringify({
          schemaVersion: 1,
          deploymentVersion: "2026.09.1",
          network: "testnet",
          networkPassphrase: TESTNET,
          contracts: {
            proof_registry: {
              address: `C${"A".repeat(55)}`,
              network: "testnet",
              wasmHash: "a".repeat(64),
            },
          },
        }),
        {
          network: "testnet",
          networkPassphrase: TESTNET,
          configuredContracts: {},
        },
      );
      if (loaded.status !== "valid") throw new Error("fixture invalid");
      return sealDeploymentMetadata(
        buildDeploymentMetadataDocument(loaded.manifest),
      );
    }

    function httpPair(ifNoneMatch?: string) {
      const headers: Record<string, string> = {};
      const response = {
        setHeader: jest.fn((name: string, value: string) => {
          headers[name] = value;
        }),
        status: jest.fn(),
      };
      const request = {
        headers:
          ifNoneMatch === undefined ? {} : { "if-none-match": ifNoneMatch },
      };
      return {
        request: request as unknown as Request,
        response: response as unknown as Response,
        headers,
        status: response.status,
      };
    }

    function controllerWith(state: unknown) {
      return new HealthController(
        buildService({
          deploymentMetadata: jest.fn().mockReturnValue(state),
        } as Partial<HealthService>),
      );
    }

    it("returns the verifiable envelope with ETag and cache headers", () => {
      const sealed = envelope();
      const { request, response, headers, status } = httpPair();

      const body = controllerWith({
        status: "valid",
        envelope: sealed,
      }).getDeploymentMetadata(request, response);

      expect(body).toBe(sealed);
      expect(verifyDeploymentMetadata(sealed)).toBe(true);
      expect(headers.ETag).toBe(`"${sealed.integrity.digest}"`);
      expect(headers["Cache-Control"]).toBe(DEPLOYMENT_METADATA_CACHE_CONTROL);
      expect(status).not.toHaveBeenCalled();
    });

    it.each([
      ["an exact match", (etag: string) => etag],
      ["a weak validator", (etag: string) => `W/${etag}`],
      ["a list containing it", (etag: string) => `"other", ${etag}`],
      ["a wildcard", () => "*"],
    ])("answers 304 with no body for %s", (_label, header) => {
      const sealed = envelope();
      const { request, response, headers, status } = httpPair(
        header(`"${sealed.integrity.digest}"`),
      );

      const body = controllerWith({
        status: "valid",
        envelope: sealed,
      }).getDeploymentMetadata(request, response);

      expect(body).toBeUndefined();
      expect(status).toHaveBeenCalledWith(HttpStatus.NOT_MODIFIED);
      expect(headers.ETag).toBe(`"${sealed.integrity.digest}"`);
    });

    it("serves the full body when the ETag is stale", () => {
      const sealed = envelope();
      const { request, response, status } = httpPair(`"${"0".repeat(64)}"`);

      const body = controllerWith({
        status: "valid",
        envelope: sealed,
      }).getDeploymentMetadata(request, response);

      expect(body).toBe(sealed);
      expect(status).not.toHaveBeenCalled();
    });

    it.each([
      ["an invalid manifest", { status: "invalid", reasons: ["manifest_network_drift"] }],
      ["no manifest", { status: "absent" }],
    ])("answers 503 without caching headers for %s", (_label, state) => {
      const { request, response, headers } = httpPair();

      expect(() =>
        controllerWith(state).getDeploymentMetadata(request, response),
      ).toThrow(ServiceUnavailableException);
      // An unavailable document must not be cacheable under an old ETag.
      expect(headers.ETag).toBeUndefined();
      expect(headers["Cache-Control"]).toBeUndefined();
    });
  });
});
