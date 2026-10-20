import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { EncryptionKeyRetirementWorkerService } from "./encryption-key-retirement-worker.service";
import { PaymentEncryptionRetirementService } from "./payment-encryption-retirement.service";
import { PrismaService } from "../../database/prisma.service";

describe("EncryptionKeyRetirementWorkerService", () => {
  let service: EncryptionKeyRetirementWorkerService;

  beforeEach(async () => {
    const mockPrisma = {
      $queryRaw: jest.fn(),
    };

    const mockRetirementService = {
      resetStaleGuarding: jest.fn(),
      executeRetirementIntent: jest.fn(),
    };

    const mockConfigService = {
      get: jest.fn().mockReturnValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EncryptionKeyRetirementWorkerService,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
        {
          provide: PaymentEncryptionRetirementService,
          useValue: mockRetirementService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<EncryptionKeyRetirementWorkerService>(
      EncryptionKeyRetirementWorkerService,
    );
  });

  describe("service initialization", () => {
    it("should be defined", () => {
      expect(service).toBeDefined();
    });

    it("should have poll method", () => {
      expect(service.poll).toBeDefined();
    });

    it("should have processIntent method", () => {
      expect(service.processIntent).toBeDefined();
    });

    it("should have onApplicationShutdown method", () => {
      expect(service.onApplicationShutdown).toBeDefined();
    });
  });
});
