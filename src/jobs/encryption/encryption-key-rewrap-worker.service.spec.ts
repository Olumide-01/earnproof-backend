import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { EncryptionKeyRewrapWorkerService } from "./encryption-key-rewrap-worker.service";
import { PaymentEncryptionRewrapService } from "./payment-encryption-rewrap.service";
import { PrismaService } from "../../database/prisma.service";

describe("EncryptionKeyRewrapWorkerService", () => {
  let service: EncryptionKeyRewrapWorkerService;

  beforeEach(async () => {
    const mockPrisma = {
      $queryRaw: jest.fn(),
    };

    const mockRewrapService = {
      resetStaleProcessing: jest.fn(),
      executeRewrapIntent: jest.fn(),
    };

    const mockConfigService = {
      get: jest.fn().mockReturnValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EncryptionKeyRewrapWorkerService,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
        {
          provide: PaymentEncryptionRewrapService,
          useValue: mockRewrapService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<EncryptionKeyRewrapWorkerService>(
      EncryptionKeyRewrapWorkerService,
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
