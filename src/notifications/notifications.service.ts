import { Injectable, Logger } from "@nestjs/common";

export interface ProofExpirationNotificationRecord {
  notificationId: string;
  type: "PROOF_EXPIRATION_REMINDER";
  proofId: string;
  targetExpirationDate: string;
  leadWindowHours: number;
  message: string;
  emittedAt: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  /**
   * Emits a privacy-safe security notification record.
   * Strictly asserts that NO claim values, asset amounts, or private keys are emitted.
   */
  async emitProofExpirationNotification(
    proofId: string,
    targetExpirationDate: Date,
    leadWindowHours: number,
  ): Promise<ProofExpirationNotificationRecord> {
    const record: ProofExpirationNotificationRecord = {
      notificationId: `notif_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      type: "PROOF_EXPIRATION_REMINDER",
      proofId,
      targetExpirationDate: targetExpirationDate.toISOString(),
      leadWindowHours,
      message: `Security notice: Proof ${proofId} is scheduled to expire in approximately ${leadWindowHours} hours.`,
      emittedAt: new Date().toISOString(),
    };

    this.logger.log("Emitted privacy-safe proof expiration reminder", {
      proofId,
      leadWindowHours,
    });

    return record;
  }
}
