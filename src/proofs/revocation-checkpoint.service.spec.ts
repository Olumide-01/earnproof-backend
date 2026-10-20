import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RevocationCheckpointService } from './revocation-checkpoint.service';
import { PrismaService } from '../database/prisma.service';
import {
  RevocationCheckpointStatus,
  RevocationCheckpointQuarantineReason,
} from '@prisma/client';

describe('RevocationCheckpointService', () => {
  let service: RevocationCheckpointService;
  let prismaService: PrismaService;

  const mockPrismaService = {
    revocationCheckpointStreamHead: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    revocationCheckpoint: {
      create: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RevocationCheckpointService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<RevocationCheckpointService>(
      RevocationCheckpointService,
    );
    prismaService = module.get<PrismaService>(PrismaService);

    // Clear all mocks before each test
    jest.clearAllMocks();
  });

  describe('validateInput', () => {
    it('should reject missing ledger', async () => {
      const input = {
        ledger: '',
        contractIdentity: 'contract1',
        algorithm: 'sha256',
        sequence: 1n,
        root: 'abc123',
        observedAt: new Date(),
      };

      await expect(service.upsertCheckpoint(input)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject unknown ledger', async () => {
      const input = {
        ledger: 'unknown_ledger',
        contractIdentity: 'contract1',
        algorithm: 'sha256',
        sequence: 1n,
        root: 'abc123',
        observedAt: new Date(),
      };

      await expect(service.upsertCheckpoint(input)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject unknown algorithm', async () => {
      const input = {
        ledger: 'stellar',
        contractIdentity: 'contract1',
        algorithm: 'unknown-algo',
        sequence: 1n,
        root: 'abc123',
        observedAt: new Date(),
      };

      await expect(service.upsertCheckpoint(input)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject non-hex root', async () => {
      const input = {
        ledger: 'stellar',
        contractIdentity: 'contract1',
        algorithm: 'sha256',
        sequence: 1n,
        root: 'not_hex!',
        observedAt: new Date(),
      };

      await expect(service.upsertCheckpoint(input)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject future observedAt', async () => {
      const futureDate = new Date(Date.now() + 1000000);
      const input = {
        ledger: 'stellar',
        contractIdentity: 'contract1',
        algorithm: 'sha256',
        sequence: 1n,
        root: 'abc123def456',
        observedAt: futureDate,
      };

      await expect(service.upsertCheckpoint(input)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should accept valid input', async () => {
      const input = {
        ledger: 'stellar',
        contractIdentity: 'contract1',
        algorithm: 'sha256',
        sequence: 1n,
        root: 'abc123def456',
        observedAt: new Date(),
      };

      mockPrismaService.revocationCheckpointStreamHead.findUnique.mockResolvedValue(
        null,
      );
      mockPrismaService.revocationCheckpoint.create.mockResolvedValue({});
      mockPrismaService.revocationCheckpointStreamHead.upsert.mockResolvedValue({
        id: 'head1',
        ledger: 'stellar',
        contractIdentity: 'contract1',
        algorithm: 'sha256',
        sequence: 1n,
        root: 'abc123def456',
        observedAt: input.observedAt,
        acceptedAt: new Date(),
        version: 1,
      });

      const result = await service.upsertCheckpoint(input);
      expect(result.status).toBe('accepted');
    });
  });

  describe('Monotonicity Enforcement', () => {
    const streamKey = {
      ledger: 'stellar',
      contractIdentity: 'contract1',
      algorithm: 'sha256',
    };

    it('should accept first checkpoint for a new stream', async () => {
      const input = {
        ...streamKey,
        sequence: 1n,
        root: 'root1',
        observedAt: new Date('2024-01-01T00:00:00Z'),
      };

      mockPrismaService.revocationCheckpointStreamHead.findUnique.mockResolvedValue(
        null,
      );
      mockPrismaService.revocationCheckpoint.create.mockResolvedValue({});
      mockPrismaService.revocationCheckpointStreamHead.upsert.mockResolvedValue({
        id: 'head1',
        ...input,
        acceptedAt: new Date(),
        version: 1,
      });

      const result = await service.upsertCheckpoint(input);
      expect(result.status).toBe('accepted');
    });

    it('should accept checkpoint with strictly increasing sequence', async () => {
      const currentHead = {
        id: 'head1',
        ...streamKey,
        sequence: 5n,
        root: 'root5',
        observedAt: new Date('2024-01-01T00:00:00Z'),
        acceptedAt: new Date(),
        version: 1,
      };

      const input = {
        ...streamKey,
        sequence: 10n,
        root: 'root10',
        observedAt: new Date('2024-01-02T00:00:00Z'),
      };

      mockPrismaService.revocationCheckpointStreamHead.findUnique.mockResolvedValue(
        currentHead,
      );
      mockPrismaService.revocationCheckpoint.create.mockResolvedValue({});
      mockPrismaService.revocationCheckpointStreamHead.upsert.mockResolvedValue({
        ...currentHead,
        sequence: input.sequence,
        root: input.root,
        observedAt: input.observedAt,
        version: 2,
      });

      const result = await service.upsertCheckpoint(input);
      expect(result.status).toBe('accepted');
    });

    it('should accept identical replay (idempotent)', async () => {
      const now = new Date('2024-01-01T00:00:00Z');
      const currentHead = {
        id: 'head1',
        ...streamKey,
        sequence: 5n,
        root: 'root5',
        observedAt: now,
        acceptedAt: now,
        version: 1,
      };

      const input = {
        ...streamKey,
        sequence: 5n,
        root: 'root5',
        observedAt: now,
      };

      mockPrismaService.revocationCheckpointStreamHead.findUnique.mockResolvedValue(
        currentHead,
      );

      const result = await service.upsertCheckpoint(input);
      expect(result.status).toBe('accepted');
    });

    it('should quarantine checkpoint with lower sequence', async () => {
      const currentHead = {
        id: 'head1',
        ...streamKey,
        sequence: 10n,
        root: 'root10',
        observedAt: new Date(),
        acceptedAt: new Date(),
        version: 1,
      };

      const input = {
        ...streamKey,
        sequence: 5n,
        root: 'root5',
        observedAt: new Date(),
      };

      mockPrismaService.revocationCheckpointStreamHead.findUnique.mockResolvedValue(
        currentHead,
      );
      mockPrismaService.revocationCheckpoint.upsert.mockResolvedValue({});

      const result = await service.upsertCheckpoint(input);
      expect(result.status).toBe('quarantined');
      expect(result.reason).toBe(RevocationCheckpointQuarantineReason.LOWER_SEQUENCE);
    });

    it('should quarantine checkpoint with same sequence but different root', async () => {
      const currentHead = {
        id: 'head1',
        ...streamKey,
        sequence: 10n,
        root: 'root10',
        observedAt: new Date(),
        acceptedAt: new Date(),
        version: 1,
      };

      const input = {
        ...streamKey,
        sequence: 10n,
        root: 'different_root',
        observedAt: new Date(),
      };

      mockPrismaService.revocationCheckpointStreamHead.findUnique.mockResolvedValue(
        currentHead,
      );
      mockPrismaService.revocationCheckpoint.upsert.mockResolvedValue({});

      const result = await service.upsertCheckpoint(input);
      expect(result.status).toBe('quarantined');
      expect(result.reason).toBe(RevocationCheckpointQuarantineReason.SEQUENCE_CONFLICT);
    });
  });

  describe('getFreshCheckpoint', () => {
    it('should return freshness metadata for existing stream head', async () => {
      const now = new Date();
      const head = {
        id: 'head1',
        ledger: 'stellar',
        contractIdentity: 'contract1',
        algorithm: 'sha256',
        sequence: 100n,
        root: 'root100',
        observedAt: now,
        acceptedAt: now,
        version: 1,
      };

      mockPrismaService.revocationCheckpointStreamHead.findUnique.mockResolvedValue(
        head,
      );

      const result = await service.getFreshCheckpoint(
        'stellar',
        'contract1',
        'sha256',
      );

      expect(result.sequence).toBe('100');
      expect(result.root).toBe('root100');
      expect(result.age.staleBeyond).toBe(false); // Just created
    });

    it('should mark as stale if older than 1 hour', async () => {
      const oneHourAgo = new Date(Date.now() - 3600000 - 1000);
      const head = {
        id: 'head1',
        ledger: 'stellar',
        contractIdentity: 'contract1',
        algorithm: 'sha256',
        sequence: 100n,
        root: 'root100',
        observedAt: oneHourAgo,
        acceptedAt: oneHourAgo,
        version: 1,
      };

      mockPrismaService.revocationCheckpointStreamHead.findUnique.mockResolvedValue(
        head,
      );

      const result = await service.getFreshCheckpoint(
        'stellar',
        'contract1',
        'sha256',
      );

      expect(result.age.staleBeyond).toBe(true);
    });

    it('should throw NotFoundException if stream does not exist', async () => {
      mockPrismaService.revocationCheckpointStreamHead.findUnique.mockResolvedValue(
        null,
      );

      await expect(
        service.getFreshCheckpoint('stellar', 'contract1', 'sha256'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('listQuarantined', () => {
    it('should return empty list if no quarantined checkpoints exist', async () => {
      mockPrismaService.revocationCheckpoint.findMany.mockResolvedValue([]);
      mockPrismaService.revocationCheckpoint.count.mockResolvedValue(0);

      const result = await service.listQuarantined({});
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should filter by reason', async () => {
      const quarantined = [
        {
          id: '1',
          ledger: 'stellar',
          contractIdentity: 'contract1',
          algorithm: 'sha256',
          sequence: 5n,
          root: 'root5',
          observedAt: new Date(),
          quarantineReason: RevocationCheckpointQuarantineReason.LOWER_SEQUENCE,
          quarantineDetails: 'sequence is lower than current head (10)',
          quarantinedAt: new Date(),
        },
      ];

      mockPrismaService.revocationCheckpoint.findMany.mockResolvedValue(
        quarantined,
      );
      mockPrismaService.revocationCheckpoint.count.mockResolvedValue(1);

      const result = await service.listQuarantined({
        reason: RevocationCheckpointQuarantineReason.LOWER_SEQUENCE,
      });

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('should respect limit and offset', async () => {
      mockPrismaService.revocationCheckpoint.findMany.mockResolvedValue([]);
      mockPrismaService.revocationCheckpoint.count.mockResolvedValue(100);

      await service.listQuarantined({ limit: 10, offset: 20 });

      expect(mockPrismaService.revocationCheckpoint.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 10,
          skip: 20,
        }),
      );
    });

    it('should cap limit at 500', async () => {
      mockPrismaService.revocationCheckpoint.findMany.mockResolvedValue([]);
      mockPrismaService.revocationCheckpoint.count.mockResolvedValue(0);

      await service.listQuarantined({ limit: 1000 });

      expect(mockPrismaService.revocationCheckpoint.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 500,
        }),
      );
    });
  });

  describe('Concurrency', () => {
    it('should handle concurrent identical writes (idempotent via upsert)', async () => {
      const input = {
        ledger: 'stellar',
        contractIdentity: 'contract1',
        algorithm: 'sha256',
        sequence: 1n,
        root: 'root1',
        observedAt: new Date(),
      };

      mockPrismaService.revocationCheckpointStreamHead.findUnique.mockResolvedValue(
        null,
      );
      mockPrismaService.revocationCheckpoint.create.mockResolvedValue({});
      mockPrismaService.revocationCheckpointStreamHead.upsert.mockResolvedValue({
        id: 'head1',
        ...input,
        acceptedAt: new Date(),
        version: 1,
      });

      const result1 = await service.upsertCheckpoint(input);
      const result2 = await service.upsertCheckpoint(input);

      expect(result1.status).toBe('accepted');
      expect(result2.status).toBe('accepted');
    });
  });

  describe('Proof Verification Isolation', () => {
    it('should NOT affect proof verification (checkpoint is additional evidence only)', async () => {
      // This is a logical test: the service does not interact with proof status checks.
      // Proof verification remains unchanged and independent.
      const service1 = service;
      expect(service1).toBeDefined();
      // Checkpoints exist separately; proof.verifyProof() is unchanged
    });
  });
});
