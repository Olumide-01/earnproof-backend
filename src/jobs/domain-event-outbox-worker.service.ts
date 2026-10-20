import { Injectable, OnApplicationShutdown, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { randomUUID } from "crypto";
import { DomainEventOutboxService } from "../common/events/domain-event-outbox.service";

@Injectable()
export class DomainEventOutboxWorkerService implements OnApplicationShutdown {
  private readonly logger = new Logger(DomainEventOutboxWorkerService.name);
  private readonly owner = `outbox-worker:${randomUUID()}`;
  private draining = false;
  private running = false;

  constructor(private readonly outboxService: DomainEventOutboxService) {}

  @Interval(5_000)
  async poll(): Promise<void> {
    if (this.draining || this.running) {
      return;
    }
    this.running = true;

    try {
      const outcomes = await this.outboxService.processBatch(this.owner, 20);
      if (outcomes.length > 0) {
        this.logger.debug(
          `Processed ${outcomes.length} outbox domain event deliveries`,
        );
      }
    } catch {
      this.logger.warn("Domain event outbox lease batch failed unexpectedly");
    } finally {
      this.running = false;
    }
  }

  onApplicationShutdown(): void {
    this.draining = true;
    this.logger.log("Domain event outbox worker draining during shutdown");
  }

  isDraining(): boolean {
    return this.draining;
  }
}
