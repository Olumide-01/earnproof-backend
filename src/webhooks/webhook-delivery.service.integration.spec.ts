import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { WebhookCircuitState } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookCircuitBreakerService } from './webhook-circuit-breaker.service';

describe('WebhookDeliveryService - Circuit Integration', () => {
  let service: WebhookDeliveryService;
  let circuitBreaker: jest.Mocked<WebhookCircuitBreakerService>;
  let httpService: jest.Mocked<HttpService>;

  const mockWebhook = {
    id: 'webhook-1',
    url: 'https://example.com/webhook',
    secret: 'secret-key',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDeliveryService,
        {
          provide: PrismaService,
          useValue: {},
        },
        {
          provide: HttpService,
          useValue: {
            axiosRef: {
              post: jest.fn(),
            },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue('test'),
          },
        },
        {
          provide: WebhookCircuitBreakerService,
          useValue: {
            canAttemptDelivery: jest.fn(),
            recordSuccess: jest.fn(),
            recordFailure: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<WebhookDeliveryService>(WebhookDeliveryService);
    circuitBreaker = module.get(WebhookCircuitBreakerService);
    httpService = module.get(HttpService);
  });

  describe('deliverWebhook with circuit breaker', () => {
    it('should skip delivery when circuit is open', async () => {
      const payload = { event: 'test' };

      circuitBreaker.canAttemptDelivery.mockResolvedValue(false);

      const result = await service.deliverWebhook(mockWebhook, payload);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Circuit breaker is open');
      expect(httpService.axiosRef.post).not.toHaveBeenCalled();
      expect(circuitBreaker.recordSuccess).not.toHaveBeenCalled();
      expect(circuitBreaker.recordFailure).not.toHaveBeenCalled();
    });

    it('should record success when delivery succeeds', async () => {
      const payload = { event: 'test' };

      circuitBreaker.canAttemptDelivery.mockResolvedValue(true);
      httpService.axiosRef.post.mockResolvedValue({
        status: 200,
        data: 'OK',
      });

      const result = await service.deliverWebhook(mockWebhook, payload);

      expect(result.success).toBe(true);
      expect(circuitBreaker.recordSuccess).toHaveBeenCalledWith(mockWebhook.id);
      expect(circuitBreaker.recordFailure).not.toHaveBeenCalled();
    });

    it('should record failure for temporary errors', async () => {
      const payload = { event: 'test' };

      circuitBreaker.canAttemptDelivery.mockResolvedValue(true);
      httpService.axiosRef.post.mockRejectedValue({
        response: { status: 500 },
        message: 'Internal Server Error',
      });

      const result = await service.deliverWebhook(mockWebhook, payload);

      expect(result.success).toBe(false);
      expect(circuitBreaker.recordFailure).toHaveBeenCalledWith(
        mockWebhook.id,
        false, // Not permanent failure
      );
      expect(circuitBreaker.recordSuccess).not.toHaveBeenCalled();
    });

    it('should record permanent failure for client errors', async () => {
      const payload = { event: 'test' };

      circuitBreaker.canAttemptDelivery.mockResolvedValue(true);
      httpService.axiosRef.post.mockRejectedValue({
        response: { status: 400 },
        message: 'Bad Request',
      });

      const result = await service.deliverWebhook(mockWebhook, payload);

      expect(result.success).toBe(false);
      expect(circuitBreaker.recordFailure).toHaveBeenCalledWith(
        mockWebhook.id,
        true, // Permanent failure
      );
    });

    it('should handle network errors as temporary failures', async () => {
      const payload = { event: 'test' };

      circuitBreaker.canAttemptDelivery.mockResolvedValue(true);
      httpService.axiosRef.post.mockRejectedValue({
        code: 'ECONNREFUSED',
        message: 'Connection refused',
      });

      const result = await service.deliverWebhook(mockWebhook, payload);

      expect(result.success).toBe(false);
      expect(circuitBreaker.recordFailure).toHaveBeenCalledWith(
        mockWebhook.id,
        false, // Network error is temporary
      );
    });
  });
});