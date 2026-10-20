import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  Prisma,
  Proof,
  ProofStatus,
  ReminderDeliveryStatus,
} from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  ProofReminderDeliveryDto,
  ProofReminderPreferencesDto,
  UpdateProofReminderPreferencesDto,
} from "./dto/proof-reminder.dto";

const DEFAULT_LEAD_HOURS = [24, 72, 168]; // 1 day, 3 days, 7 days

@Injectable()
export class ProofExpirationReminderService {
  private readonly logger = new Logger(ProofExpirationReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Retrieves reminder preferences for a user, creating default if not exists.
   */
  async getPreferences(userId: string): Promise<ProofReminderPreferencesDto> {
    const pref = await this.prisma.proofExpirationReminderPreference.findUnique({
      where: { userId },
    });

    if (!pref) {
      return {
        enabled: true,
        leadTimeHours: DEFAULT_LEAD_HOURS,
        optedOutAt: null,
      };
    }

    return {
      enabled: pref.enabled,
      leadTimeHours: pref.leadTimeHours,
      optedOutAt: pref.optedOutAt,
    };
  }

  /**
   * Updates reminder preferences for a user.
   */
  async updatePreferences(
    userId: string,
    dto: UpdateProofReminderPreferencesDto,
  ): Promise<ProofReminderPreferencesDto> {
    const existing = await this.prisma.proofExpirationReminderPreference.findUnique({
      where: { userId },
    });

    const isOptingOut = dto.enabled === false;
    const optedOutAt = isOptingOut ? new Date() : (dto.enabled === true ? null : existing?.optedOutAt ?? null);

    const updated = await this.prisma.proofExpirationReminderPreference.upsert({
      where: { userId },
      create: {
        userId,
        enabled: dto.enabled ?? true,
        leadTimeHours: dto.leadTimeHours ?? DEFAULT_LEAD_HOURS,
        optedOutAt,
      },
      update: {
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        ...(dto.leadTimeHours !== undefined && { leadTimeHours: dto.leadTimeHours }),
        optedOutAt,
      },
    });

    // If user explicitly opted out, cancel all currently pending/scheduled reminders for this user
    if (isOptingOut) {
      await this.prisma.proofExpirationReminderDelivery.updateMany({
        where: {
          userId,
          status: { in: [ReminderDeliveryStatus.SCHEDULED, ReminderDeliveryStatus.ENQUEUED] },
        },
        data: {
          status: ReminderDeliveryStatus.CANCELLED,
          cancelledAt: new Date(),
          cancellationReason: "User opted out of expiration reminders",
        },
      });
    }

    return {
      enabled: updated.enabled,
      leadTimeHours: updated.leadTimeHours,
      optedOutAt: updated.optedOutAt,
    };
  }

  /**
   * Schedule deduplicated expiration reminders for a newly issued or active proof.
   *
   * Invariant: Each proof and reminder window produces at most one active delivery.
   */
  async scheduleRemindersForProof(proof: Pick<Proof, "id" | "userId" | "expiresAt" | "status">): Promise<number> {
    if (proof.status !== ProofStatus.ACTIVE) {
      return 0;
    }

    const pref = await this.getPreferences(proof.userId);
    if (!pref.enabled) {
      return 0;
    }

    const now = Date.now();
    let scheduledCount = 0;

    for (const windowHours of pref.leadTimeHours) {
      const scheduledTimeMs = proof.expiresAt.getTime() - windowHours * 3600 * 1000;
      // If the reminder trigger time is already in the past, do not schedule stale reminder
      if (scheduledTimeMs <= now) {
        continue;
      }

      const scheduledFor = new Date(scheduledTimeMs);

      // Deduplicated upsert: @@unique([proofId, windowHours])
      await this.prisma.proofExpirationReminderDelivery.upsert({
        where: {
          proofId_windowHours: {
            proofId: proof.id,
            windowHours,
          },
        },
        create: {
          proofId: proof.id,
          userId: proof.userId,
          windowHours,
          targetDate: proof.expiresAt,
          status: ReminderDeliveryStatus.SCHEDULED,
          scheduledFor,
        },
        update: {
          // If already exists and was cancelled, re-schedule if still eligible
          targetDate: proof.expiresAt,
          scheduledFor,
        },
      });

      scheduledCount++;
    }

    return scheduledCount;
  }

  /**
   * Deterministically cancels all pending/enqueued reminders for a proof when proof status transitions
   * (e.g., REVOKED, SUPERSEDED, DISPUTED, or EXPIRED).
   */
  async cancelRemindersForProof(proofId: string, reason: string): Promise<number> {
    const result = await this.prisma.proofExpirationReminderDelivery.updateMany({
      where: {
        proofId,
        status: { in: [ReminderDeliveryStatus.SCHEDULED, ReminderDeliveryStatus.ENQUEUED] },
      },
      data: {
        status: ReminderDeliveryStatus.CANCELLED,
        cancelledAt: new Date(),
        cancellationReason: reason,
      },
    });

    return result.count;
  }

  /**
   * Processes all pending reminders due as of `asOfDate`.
   *
   * Crucial requirement:
   * **Re-evaluates proof state immediately before enqueue and delivery.**
   * If the proof was revoked, superseded, disputed, or already expired, cancels the delivery.
   */
  async processScheduledReminders(asOfDate: Date = new Date()): Promise<{
    processed: number;
    delivered: number;
    cancelled: number;
  }> {
    const dueDeliveries = await this.prisma.proofExpirationReminderDelivery.findMany({
      where: {
        status: ReminderDeliveryStatus.SCHEDULED,
        scheduledFor: { lte: asOfDate },
      },
      include: {
        proof: {
          select: {
            id: true,
            status: true,
            expiresAt: true,
          },
        },
        user: {
          select: {
            id: true,
            proofExpirationReminderPreference: true,
          },
        },
      },
      take: 100, // bounded batch
    });

    let delivered = 0;
    let cancelled = 0;

    for (const delivery of dueDeliveries) {
      // 1. Re-evaluate proof state immediately before delivery!
      if (!delivery.proof || delivery.proof.status !== ProofStatus.ACTIVE) {
        const reason = !delivery.proof
          ? "Proof not found"
          : `Proof state transitioned to ${delivery.proof.status}`;

        await this.prisma.proofExpirationReminderDelivery.update({
          where: { id: delivery.id },
          data: {
            status: ReminderDeliveryStatus.CANCELLED,
            cancelledAt: new Date(),
            cancellationReason: reason,
          },
        });
        cancelled++;
        continue;
      }

      // Check if proof has already reached or passed expiration
      if (delivery.proof.expiresAt.getTime() <= asOfDate.getTime()) {
        await this.prisma.proofExpirationReminderDelivery.update({
          where: { id: delivery.id },
          data: {
            status: ReminderDeliveryStatus.CANCELLED,
            cancelledAt: new Date(),
            cancellationReason: "Proof has already reached or passed expiration timestamp",
          },
        });
        cancelled++;
        continue;
      }

      // 2. Re-evaluate user opt-out preference
      const pref = delivery.user.proofExpirationReminderPreference;
      if (pref && (!pref.enabled || pref.optedOutAt)) {
        await this.prisma.proofExpirationReminderDelivery.update({
          where: { id: delivery.id },
          data: {
            status: ReminderDeliveryStatus.CANCELLED,
            cancelledAt: new Date(),
            cancellationReason: "User opted out of reminders",
          },
        });
        cancelled++;
        continue;
      }

      // 3. Emit privacy-safe notification record (NO claim values or amounts)
      const notifRecord = await this.notificationsService.emitProofExpirationNotification(
        delivery.proof.id,
        delivery.targetDate,
        delivery.windowHours,
      );

      // 4. Mark delivered
      await this.prisma.proofExpirationReminderDelivery.update({
        where: { id: delivery.id },
        data: {
          status: ReminderDeliveryStatus.DELIVERED,
          deliveredAt: new Date(),
          notificationRecord: notifRecord as unknown as Prisma.InputJsonValue,
        },
      });
      delivered++;
    }

    return {
      processed: dueDeliveries.length,
      delivered,
      cancelled,
    };
  }

  /**
   * Lists reminder deliveries for a specific proof.
   */
  async getRemindersForProof(userId: string, proofId: string): Promise<ProofReminderDeliveryDto[]> {
    const proof = await this.prisma.proof.findUnique({
      where: { id: proofId },
      select: { userId: true },
    });

    if (!proof) {
      throw new NotFoundException(`Proof ${proofId} not found`);
    }

    if (proof.userId !== userId) {
      throw new BadRequestException("Not authorized to view reminders for this proof");
    }

    const deliveries = await this.prisma.proofExpirationReminderDelivery.findMany({
      where: { proofId },
      orderBy: { windowHours: "asc" },
    });

    return deliveries.map((d) => ({
      id: d.id,
      proofId: d.proofId,
      windowHours: d.windowHours,
      targetDate: d.targetDate,
      status: d.status,
      scheduledFor: d.scheduledFor,
      deliveredAt: d.deliveredAt,
      cancelledAt: d.cancelledAt,
      cancellationReason: d.cancellationReason,
      notificationRecord: d.notificationRecord as Record<string, unknown> | null,
    }));
  }
}
