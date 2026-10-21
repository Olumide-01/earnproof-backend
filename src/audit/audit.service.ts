import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

export interface AuditRecordOptions {
  actor: { type: string; id: string };
  action: string;
  outcome: string;
  meta?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(options: AuditRecordOptions): Promise<void> {
    try {
      this.logger.log(
        `Audit: actor=${options.actor.type}:${options.actor.id} action=${options.action} outcome=${options.outcome}`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to record audit event: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
