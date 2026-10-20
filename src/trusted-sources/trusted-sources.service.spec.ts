import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { ResourceStatus } from "@prisma/client";
import { Keypair } from "@stellar/stellar-base";
import { TrustedSourcesService } from "./trusted-sources.service";
import { CreateTrustedSourceDto } from "./dto/create-trusted-source.dto";
import { UpdateTrustedSourceDto } from "./dto/update-trusted-source.dto";

describe("TrustedSourcesService", () => {
  const user = {
    id: "user_1",
    walletAddress: "GB_TEST",
    walletHash: "sha256:wallet",
    role: "WORKER",
  };

  const validStellarAddress = Keypair.fromRawEd25519Seed(
    Buffer.alloc(32, 1),
  ).publicKey();

  describe("createTrustedSource", () => {
    it("creates a new trusted source with normalized address", async () => {
      const prisma = {
        trustedSource: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({
            id: "ts_1",
            userId: user.id,
            sourceAddress: validStellarAddress,
            displayName: "My Employer",
            sourceType: "stellar",
            issuerId: null,
            status: ResourceStatus.ACTIVE,
            createdAt: new Date(),
            updatedAt: new Date(),
            issuer: null,
          }),
        },
        issuer: {
          findUnique: jest.fn(),
        },
        auditLog: {
          create: jest.fn().mockResolvedValue({ id: "audit_1" }),
        },
      };

      const service = new TrustedSourcesService(prisma as never, { reevaluateSource: jest.fn().mockResolvedValue(0) } as never);
      const input: CreateTrustedSourceDto = {
        sourceAddress: validStellarAddress.toLowerCase(),
        displayName: "My Employer",
        sourceType: "stellar",
      };

      const result = await service.createTrustedSource(user, input);

      expect(result.sourceAddress).toBe(validStellarAddress);
      expect(result.displayName).toBe("My Employer");
      expect(prisma.trustedSource.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: user.id,
            sourceAddress: validStellarAddress,
            displayName: "My Employer",
            sourceType: "stellar",
            status: ResourceStatus.ACTIVE,
          }),
        }),
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "trusted_source.created",
            actorId: user.id,
            resourceType: "trusted_source",
          }),
        }),
      );
    });

    it("rejects invalid address format", async () => {
      const prisma = {};
      const service = new TrustedSourcesService(prisma as never, { reevaluateSource: jest.fn().mockResolvedValue(0) } as never);
      const input: CreateTrustedSourceDto = {
        sourceAddress: "invalid_address",
        displayName: "Test",
      };

      await expect(
        service.createTrustedSource(user, input),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects duplicate trusted source address per user", async () => {
      const prisma = {
        trustedSource: {
          findUnique: jest.fn().mockResolvedValue({
            id: "ts_existing",
          }),
        },
        issuer: {
          findUnique: jest.fn(),
        },
      };

      const service = new TrustedSourcesService(prisma as never, { reevaluateSource: jest.fn().mockResolvedValue(0) } as never);
      const input: CreateTrustedSourceDto = {
        sourceAddress: validStellarAddress,
        displayName: "Test",
      };

      await expect(
        service.createTrustedSource(user, input),
      ).rejects.toThrow(
        BadRequestException
      );
      expect(
        prisma.trustedSource.findUnique,
      ).toHaveBeenCalledWith({
        where: {
          userId_sourceAddress: {
            userId: user.id,
            sourceAddress: validStellarAddress,
          },
        },
        select: { id: true },
      });
    });

    it("validates and links issuer if provided", async () => {
      const prisma = {
        trustedSource: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({
            id: "ts_1",
            userId: user.id,
            sourceAddress: validStellarAddress,
            displayName: "Test",
            sourceType: "stellar",
            issuerId: "issuer_1",
            status: ResourceStatus.ACTIVE,
            createdAt: new Date(),
            updatedAt: new Date(),
            issuer: {
              id: "issuer_1",
              status: ResourceStatus.ACTIVE,
              organization: {
                id: "org_1",
                name: "Test Org",
              },
            },
          }),
        },
        issuer: {
          findUnique: jest.fn().mockResolvedValue({
            id: "issuer_1",
            status: ResourceStatus.ACTIVE,
          }),
        },
        auditLog: {
          create: jest.fn().mockResolvedValue({ id: "audit_1" }),
        },
      };

      const service = new TrustedSourcesService(prisma as never, { reevaluateSource: jest.fn().mockResolvedValue(0) } as never);
      const input: CreateTrustedSourceDto = {
        sourceAddress: validStellarAddress,
        displayName: "Test",
        issuerId: "issuer_1",
      };

      const result = await service.createTrustedSource(user, input);

      expect(result.issuer?.id).toBe("issuer_1");
      expect(result.issuer?.isTrusted).toBe(true);
      expect(prisma.issuer.findUnique).toHaveBeenCalledWith({
        where: { id: "issuer_1" },
        select: { id: true, status: true },
      });
    });

    it("rejects non-existent issuer", async () => {
      const prisma = {
        trustedSource: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
        issuer: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      };

      const service = new TrustedSourcesService(prisma as never, { reevaluateSource: jest.fn().mockResolvedValue(0) } as never);
      const input: CreateTrustedSourceDto = {
        sourceAddress: validStellarAddress,
        issuerId: "invalid_issuer",
      };

      await expect(
        service.createTrustedSource(user, input),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects inactive issuer", async () => {
      const prisma = {
        trustedSource: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
        issuer: {
          findUnique: jest.fn().mockResolvedValue({
            id: "issuer_1",
            status: ResourceStatus.SUSPENDED,
          }),
        },
      };

      const service = new TrustedSourcesService(prisma as never, { reevaluateSource: jest.fn().mockResolvedValue(0) } as never);
      const input: CreateTrustedSourceDto = {
        sourceAddress: validStellarAddress,
        issuerId: "issuer_1",
      };

      await expect(
        service.createTrustedSource(user, input),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("listTrustedSources", () => {
    it("lists user's active trusted sources", async () => {
      const prisma = {
        trustedSource: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: "ts_1",
              userId: user.id,
              sourceAddress: validStellarAddress,
              displayName: "Employer 1",
              sourceType: "stellar",
              issuerId: null,
              status: ResourceStatus.ACTIVE,
              createdAt: new Date(),
              updatedAt: new Date(),
              issuer: null,
            },
          ]),
        },
      };

      const service = new TrustedSourcesService(
        prisma as never,
        { reevaluateSource: jest.fn().mockResolvedValue(0) } as never,
      );
      const { data } = await service.listTrustedSources(user, {});

      expect(data).toHaveLength(1);
      expect(data[0].sourceAddress).toBe(validStellarAddress);
      expect(data[0].displayName).toBe("Employer 1");
      expect(prisma.trustedSource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: user.id,
            status: ResourceStatus.ACTIVE,
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        }),
      );
    });

    it("rejects a malformed cursor without querying the database", async () => {
      const prisma = { trustedSource: { findMany: jest.fn() } };
      const service = new TrustedSourcesService(
        prisma as never,
        { reevaluateSource: jest.fn().mockResolvedValue(0) } as never,
      );

      await expect(
        service.listTrustedSources(user, { cursor: "garbage" }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.trustedSource.findMany).not.toHaveBeenCalled();
    });

    it("filters by source address", async () => {
      const prisma = {
        trustedSource: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };

      const service = new TrustedSourcesService(prisma as never, { reevaluateSource: jest.fn().mockResolvedValue(0) } as never);
      await service.listTrustedSources(user, {
        sourceAddress: "GB",
      });

      expect(prisma.trustedSource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            sourceAddress: {
              contains: "GB",
            },
          }),
        }),
      );
    });

    it("filters by source type", async () => {
      const prisma = {
        trustedSource: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };

      const service = new TrustedSourcesService(prisma as never, { reevaluateSource: jest.fn().mockResolvedValue(0) } as never);
      await service.listTrustedSources(user, {
        sourceType: "stellar",
      });

      expect(prisma.trustedSource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            sourceType: "stellar",
          }),
        }),
      );
    });
  });

  describe("getTrustedSource", () => {
    it("returns trusted source owned by user", async () => {
      const prisma = {
        trustedSource: {
          findFirst: jest.fn().mockResolvedValue({
            id: "ts_1",
            userId: user.id,
            sourceAddress: validStellarAddress,
            displayName: "Test",
            sourceType: "stellar",
            issuerId: null,
            status: ResourceStatus.ACTIVE,
            createdAt: new Date(),
            updatedAt: new Date(),
            issuer: null,
          }),
        },
      };

      const service = new TrustedSourcesService(prisma as never, { reevaluateSource: jest.fn().mockResolvedValue(0) } as never);
      const result = await service.getTrustedSource(user, "ts_1");

      expect(result.id).toBe("ts_1");
      expect(prisma.trustedSource.findFirst).toHaveBeenCalledWith({
        where: {
          id: "ts_1",
          userId: user.id,
        },
        include: expect.any(Object),
      });
    });

    it("denies access to trusted source owned by another user", async () => {
      const prisma = {
        trustedSource: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      };

      const service = new TrustedSourcesService(prisma as never, { reevaluateSource: jest.fn().mockResolvedValue(0) } as never);

      await expect(
        service.getTrustedSource(user, "ts_1"),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("updateTrustedSource", () => {
    it("updates display name and issuer", async () => {
      const prisma = {
        trustedSource: {
          findFirst: jest.fn().mockResolvedValue({
            id: "ts_1",
            displayName: "Old Name",
            issuerId: null,
          }),
          update: jest.fn().mockResolvedValue({
            id: "ts_1",
            userId: user.id,
            sourceAddress: validStellarAddress,
            displayName: "New Name",
            sourceType: "stellar",
            issuerId: "issuer_1",
            status: ResourceStatus.ACTIVE,
            createdAt: new Date(),
            updatedAt: new Date(),
            issuer: {
              id: "issuer_1",
              status: ResourceStatus.ACTIVE,
              organization: {
                id: "org_1",
                name: "Test Org",
              },
            },
          }),
        },
        issuer: {
          findUnique: jest.fn().mockResolvedValue({
            id: "issuer_1",
            status: ResourceStatus.ACTIVE,
          }),
        },
        auditLog: {
          create: jest.fn().mockResolvedValue({ id: "audit_1" }),
        },
      };

      const service = new TrustedSourcesService(prisma as never, { reevaluateSource: jest.fn().mockResolvedValue(0) } as never);
      const input: UpdateTrustedSourceDto = {
        displayName: "New Name",
        issuerId: "issuer_1",
      };

      const result = await service.updateTrustedSource(user, "ts_1", input);

      expect(result.displayName).toBe("New Name");
      expect(result.issuer?.id).toBe("issuer_1");
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "trusted_source.updated",
            actorId: user.id,
          }),
        }),
      );
    });

    it("denies access to update trusted source owned by another user", async () => {
      const prisma = {
        trustedSource: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      };

      const service = new TrustedSourcesService(prisma as never, { reevaluateSource: jest.fn().mockResolvedValue(0) } as never);
      const input: UpdateTrustedSourceDto = {
        displayName: "New Name",
      };

      await expect(
        service.updateTrustedSource(user, "ts_1", input),
      ).rejects.toThrow(ForbiddenException);
    });

    it("validates new issuer", async () => {
      const prisma = {
        trustedSource: {
          findFirst: jest.fn().mockResolvedValue({
            id: "ts_1",
            displayName: "Test",
            issuerId: null,
          }),
        },
        issuer: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      };

      const service = new TrustedSourcesService(prisma as never, { reevaluateSource: jest.fn().mockResolvedValue(0) } as never);
      const input: UpdateTrustedSourceDto = {
        issuerId: "invalid_issuer",
      };

      await expect(
        service.updateTrustedSource(user, "ts_1", input),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("deleteTrustedSource", () => {
    it("marks trusted source as deleted", async () => {
      const prisma = {
        trustedSource: {
          findFirst: jest.fn().mockResolvedValue({
            id: "ts_1",
            sourceAddress: validStellarAddress,
          }),
          update: jest.fn().mockResolvedValue({
            id: "ts_1",
            status: ResourceStatus.DELETED,
          }),
        },
        proof: {
          count: jest.fn().mockResolvedValue(0),
        },
        auditLog: {
          create: jest.fn().mockResolvedValue({ id: "audit_1" }),
        },
      };

      const service = new TrustedSourcesService(prisma as never, { reevaluateSource: jest.fn().mockResolvedValue(0) } as never);
      const result = await service.deleteTrustedSource(user, "ts_1");

      expect(result.status).toBe(ResourceStatus.DELETED);
      expect(result.retainedForHistory).toBe(true);
      expect(prisma.trustedSource.update).toHaveBeenCalledWith({
        where: { id: "ts_1" },
        data: {
          status: ResourceStatus.DELETED,
        },
        include: expect.any(Object),
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "trusted_source.deleted",
            actorId: user.id,
            metadata: expect.objectContaining({
              sourceAddressHash: expect.any(String),
              retentionPolicy: "soft_delete",
            }),
          }),
        }),
      );
    });

    it("denies access to delete trusted source owned by another user", async () => {
      const prisma = {
        trustedSource: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      };

      const service = new TrustedSourcesService(prisma as never, { reevaluateSource: jest.fn().mockResolvedValue(0) } as never);

      await expect(
        service.deleteTrustedSource(user, "ts_1"),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("address normalization", () => {
    it("normalizes address to uppercase", async () => {
      const prisma = {
        trustedSource: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({
            id: "ts_1",
            userId: user.id,
            sourceAddress: validStellarAddress,
            displayName: "Test",
            sourceType: "stellar",
            issuerId: null,
            status: ResourceStatus.ACTIVE,
            createdAt: new Date(),
            updatedAt: new Date(),
            issuer: null,
          }),
        },
        issuer: {
          findUnique: jest.fn(),
        },
        auditLog: {
          create: jest.fn().mockResolvedValue({ id: "audit_1" }),
        },
      };

      const service = new TrustedSourcesService(prisma as never, { reevaluateSource: jest.fn().mockResolvedValue(0) } as never);
      const input: CreateTrustedSourceDto = {
        sourceAddress: validStellarAddress.toLowerCase(),
        displayName: "Test",
      };

      await service.createTrustedSource(user, input);

      expect(prisma.trustedSource.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sourceAddress: validStellarAddress,
          }),
        }),
      );
    });

    it("trims whitespace from address", async () => {
      const prisma = {
        trustedSource: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({
            id: "ts_1",
            userId: user.id,
            sourceAddress: validStellarAddress,
            displayName: "Test",
            sourceType: "stellar",
            issuerId: null,
            status: ResourceStatus.ACTIVE,
            createdAt: new Date(),
            updatedAt: new Date(),
            issuer: null,
          }),
        },
        issuer: {
          findUnique: jest.fn(),
        },
        auditLog: {
          create: jest.fn().mockResolvedValue({ id: "audit_1" }),
        },
      };

      const service = new TrustedSourcesService(prisma as never, { reevaluateSource: jest.fn().mockResolvedValue(0) } as never);
      const input: CreateTrustedSourceDto = {
        sourceAddress: `  ${validStellarAddress}  `,
        displayName: "Test",
      };

      await service.createTrustedSource(user, input);

      expect(prisma.trustedSource.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sourceAddress: validStellarAddress,
          }),
        }),
      );
    });
  });

  describe("eligibility re-evaluation", () => {
    const record = {
      id: "ts_1",
      userId: user.id,
      sourceAddress: validStellarAddress,
      displayName: "Employer",
      sourceType: "stellar",
      issuerId: null,
      status: ResourceStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date(),
      issuer: null,
    };

    function setup(existing: Record<string, unknown> = { id: "ts_1", displayName: "Employer", issuerId: null, sourceAddress: validStellarAddress }) {
      const prisma = {
        trustedSource: {
          findUnique: jest.fn().mockResolvedValue(null),
          findFirst: jest.fn().mockResolvedValue(existing),
          create: jest.fn().mockResolvedValue(record),
          update: jest.fn(({ data }) => Promise.resolve({ ...record, ...data })),
        },
        issuer: {
          findUnique: jest.fn().mockResolvedValue({ id: "iss_1", status: ResourceStatus.ACTIVE }),
        },
        auditLog: { create: jest.fn().mockResolvedValue({}) },
      };
      const eligibility = { reevaluateSource: jest.fn().mockResolvedValue(1) };
      return { eligibility, service: new TrustedSourcesService(prisma as never, eligibility as never) };
    }

    it("re-evaluates the sender's payments when a trusted source is created", async () => {
      const { eligibility, service } = setup();
      await service.createTrustedSource(user, { sourceAddress: validStellarAddress.toLowerCase() });
      expect(eligibility.reevaluateSource).toHaveBeenCalledWith(user.id, validStellarAddress);
    });

    it("re-evaluates when the issuer link changes", async () => {
      const { eligibility, service } = setup();
      await service.updateTrustedSource(user, "ts_1", { issuerId: "iss_1" });
      expect(eligibility.reevaluateSource).toHaveBeenCalledWith(user.id, validStellarAddress);
    });

    it("does not re-evaluate for a display-name-only change", async () => {
      const { eligibility, service } = setup();
      await service.updateTrustedSource(user, "ts_1", { displayName: "Renamed" });
      expect(eligibility.reevaluateSource).not.toHaveBeenCalled();
    });

    it("re-evaluates when a trusted source is deleted", async () => {
      const { eligibility, service } = setup();
      await service.deleteTrustedSource(user, "ts_1");
      expect(eligibility.reevaluateSource).toHaveBeenCalledWith(user.id, validStellarAddress);
    });

    it("does not re-evaluate anything for another user's trusted source", async () => {
      const { eligibility, service } = setup(null as never);
      await expect(service.deleteTrustedSource(user, "ts_1")).rejects.toBeInstanceOf(ForbiddenException);
      expect(eligibility.reevaluateSource).not.toHaveBeenCalled();
    });
  });
});
