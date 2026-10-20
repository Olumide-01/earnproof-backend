import { Test, TestingModule } from '@nestjs/testing';
import { WebhookCircuitState } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { WebhookCircuitBreakerService } from './webhook-circuit-breaker.service';

describe('WebhookCircuitBreakerService', () => {
  let service: WebhookCircuitBreakerService;
  let prismaService: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    const mockPrisma = {
      webhookCircuitState: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookCircuitBreakerService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<WebhookCircuitBreakerService>(WebhookCircuitBreakerService);
    prismaService = module.get(PrismaService);
  });

  describe('canAttemptDelivery', () => {
    it('should allow delivery when circuit is CLOSED', async () => {
      const webhookId = 'webhook-1';

      prismaService.webhookCircuitState.findUnique.mockResolvedValue({
        webhookId,
        state: WebhookCircuitState.CLOSED,
        failureCount: 0,
        failureThreshold: 5,
      } as any);

      const result = await service.canAttemptDelivery(webhookId);
      expect(result).toBe(true);
    });

    it('should block delivery when circuit is OPEN and recovery window not passed', async () => {
      const webhookId = 'webhook-1';
      const now = new Date();
      const openedAt = new Date(now.getTime() - 60_000); // Opened 1 minute ago
      const recoveryWindowMs = 300_000; // 5 minutes

      prismaService.webhookCircuitState.findUnique.mockResolvedValue({
        webhookId,
        state: WebhookCircuitState.OPEN,
        failureCount: 5,
        failureThreshold: 5,
        openedAt,
        recoveryWindowMs,
      } as any);

      const result = await service.canAttemptDelivery(webhookId);
      expect(result).toBe(false);
    });

    it('should transition to HALF_OPEN and allow delivery after recovery window', async () => {
      const webhookId = 'webhook-1';
      const now = new Date();
      const openedAt = new Date(now.getTime() - 400_000); // Opened 6+ minutes ago
      const recoveryWindowMs = 300_000; // 5 minutes

      prismaService.webhookCircuitState.findUnique.mockResolvedValue({
        webhookId,
        state: WebhookCircuitState.OPEN,
        failureCount: 5,
        failureThreshold: 5,
        openedAt,
        recoveryWindowMs,
      } as any);

      prismaService.webhookCircuitState.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.canAttemptDelivery(webhookId);

      expect(result).toBe(true);
      expect(prismaService.webhookCircuitState.updateMany).toHaveBeenCalledWith({
        where: {
          webhookId,
          state: WebhookCircuitState.OPEN,
        },
        data: {
          state: WebhookCircuitState.HALF_OPEN,
          halfOpenAt: expect.any(Date),
        },
      });
    });

    it('should allow delivery in HALF_OPEN state', async () => {
      const webhookId = 'webhook-1';

      prismaService.webhookCircuitState.findUnique.mockResolvedValue({
        webhookId,
        state: WebhookCircuitState.HALF_OPEN,
      } as any);

      const result = await service.canAttemptDelivery(webhookId);
      expect(result).toBe(true);
    });

    it('should initialize circuit if it does not exist', async () => {
      const webhookId = 'webhook-1';

      // First call returns null, second call returns initialized circuit
      prismaService.webhookCircuitState.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          webhookId,
          state: WebhookCircuitState.CLOSED,
        } as any);

      const result = await service.canAttemptDelivery(webhookId);

      expect(result).toBe(true);
      expect(prismaService.webhookCircuitState.upsert).toHaveBeenCalled();
    });
  });

  describe('recordSuccess', () => {
    it('should close circuit and reset failure count', async () => {
      const webhookId = 'webhook-1';

      prismaService.webhookCircuitState.findUnique.mockResolvedValue({
        webhookId,
        state: WebhookCircuitState.HALF_OPEN,
        failureCount: 3,
      } as any);

      await service.recordSuccess(webhookId);

      expect(prismaService.webhookCircuitState.update).toHaveBeenCalledWith({
        where: { webhookId },
        data: {
          state: WebhookCircuitState.CLOSED,
          failureCount: 0,
          lastSuccessAt: expect.any(Date),
          halfOpenAt: null,
        },
      });
    });
  });

  describe('recordFailure', () => {
    it('should ignore permanent policy failures', async () => {
      const webhookId = 'webhook-1';

      await service.recordFailure(webhookId, true); // isPermanentFailure = true

      expect(prismaService.webhookCircuitState.findUnique).not.toHaveBeenCalled();
      expect(prismaService.webhookCircuitState.update).not.toHaveBeenCalled();
    });

    it('should increment failure count without opening circuit', async () => {
      const webhookId = 'webhook-1';

      prismaService.webhookCircuitState.findUnique.mockResolvedValue({
        webhookId,
        state: WebhookCircuitState.CLOSED,
        failureCount: 2,
        failureThreshold: 5,
      } as any);

      await service.recordFailure(webhookId, false);

      expect(prismaService.webhookCircuitState.update).toHaveBeenCalledWith({
        where: { webhookId },
        data: {
          failureCount: 3,
          lastFailureAt: expect.any(Date),
        },
      });
    });

    it('should open circuit when threshold is reached', async () => {
      const webhookId = 'webhook-1';

      prismaService.webhookCircuitState.findUnique.mockResolvedValue({
        webhookId,
        state: WebhookCircuitState.CLOSED,
        failureCount: 4,
        failureThreshold: 5,
      } as any);

      await service.recordFailure(webhookId, false);

      expect(prismaService.webhookCircuitState.update).toHaveBeenCalledWith({
        where: { webhookId },
        data: {
          failureCount: 5,
          lastFailureAt: expect.any(Date),
          state: WebhookCircuitState.OPEN,
          openedAt: expect.any(Date),
        },
      });
    });

    it('should reopen circuit on failed HALF_OPEN probe', async () => {
      const webhookId = 'webhook-1';

      prismaService.webhookCircuitState.findUnique.mockResolvedValue({
        webhookId,
        state: WebhookCircuitState.HALF_OPEN,
        failureCount: 5,
        failureThreshold: 5,
      } as any);

      await service.recordFailure(webhookId, false);

      expect(prismaService.webhookCircuitState.update).toHaveBeenCalledWith({
        where: { webhookId },
        data: {
          failureCount: 6,
          lastFailureAt: expect.any(Date),
          state: WebhookCircuitState.OPEN,
          openedAt: expect.any(Date),
          halfOpenAt: null,
        },
      });
    });
  });

  describe('updateConfig', () => {
    it('should update circuit configuration', async () => {
      const webhookId = 'webhook-1';
      const config = {
        failureThreshold: 10,
        recoveryWindowMs: 600_000,
      };

      prismaService.webhookCircuitState.findUnique.mockResolvedValue({
        webhookId,
        state: WebhookCircuitState.CLOSED,
        failureCount: 3,
      } as any);

      await service.updateConfig(webhookId, config);

      expect(prismaService.webhookCircuitState.update).toHaveBeenCalledWith({
        where: { webhookId },
        data: {
          failureThreshold: 10,
          recoveryWindowMs: 600_000,
        },
      });
    });

    it('should close circuit if failure count is below new threshold', async () => {
      const webhookId = 'webhook-1';
      const config = { failureThreshold: 10 };

      prismaService.webhookCircuitState.findUnique.mockResolvedValue({
        webhookId,
        state: WebhookCircuitState.OPEN,
        failureCount: 5, // Below new threshold of 10
      } as any);

      await service.updateConfig(webhookId, config);

      expect(prismaService.webhookCircuitState.update).toHaveBeenCalledWith({
        where: { webhookId },
        data: {
          failureThreshold: 10,
          state: WebhookCircuitState.CLOSED,
          openedAt: null,
        },
      });
    });
  });

  describe('deleteCircuitState', () => {
    it('should delete circuit state for webhook', async () => {
      const webhookId = 'webhook-1';

      await service.deleteCircuitState(webhookId);

      expect(prismaService.webhookCircuitState.deleteMany).toHaveBeenCalledWith({
        where: { webhookId },
      });
    });
  });

  describe('getCircuitStats', () => {
    it('should return circuit statistics', async () => {
      const webhookId = 'webhook-1';
      const mockStats = {
        state: WebhookCircuitState.CLOSED,
        failureCount: 2,
        failureThreshold: 5,
        lastFailureAt: new Date(),
        lastSuccessAt: new Date(),
        openedAt: null,
      };

      prismaService.webhookCircuitState.findUnique.mockResolvedValue(mockStats as any);

      const result = await service.getCircuitStats(webhookId);

      expect(result).toEqual(mockStats);
    });

    it('should return null if circuit does not exist', async () => {
      const webhookId = 'webhook-1';

      prismaService.webhookCircuitState.findUnique.mockResolvedValue(null);

      const result = await service.getCircuitStats(webhookId);

      expect(result).toBeNull();
    });
  });
});