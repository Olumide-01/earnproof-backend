import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { RevocationCheckpointController } from './revocation-checkpoint.controller';
import { RevocationCheckpointService } from './revocation-checkpoint.service';
import { RevocationCheckpointQuarantineReason } from '@prisma/client';

describe('RevocationCheckpointController', () => {
  let controller: RevocationCheckpointController;
  let service: RevocationCheckpointService;

  const mockService = {
    upsertCheckpoint: jest.fn(),
    getFreshCheckpoint: jest.fn(),
    listQuarantined: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RevocationCheckpointController],
      providers: [
        {
          provide: RevocationCheckpointService,
          useValue: mockService,
        },
      ],
    }).compile();

    controller = module.get<RevocationCheckpointController>(
      RevocationCheckpointController,
    );
    service = module.get<RevocationCheckpointService>(RevocationCheckpointService);

    jest.clearAllMocks();
  });

  describe('createCheckpoint', () => {
    it('should create a checkpoint', async () => {
      const dto = {
        ledger: 'stellar',
        contractIdentity: 'contract1',
        algorithm: 'sha256',
        sequence: '100',
        root: 'abc123def456',
        observedAt: '2024-01-01T00:00:00Z',
      };

      mockService.upsertCheckpoint.mockResolvedValue({
        status: 'accepted',
        head: {
          sequence: '100',
          root: 'abc123def456',
          observedAt: '2024-01-01T00:00:00Z',
          acceptedAt: '2024-01-01T00:00:01Z',
        },
      });

      const result = await controller.createCheckpoint(dto);

      expect(result.status).toBe('accepted');
      expect(mockService.upsertCheckpoint).toHaveBeenCalledWith({
        ledger: 'stellar',
        contractIdentity: 'contract1',
        algorithm: 'sha256',
        sequence: 100n,
        root: 'abc123def456',
        observedAt: expect.any(Date),
      });
    });

    it('should reject invalid sequence', async () => {
      const dto = {
        ledger: 'stellar',
        contractIdentity: 'contract1',
        algorithm: 'sha256',
        sequence: 'not_a_number',
        root: 'abc123def456',
        observedAt: '2024-01-01T00:00:00Z',
      };

      await expect(controller.createCheckpoint(dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject invalid observedAt', async () => {
      const dto = {
        ledger: 'stellar',
        contractIdentity: 'contract1',
        algorithm: 'sha256',
        sequence: '100',
        root: 'abc123def456',
        observedAt: 'not_a_date',
      };

      await expect(controller.createCheckpoint(dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should return quarantined checkpoint', async () => {
      const dto = {
        ledger: 'stellar',
        contractIdentity: 'contract1',
        algorithm: 'sha256',
        sequence: '5',
        root: 'root5',
        observedAt: '2024-01-01T00:00:00Z',
      };

      mockService.upsertCheckpoint.mockResolvedValue({
        status: 'quarantined',
        reason: RevocationCheckpointQuarantineReason.LOWER_SEQUENCE,
        head: {
          sequence: '10',
          root: 'root10',
          observedAt: '2024-01-02T00:00:00Z',
          acceptedAt: '2024-01-02T00:00:01Z',
        },
      });

      const result = await controller.createCheckpoint(dto);

      expect(result.status).toBe('quarantined');
      expect(result.checkpoint.quarantineReason).toBe(
        RevocationCheckpointQuarantineReason.LOWER_SEQUENCE,
      );
    });
  });

  describe('getFreshCheckpoint', () => {
    it('should return freshness metadata', async () => {
      mockService.getFreshCheckpoint.mockResolvedValue({
        sequence: '100',
        root: 'root100',
        observedAt: '2024-01-01T00:00:00Z',
        acceptedAt: '2024-01-01T00:00:01Z',
        age: {
          seconds: 3600,
          staleBeyond: false,
        },
      });

      const result = await controller.getFreshCheckpoint(
        'stellar',
        'contract1',
        'sha256',
      );

      expect(result.sequence).toBe('100');
      expect(result.age.staleBeyond).toBe(false);
      expect(mockService.getFreshCheckpoint).toHaveBeenCalledWith(
        'stellar',
        'contract1',
        'sha256',
      );
    });

    it('should reject missing required query params', async () => {
      await expect(
        controller.getFreshCheckpoint('stellar', undefined as any, 'sha256'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('listQuarantined', () => {
    it('should list quarantined checkpoints', async () => {
      mockService.listQuarantined.mockResolvedValue({
        items: [
          {
            id: '1',
            ledger: 'stellar',
            contractIdentity: 'contract1',
            algorithm: 'sha256',
            sequence: '5',
            root: 'root5',
            observedAt: '2024-01-01T00:00:00Z',
            quarantineReason: RevocationCheckpointQuarantineReason.LOWER_SEQUENCE,
            quarantineDetails: 'sequence is lower than current head (10)',
            quarantinedAt: '2024-01-01T00:00:01Z',
          },
        ],
        total: 1,
      });

      const result = await controller.listQuarantined(
        'stellar',
        'contract1',
        'sha256',
        undefined,
        '50',
        '0',
      );

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('should reject invalid limit/offset', async () => {
      await expect(
        controller.listQuarantined('stellar', undefined, undefined, undefined, 'not_a_number', '0'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
