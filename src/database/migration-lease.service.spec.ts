import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { MigrationLeaseService } from "./migration-lease.service";
import { PrismaService } from "./prisma.service";

describe("MigrationLeaseService", () => {
  let service: MigrationLeaseService;
  let prismaService: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    const mockPrismaService = {
      $transaction: jest.fn(),
      $queryRaw: jest.fn(),
      migrationLease: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MigrationLeaseService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key) => {
              if (key === "migrationLease.timeoutMs") return 30 * 60 * 1000;
              if (key === "migrationLease.staleTimeoutMs") return 45 * 60 * 1000;
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<MigrationLeaseService>(MigrationLeaseService);
    prismaService = module.get(PrismaService);
  });

  describe("acquireLease", () => {
    it("should successfully acquire lease when no existing lock", async () => {
      const mockTransaction = jest.fn().mockImplementation(async (callback) => {
        return callback({
          $queryRaw: jest.fn().mockResolvedValue([{ pg_try_advisory_lock: true }]),
          migrationLease: {
            upsert: jest.fn().mockResolvedValue({
              id: "migration_deployment",
              ownerId: service.getOwnerId(),
              acquiredAt: new Date(),
              expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            }),
          },
        });
      });

      prismaService.$transaction.mockImplementation(mockTransaction);

      const result = await service.acquireLease("test_migration");

      expect(result.acquired).toBe(true);
      expect(result.ownerId).toBe(service.getOwnerId());
    });

    it("should fail to acquire lease when already held by another process", async () => {
      const existingLease = {
        id: "migration_deployment",
        ownerId: "other-process",
        acquiredAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        isActive: true,
      };

      const mockTransaction = jest.fn().mockImplementation(async (callback) => {
        return callback({
          $queryRaw: jest.fn().mockResolvedValue([{ pg_try_advisory_lock: false }]),
          migrationLease: {
            findUnique: jest.fn().mockResolvedValue(existingLease),
          },
        });
      });

      prismaService.$transaction.mockImplementation(mockTransaction);

      const result = await service.acquireLease("test_migration");

      expect(result.acquired).toBe(false);
      expect(result.reason).toBe("already_held");
      expect(result.currentOwner).toBe("other-process");
    });

    it("should recover stale lease successfully", async () => {
      const staleLease = {
        id: "migration_deployment",
        ownerId: "stale-process",
        acquiredAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
        expiresAt: new Date(Date.now() - 30 * 60 * 1000), // Expired 30 min ago
        isActive: true,
      };

      const mockTransaction = jest.fn().mockImplementation(async (callback) => {
        let callCount = 0;
        return callback({
          $queryRaw: jest.fn().mockImplementation(() => {
            callCount++;
            // First call fails (lock held), second succeeds (after unlock)
            return Promise.resolve([{ pg_try_advisory_lock: callCount > 1 }]);
          }),
          migrationLease: {
            findUnique: jest.fn().mockResolvedValue(staleLease),
            upsert: jest.fn().mockResolvedValue({
              id: "migration_deployment",
              ownerId: service.getOwnerId(),
              acquiredAt: new Date(),
              expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            }),
          },
        });
      });

      prismaService.$transaction.mockImplementation(mockTransaction);

      const result = await service.acquireLease("test_migration");

      expect(result.acquired).toBe(true);
      expect(result.ownerId).toBe(service.getOwnerId());
    });
  });

  describe("releaseLease", () => {
    it("should successfully release lease held by this process", async () => {
      const ownLease = {
        id: "migration_deployment",
        ownerId: service.getOwnerId(),
        acquiredAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        isActive: true,
      };

      const mockTransaction = jest.fn().mockImplementation(async (callback) => {
        return callback({
          $queryRaw: jest.fn().mockResolvedValue(undefined),
          migrationLease: {
            findUnique: jest.fn().mockResolvedValue(ownLease),
            update: jest.fn().mockResolvedValue({
              ...ownLease,
              isActive: false,
            }),
          },
        });
      });

      prismaService.$transaction.mockImplementation(mockTransaction);

      const result = await service.releaseLease("completed");

      expect(result).toBe(true);
    });

    it("should fail to release lease not held by this process", async () => {
      const otherLease = {
        id: "migration_deployment",
        ownerId: "other-process",
        acquiredAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        isActive: true,
      };

      const mockTransaction = jest.fn().mockImplementation(async (callback) => {
        return callback({
          migrationLease: {
            findUnique: jest.fn().mockResolvedValue(otherLease),
          },
        });
      });

      prismaService.$transaction.mockImplementation(mockTransaction);

      const result = await service.releaseLease("completed");

      expect(result).toBe(false);
    });
  });

  describe("getLeaseStatus", () => {
    it("should return not held when no active lease", async () => {
      prismaService.migrationLease.findUnique.mockResolvedValue(null);

      const status = await service.getLeaseStatus();

      expect(status.held).toBe(false);
    });

    it("should return lease details when active lease exists", async () => {
      const activeLease = {
        id: "migration_deployment",
        ownerId: "test-process",
        acquiredAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        migrationState: "running_migrations",
        lastVersion: null,
        isActive: true,
      };

      prismaService.migrationLease.findUnique.mockResolvedValue(activeLease);

      const status = await service.getLeaseStatus();

      expect(status.held).toBe(true);
      expect(status.ownerId).toBe("test-process");
      expect(status.migrationState).toBe("running_migrations");
      expect(status.isStale).toBe(false);
    });
  });
});