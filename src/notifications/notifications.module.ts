import { Module, OnModuleInit } from "@nestjs/common";
import { NotificationsService } from "./notifications.service";
import { AuthModule } from "../auth/auth.module";
import { CommonModule } from "../common/common.module";
import { SecurityNotificationsController } from "./security-notifications.controller";
import { SecurityNotificationService } from "./security-notification.service";
import { DisputeDecisionNotificationHandler } from "./handlers/dispute-decision-notification.handler";
import { DomainEventOutboxService } from "../common/events/domain-event-outbox.service";

@Module({
  imports: [AuthModule, CommonModule],
  controllers: [SecurityNotificationsController],
  providers: [
    NotificationsService,
    SecurityNotificationService,
    DisputeDecisionNotificationHandler,
  ],
  exports: [SecurityNotificationService, NotificationsService],
})
export class NotificationsModule implements OnModuleInit {
  constructor(
    private readonly disputeDecisionHandler: DisputeDecisionNotificationHandler,
    private readonly domainEventOutbox: DomainEventOutboxService,
  ) {}

  /**
   * Register domain event consumers on module initialization.
   * This wires up the dispute notification handler to listen for dispute lifecycle events.
   */
  onModuleInit(): void {
    // Register handler for all dispute decision event types
    this.domainEventOutbox.registerConsumer("DISPUTE_FILED", this.disputeDecisionHandler);
    this.domainEventOutbox.registerConsumer("DISPUTE_ASSIGNED", this.disputeDecisionHandler);
    this.domainEventOutbox.registerConsumer("DISPUTE_WITHDRAWN", this.disputeDecisionHandler);
    this.domainEventOutbox.registerConsumer("DISPUTE_RESOLVED", this.disputeDecisionHandler);
    this.domainEventOutbox.registerConsumer("DISPUTE_EXPIRED", this.disputeDecisionHandler);
  }
}
