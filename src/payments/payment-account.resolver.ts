import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PaymentMonitoredAccountStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";

export interface MonitoredAccount {
  accountId: string;
  network: string;
  /** The active epoch row, or null for a user who never rotated. */
  epochId: string | null;
  source: "rotation" | "wallet";
}

type Client = Pick<Prisma.TransactionClient, "paymentMonitoredAccount" | "paymentSyncCheckpoint">;

/**
 * Resolves which Stellar account a user's payments are indexed from
 * (earnproof-backend#321).
 *
 * A user who never rotated has no epoch row, and their wallet address is the
 * monitored account — exactly the behaviour before rotation existed. After a
 * rotation the active epoch wins, so later wallet (login identity) changes do
 * not silently switch which account's history is read.
 */
@Injectable()
export class PaymentAccountResolver {
  private readonly network: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.network = config.getOrThrow<string>("stellar.network");
  }

  async current(
    user: { id: string; walletAddress: string },
    client: Client = this.prisma,
  ): Promise<MonitoredAccount> {
    const epoch = await client.paymentMonitoredAccount.findFirst({
      where: { userId: user.id, network: this.network, status: PaymentMonitoredAccountStatus.ACTIVE },
      select: { id: true, accountId: true },
    });
    return epoch
      ? { accountId: epoch.accountId, network: this.network, epochId: epoch.id, source: "rotation" }
      : { accountId: user.walletAddress, network: this.network, epochId: null, source: "wallet" };
  }

  /**
   * Called after a sync. If the monitored account changed while the sync was
   * reading (an activation or rollback committed mid-sync), any checkpoint
   * written since the change may describe the *previous* account's feed, so
   * it is discarded; the next sync re-establishes one from the right account.
   * Payment rows are keyed by operation id, so a discarded checkpoint costs a
   * re-read, never a duplicate.
   */
  async discardStaleCheckpoint(
    user: { id: string; walletAddress: string },
    used: MonitoredAccount,
  ): Promise<boolean> {
    const now = await this.current(user);
    if (now.accountId === used.accountId && now.epochId === used.epochId) return false;
    const since = now.epochId
      ? (
          await this.prisma.paymentMonitoredAccount.findUnique({
            where: { id: now.epochId },
            select: { updatedAt: true },
          })
        )?.updatedAt
      : undefined;
    const deleted = await this.prisma.paymentSyncCheckpoint.deleteMany({
      where: { userId: user.id, ...(since ? { updatedAt: { gte: since } } : {}) },
    });
    return deleted.count > 0;
  }
}
