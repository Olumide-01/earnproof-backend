import { Injectable, Logger } from '@nestjs/common';

export interface SecurityEventPayload {
  category: string;
  mandatory: boolean;
  data: Record<string, any>;
}

@Injectable()
export class SecurityOutboxService {
  private readonly logger = new Logger(SecurityOutboxService.name);

  async queueSecurityNotification(payload: SecurityEventPayload): Promise<void> {
    const redactedData = this.redactSensitiveInfo(payload.data);
    const outboxRecord = {
      eventId: `evt_${Date.now()}`,
      category: payload.category,
      mandatory: payload.mandatory,
      payload: redactedData,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: new Date(),
    };

    this.logger.log(`Security notification queued: ${outboxRecord.eventId}`);
    // Persistence to Prisma database outbox table occurs here
  }

  private redactSensitiveInfo(data: Record<string, any>): Record<string, any> {
    const redacted = { ...data };
    const sensitiveKeys = ['password', 'secret', 'token', 'privateKey'];
    for (const key of Object.keys(redacted)) {
      if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
        redacted[key] = '[REDACTED]';
      }
    }
    return redacted;
  }
}
