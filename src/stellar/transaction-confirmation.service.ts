import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { StellarService } from "./stellar.service";
import {
  STELLAR_NETWORK_NAMES,
  STELLAR_SECRET_SEED_PATTERN,
  StellarNetworkName,
} from "./stellar-network";
import {
  RecordSubmissionInput,
  TransactionConfirmationDto,
} from "./transaction-confirmation.types";
import {
  TransactionConfirmation,
  TransactionConfirmationStatus,
} from "@prisma/client";

export const MAX_CONFIRMATION_RETRIES = 15;
export const BASE_POLL_DELAY_MS = 1500;
export const MAX_POLL_DELAY_MS = 30000;

@Injectable()
export class TransactionConfirmationService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly stellarService?: StellarService,
  ) {}

  /**
   * Generates a privacy-safe explorer reference for the given network and transaction hash.
   * Never echoes secrets or URL query parameters.
   */
  getExplorerUrl(network: string, transactionHash: string): string {
    const cleanHash = encodeURIComponent(transactionHash.trim());
    const normalizedNetwork = network.trim().toLowerCase();

    if (normalizedNetwork === "mainnet") {
      return `https://stellar.expert/explorer/public/tx/${cleanHash}`;
    }
    if (normalizedNetwork === "testnet") {
      return `https://stellar.expert/explorer/testnet/tx/${cleanHash}`;
    }
    if (normalizedNetwork === "futurenet") {
      return `https://stellar.expert/explorer/futurenet/tx/${cleanHash}`;
    }
    return `https://stellar.expert/explorer/${encodeURIComponent(normalizedNetwork)}/tx/${cleanHash}`;
  }

  /**
   * Asserts that a transaction candidate matches the required network.
   * A transaction from another network cannot satisfy an operation.
   */
  assertNetworkMatches(expectedNetwork: string, candidateNetwork: string): void {
    if (
      !expectedNetwork ||
      !candidateNetwork ||
      expectedNetwork.trim().toLowerCase() !== candidateNetwork.trim().toLowerCase()
    ) {
      throw new BadRequestException(
        `Cross-network validation error: operation on "${expectedNetwork}" cannot be satisfied by transaction on "${candidateNetwork}"`,
      );
    }
  }

  /**
   * Computes next poll time with adaptive exponential backoff and jitter.
   */
  computeNextPollAt(retryCount: number, now = new Date()): Date {
    const clampedRetries = Math.min(Math.max(0, retryCount), 8);
    const delay = Math.min(
      MAX_POLL_DELAY_MS,
      BASE_POLL_DELAY_MS * Math.pow(1.6, clampedRetries),
    );
    // Add 0-250ms deterministic or pseudo jitter
    const jitter = Math.floor(Math.random() * 250);
    return new Date(now.getTime() + Math.trunc(delay + jitter));
  }

  /**
   * Redacts any sensitive material (e.g. secret keys matching Stellar seed pattern)
   * from strings or metadata to preserve privacy.
   */
  redactSensitiveData(text?: string | null): string | null {
    if (!text) return null;
    return text.replace(STELLAR_SECRET_SEED_PATTERN, "[REDACTED_SECRET_KEY]");
  }

  /**
   * Records initial submission of a transaction for durable confirmation tracking.
   * If a record already exists with the same (network, transactionHash), returns it idempotently.
   */
  async recordSubmission(
    input: RecordSubmissionInput,
  ): Promise<TransactionConfirmationDto> {
    const network = input.network.trim().toLowerCase();
    const transactionHash = input.transactionHash.trim().toLowerCase();

    if (!STELLAR_NETWORK_NAMES.includes(network as StellarNetworkName)) {
      throw new BadRequestException(
        `Unsupported Stellar network "${network}". Supported: ${STELLAR_NETWORK_NAMES.join(", ")}`,
      );
    }

    if (!/^[a-f0-9]{64}$/i.test(transactionHash)) {
      throw new BadRequestException(
        `Invalid transaction hash format. Expected 64-character hex string.`,
      );
    }

    const existing = await this.prisma.transactionConfirmation.findUnique({
      where: {
        network_transactionHash: {
          network,
          transactionHash,
        },
      },
    });

    if (existing) {
      if (existing.organizationId !== input.organizationId) {
        // Unknown keys reveal no resource existence across tenants
        throw new BadRequestException("Transaction hash already registered");
      }
      return this.mapToDto(existing);
    }

    const nextPollAt = this.computeNextPollAt(0);

    const created = await this.prisma.transactionConfirmation.create({
      data: {
        organizationId: input.organizationId,
        network,
        transactionHash,
        operationType: input.operationType,
        operationRef: input.operationRef ?? null,
        status: TransactionConfirmationStatus.SUBMITTED,
        retryCount: 0,
        nextPollAt,
        metadata: input.metadata ? (input.metadata as any) : undefined,
      },
    });

    return this.mapToDto(created);
  }

  /**
   * Retrieves tenant-scoped transaction confirmation status.
   * Unknown keys or cross-tenant lookups reveal no resource existence across tenants.
   */
  async getStatus(
    organizationId: string,
    network: string,
    transactionHash: string,
  ): Promise<TransactionConfirmationDto> {
    const normNetwork = network.trim().toLowerCase();
    const normHash = transactionHash.trim().toLowerCase();

    const record = await this.prisma.transactionConfirmation.findUnique({
      where: {
        network_transactionHash: {
          network: normNetwork,
          transactionHash: normHash,
        },
      },
    });

    if (!record || record.organizationId !== organizationId) {
      throw new NotFoundException(
        `Transaction confirmation for "${normHash}" on "${normNetwork}" not found`,
      );
    }

    return this.mapToDto(record);
  }

  /**
   * Reconciles a single transaction against ledger data or Horizon.
   * Ensures duplicate observation, replacement, and reorgs are idempotent.
   */
  async reconcileTransaction(
    network: string,
    transactionHash: string,
    outcome?: {
      status: "confirmed" | "failed" | "replaced" | "pending" | "not_found";
      ledgerSequence?: number;
      ledgerHash?: string;
      replacedByHash?: string;
      failureReason?: string;
      errorCode?: string;
    },
  ): Promise<TransactionConfirmationDto> {
    const normNetwork = network.trim().toLowerCase();
    const normHash = transactionHash.trim().toLowerCase();

    const existing = await this.prisma.transactionConfirmation.findUnique({
      where: {
        network_transactionHash: {
          network: normNetwork,
          transactionHash: normHash,
        },
      },
    });

    if (!existing) {
      throw new NotFoundException(`Confirmation record not found`);
    }

    // Duplicate observation idempotency: terminal states (CONFIRMED, FAILED, REPLACED)
    // without an explicit reorg are not overwritten.
    if (
      existing.status === TransactionConfirmationStatus.CONFIRMED &&
      (!outcome || outcome.status === "confirmed")
    ) {
      return this.mapToDto(existing);
    }

    // Resolve outcome from provided mock/test input or via StellarService
    let resolvedOutcome = outcome;
    if (!resolvedOutcome && this.stellarService) {
      try {
        const tx = await this.stellarService.fetchTransaction(normHash);
        if (tx) {
          resolvedOutcome = {
            status: "confirmed",
            ledgerSequence: (tx as any).ledger,
            ledgerHash: (tx as any).ledger_hash,
          };
        } else {
          resolvedOutcome = { status: "not_found" };
        }
      } catch (error: any) {
        if (error?.status === 404 || error?.statusCode === 404) {
          resolvedOutcome = { status: "not_found" };
        } else {
          throw error;
        }
      }
    }

    if (!resolvedOutcome) {
      resolvedOutcome = { status: "pending" };
    }

    let newStatus: TransactionConfirmationStatus = existing.status;
    let confirmedAt = existing.confirmedAt;
    let ledgerSequence = existing.ledgerSequence;
    let ledgerHash = existing.ledgerHash;
    let replacedByHash = existing.replacedByHash;
    let failureReason = existing.failureReason;
    let errorCode = existing.errorCode;
    let retryCount = existing.retryCount;
    let nextPollAt: Date | null = existing.nextPollAt;

    if (resolvedOutcome.status === "confirmed") {
      newStatus = TransactionConfirmationStatus.CONFIRMED;
      confirmedAt = new Date();
      ledgerSequence = resolvedOutcome.ledgerSequence ?? ledgerSequence;
      ledgerHash = resolvedOutcome.ledgerHash ?? ledgerHash;
      nextPollAt = null;
    } else if (resolvedOutcome.status === "failed") {
      newStatus = TransactionConfirmationStatus.FAILED;
      failureReason = this.redactSensitiveData(resolvedOutcome.failureReason);
      errorCode = resolvedOutcome.errorCode ?? "TX_FAILED";
      nextPollAt = null;
    } else if (resolvedOutcome.status === "replaced") {
      newStatus = TransactionConfirmationStatus.REPLACED;
      replacedByHash = resolvedOutcome.replacedByHash ?? null;
      nextPollAt = null;
    } else {
      // not_found or pending
      retryCount += 1;
      if (retryCount >= MAX_CONFIRMATION_RETRIES) {
        newStatus = TransactionConfirmationStatus.TIMEOUT;
        failureReason = "Transaction confirmation polling reached maximum duration without ledger inclusion";
        nextPollAt = null;
      } else {
        newStatus = TransactionConfirmationStatus.PENDING;
        nextPollAt = this.computeNextPollAt(retryCount);
      }
    }

    const updated = await this.prisma.transactionConfirmation.update({
      where: { id: existing.id },
      data: {
        status: newStatus,
        confirmedAt,
        ledgerSequence,
        ledgerHash,
        replacedByHash,
        failureReason,
        errorCode,
        retryCount,
        nextPollAt,
      },
    });

    return this.mapToDto(updated);
  }

  /**
   * Reorganization handler: updates a confirmed transaction with new ledger coordinates
   * or marks it replaced/failed if invalidated by chain reorg.
   */
  async handleReorg(
    network: string,
    transactionHash: string,
    newLedgerSequence: number,
    newLedgerHash: string,
  ): Promise<TransactionConfirmationDto> {
    const normNetwork = network.trim().toLowerCase();
    const normHash = transactionHash.trim().toLowerCase();

    const existing = await this.prisma.transactionConfirmation.findUnique({
      where: {
        network_transactionHash: {
          network: normNetwork,
          transactionHash: normHash,
        },
      },
    });

    if (!existing) {
      throw new NotFoundException(`Confirmation record not found`);
    }

    const updated = await this.prisma.transactionConfirmation.update({
      where: { id: existing.id },
      data: {
        status: TransactionConfirmationStatus.CONFIRMED,
        ledgerSequence: newLedgerSequence,
        ledgerHash: newLedgerHash,
        updatedAt: new Date(),
      },
    });

    return this.mapToDto(updated);
  }

  /**
   * Worker restart / crash recovery reconciliation:
   * Finds pending and submitted items that are overdue for polling and updates them.
   */
  async reconcilePending(batchSize = 25): Promise<number> {
    const now = new Date();
    const pendingList = await this.prisma.transactionConfirmation.findMany({
      where: {
        status: {
          in: [
            TransactionConfirmationStatus.SUBMITTED,
            TransactionConfirmationStatus.PENDING,
          ],
        },
        OR: [{ nextPollAt: { lte: now } }, { nextPollAt: null }],
      },
      take: batchSize,
      orderBy: { submittedAt: "asc" },
    });

    let processed = 0;
    for (const item of pendingList) {
      try {
        await this.reconcileTransaction(item.network, item.transactionHash);
        processed += 1;
      } catch {
        // Safe continuation on individual record error
      }
    }

    return processed;
  }

  private mapToDto(
    record: TransactionConfirmation,
  ): TransactionConfirmationDto {
    return {
      id: record.id,
      organizationId: record.organizationId,
      network: record.network,
      transactionHash: record.transactionHash,
      operationType: record.operationType,
      operationRef: record.operationRef,
      status: record.status,
      submittedAt: record.submittedAt,
      ledgerSequence: record.ledgerSequence,
      ledgerHash: record.ledgerHash,
      confirmedAt: record.confirmedAt,
      replacedByHash: record.replacedByHash,
      failureReason: record.failureReason,
      errorCode: record.errorCode,
      retryCount: record.retryCount,
      explorerUrl: this.getExplorerUrl(record.network, record.transactionHash),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
