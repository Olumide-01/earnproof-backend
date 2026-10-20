import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Payment,
  PaymentClassification,
  Prisma,
  ResourceStatus,
} from "@prisma/client";
import { canonicalAssetId } from "../common/assets/asset-identifier";
import { encryptProtectedAmount } from "../common/crypto/protected-amount";
import { PaymentEncryptionKeyringService } from "../common/crypto/payment-encryption-keyring.service";
import {
  buildPage,
  cursorOrderBy,
  cursorWhereFragment,
} from "../common/pagination/keyset-paginate";
import { PrismaService } from "../database/prisma.service";
import { OrganizationQuotaService } from "../quotas/organization-quota.service";
import { StellarService } from "../stellar/stellar.service";
import { normalizeMemoDetailed, normalizeMemo } from "../stellar/memo-normalizer";
import { StoredMemo, decodeStoredMemo, encodeStoredMemo } from "./payment-memo";
import { ledgerSequenceFromPagingToken } from "../stellar/ledger-finality";
import { NormalizedMemo, NormalizedPayment } from "../stellar/stellar.types";
import {
  FinalityOutcome,
  PaymentFinalityService,
} from "./payment-finality.service";
import { operationIndexFromToid } from "../stellar/operation-identity";
import { PaymentEligibilityService } from "./payment-eligibility.service";
import { PaymentClassificationHistoryService } from "./payment-classification-history.service";
import { PaymentAddressCipher } from "../common/crypto/payment-address-cipher";
import { PaymentAccountResolver } from "./payment-account.resolver";

/**
 * A plan is re-read at most once per sync: when a forward read diverges, the
 * same call switches to reconciliation and reads again. A second divergence is
 * left for the next sync rather than looping against an inconsistent Horizon.
 */
const MAX_READS_PER_SYNC = 2;

@Injectable()
export class PaymentsService {
  private readonly stellarNetwork: string;
  private readonly paymentEncryptionKeyring: PaymentEncryptionKeyringService;
  private readonly addressCipher: PaymentAddressCipher;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellarService: StellarService,
    private readonly configService: ConfigService,
    private readonly finality: PaymentFinalityService,
    private readonly classificationHistoryService: PaymentClassificationHistoryService,
    private readonly eligibility: PaymentEligibilityService,
    @Optional() private readonly accounts?: PaymentAccountResolver,
  ) {
    this.paymentEncryptionKeyring = new PaymentEncryptionKeyringService(
      configService,
    );
    this.addressCipher = this.paymentEncryptionKeyring.addressCipher();
    this.stellarNetwork = configService.getOrThrow<string>("stellar.network");
  }

  /**
   * Synchronises incoming payments behind the wallet's ledger checkpoint.
   *
   * The checkpoint is re-proved against Horizon before any page is read, and
   * every read is inspected before any row is written. A read that contradicts
   * the verified view writes nothing: the affected payments are held from proof
   * issuance and a bounded reconciliation decides what survives. See
   * docs/ledger-finality.md.
   */
  async syncPayments(user: { id: string; walletAddress: string }) {
    // The indexed account is the active monitored account after a payment
    // account rotation (#321), and the wallet otherwise — unchanged for users
    // who never rotated, and for wiring without the resolver.
    if (!this.accounts) return this.syncAccount(user);
    const account = await this.accounts.current(user);
    try {
      return await this.syncAccount({ id: user.id, walletAddress: account.accountId });
    } finally {
      await this.accounts.discardStaleCheckpoint(user, account);
    }
  }

  private async syncAccount(user: { id: string; walletAddress: string }) {
    let plan = await this.finality.plan(user.id);
    // Resolved here rather than in the constructor: the network stamps every
    // synced payment's canonical identity, but classification-only call paths
    // never touch it, so requiring it at construction would over-couple them.
    const network = this.configService.getOrThrow<string>("stellar.network");
    const incomingPayments = await this.stellarService.fetchIncomingPayments(
      user.walletAddress,
    );
    // Eligibility is governed by the active asset definition for THIS
    // deployment's network. Without the network filter, a SupportedAsset row
    // seeded for a different network (e.g. mainnet) with the same code/issuer
    // as a testnet row - which happens for the native asset, since it has no
    // issuer to disambiguate networks - could make a payment eligible based
    // on the wrong network's policy.
    const supportedAssets = await this.prisma.supportedAsset.findMany({
      where: {
        status: ResourceStatus.ACTIVE,
        network: this.stellarNetwork,
      },
      select: {
        code: true,
        issuer: true,
        network: true,
      },
    });
    const supportedAssetKeys = new Set(
      supportedAssets.map((asset) =>
        canonicalAssetId({
          network: asset.network,
          code: asset.code,
          issuer: asset.issuer,
        }),
      ),
    );

    for (let reads = 1; ; reads += 1) {
      const read = await this.stellarService.readIncomingPayments(
        user.walletAddress,
        this.finality.readOptions(plan),
      );
      const incomingPayments = read.payments;

      // Batch the "does this payment already exist" check into a single query
      // ahead of the loop, instead of one findUnique per incoming payment.
      // incomingPayments comes from Stellar Horizon and can run into the
      // hundreds for an active wallet; a query per row turned a sync into N+1
      // round trips to the database on top of the (already-batched) N calls to
      // Horizon for memo enrichment.
      const stored = new Map(
        (
          await this.prisma.payment.findMany({
            where: {
              operationId: {
                in: incomingPayments.map((payment) => payment.operationId),
              },
            },
            select: { operationId: true, stellarTransactionHash: true, userId: true },
          })
        ).map((row) => [
          row.operationId,
          { transactionHash: row.stellarTransactionHash, userId: row.userId },
        ]),
      );

      const divergence = this.finality.inspect(plan, read, stored, user.id);
      if (divergence) {
        if (plan.mode === "resume" && reads < MAX_READS_PER_SYNC) {
          plan = await this.finality.diverge(user.id, plan.checkpoint, divergence);
          continue;
        }
        return this.syncResult(
          incomingPayments.length,
          { created: 0, updated: 0, skipped: 0, enrichmentErrors: 0 },
          await this.finality.diverged(user.id, divergence),
        );
      }

      const counts = await this.writePayments(
        user.id,
        incomingPayments,
        stored,
        this.finality.replacements(read, stored, user.id),
        supportedAssetKeys,
      );
      const finality = await this.finality.settle(user.id, plan, read, counts);
      return this.syncResult(incomingPayments.length, counts, finality);
    }
  }

  private async writePayments(
    userId: string,
    incomingPayments: NormalizedPayment[],
    stored: ReadonlyMap<string, unknown>,
    replaced: ReadonlySet<string>,
    supportedAssetKeys: ReadonlySet<string>,
  ) {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let rewritten = 0;
    let enrichmentErrors = 0;
    // Keyed by transaction: every operation in a transaction shares its memo,
    // and caching the encoded form keeps the stored value identical for all
    // of them.
    const memoCache = new Map<string, StoredMemo>();
    let conflicts = 0;
    const syncedPaymentIds: string[] = [];

    for (const payment of incomingPayments) {
      const isEligible = supportedAssetKeys.has(
        canonicalAssetId({
          network: this.stellarNetwork,
          code: payment.assetCode,
          issuer: payment.assetIssuer,
        }),
      );

      if (!isEligible) {
        skipped += 1;
      }

      let memoContext = memoCache.get(payment.stellarTransactionHash);
      if (!memoContext) {
        try {
          const transaction = await this.stellarService.fetchTransaction(
            payment.stellarTransactionHash,
          );
          if (!transaction) {
            enrichmentErrors += 1;
          }
          memoContext = encodeStoredMemo(
            normalizeMemoDetailed(transaction),
            this.paymentEncryptionKeyring,
          );
        } catch {
          enrichmentErrors += 1;
          memoContext = encodeStoredMemo(
            { memo: { type: "none" } },
            this.paymentEncryptionKeyring,
          );
        }
        memoCache.set(payment.stellarTransactionHash, memoContext);
      }

      const existing = stored.has(payment.operationId);
      const ledgerContext = {
        pagingToken: payment.pagingToken ?? null,
        ledgerSequence: ledgerSequenceFromPagingToken(payment.pagingToken),
        // Written only from a read that passed finality inspection, so the
        // record is confirmed by a consistent view and any hold is lifted.
        finalityHoldAt: null,
        finalityHoldReason: null,
      };
      const content = {
        userId,
        stellarTransactionHash: payment.stellarTransactionHash,
        sourceAddress: payment.sourceAddress,
        destinationAddress: payment.destinationAddress,
        assetCode: payment.assetCode,
        assetIssuer: payment.assetIssuer,
        amountEncrypted: this.protectAmount(payment.amount),
        occurredAt: payment.occurredAt,
        memo: memoContext as Prisma.InputJsonValue,
        isEligible,
        ...ledgerContext,
      };

      // A replaced operation id now names a different payment. Its stored
      // content — and the owner's classification of it — described the old
      // one, so it is rebuilt from Horizon and must be classified again.
      const isReplaced = replaced.has(payment.operationId);

      await this.prisma.payment.upsert({
        where: {
          operationId: payment.operationId,
        },
        update: isReplaced
          ? { ...content, classification: PaymentClassification.UNKNOWN }
          : {
              isEligible,
              occurredAt: payment.occurredAt,
              memo: memoContext as Prisma.InputJsonValue,
              ...ledgerContext,
            },
        create: {
          ...content,
          operationId: payment.operationId,
          classification: PaymentClassification.UNKNOWN,
        },
      });
      // The operation index comes from the operation id (a Horizon TOID) and,
      // with the network and transaction hash, forms the payment's canonical
      // identity. Persisting it lets two payment operations in the same
      // transaction remain distinct, and lets a reorg replay or a backfill key
      // on the same identity as the live sync.
      const operationIndex =
        payment.operationIndex ??
        operationIndexFromToid(payment.operationId);

      try {
        // Reprocessing the same operation is idempotent: the upsert keys on the
        // globally-unique operationId, so a replayed page updates the row in
        // place. The composite unique on (network, txHash, operationIndex)
        // rejects a genuinely conflicting duplicate — a different operationId
        // claiming an identity that already belongs to another row — which
        // surfaces here as P2002 and is counted rather than allowed to corrupt
        // the ledger or fail the whole sync.
        await this.prisma.payment.upsert({
          where: {
            operationId: payment.operationId,
          },
          update: {
            isEligible,
            occurredAt: payment.occurredAt,
            memo: memoContext as Prisma.InputJsonValue,
            network: this.stellarNetwork,
            operationIndex,
          },
          create: {
            userId: userId,
            network: this.stellarNetwork,
            operationId: payment.operationId,
            operationIndex,
            stellarTransactionHash: payment.stellarTransactionHash,
            sourceAddress: payment.sourceAddress,
            destinationAddress: payment.destinationAddress,
            assetCode: payment.assetCode,
            assetIssuer: payment.assetIssuer,
            amountEncrypted: this.protectAmount(payment.amount),
            occurredAt: payment.occurredAt,
            memo: memoContext as Prisma.InputJsonValue,
            classification: PaymentClassification.UNKNOWN,
            isEligible,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          conflicts += 1;
          continue;
        }
        throw error;
      }

      if (isReplaced) rewritten += 1;
      if (existing) {
        updated += 1;
      } else {
        created += 1;
      }
    }

    return { created, updated, skipped, enrichmentErrors, rewritten };
  }

  private syncResult(
    totalFetched: number,
    counts: { created: number; updated: number; skipped: number; enrichmentErrors: number },
    finality: FinalityOutcome,
  ) {
    return {
      totalFetched,
      created: counts.created,
      updated: counts.updated,
      skipped: counts.skipped,
      enrichmentErrors: counts.enrichmentErrors,
      finality,
    };
  }

  async listPayments(
    userId: string,
    filters: {
      classification?: PaymentClassification;
      assetCode?: string;
      cursor?: string;
      limit?: number;
    },
  ) {
    const limit = filters.limit ?? 20;
    const cursorWhere = cursorWhereFragment(filters.cursor, "occurredAt");
    const payments = await this.prisma.payment.findMany({
      where: {
        userId,
        classification: filters.classification,
        assetCode: filters.assetCode,
        ...(cursorWhere as Prisma.PaymentWhereInput),
      },
      orderBy: cursorOrderBy("occurredAt"),
      take: limit + 1,
    });

    const { data, pageInfo } = buildPage(payments, limit, "occurredAt");

    return {
      data: data.map((payment) => this.toPaymentDto(payment)),
      pageInfo,
    };
  }

  async getPayment(userId: string, paymentId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        userId,
      },
    });

    if (!payment) {
      throw new NotFoundException("Payment not found");
    }

    return this.toPaymentDto(payment);
  }

  async updateClassification(
    user: { id: string },
    paymentId: string,
    classification: PaymentClassification,
    reasonCode: string = "USER_RECLASSIFICATION",
  ) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        userId: user.id,
      },
      select: {
        id: true,
        classification: true,
        classificationRevision: true,
        assetCode: true,
        assetIssuer: true,
        isEligible: true,
      },
    });

    if (!payment) {
      throw new NotFoundException("Payment not found");
    }

    // Skip update if classification is the same (no-op change)
    if (payment.classification === classification) {
      return this.toPaymentDto(
        await this.prisma.payment.findUniqueOrThrow({
          where: { id: paymentId },
        }),
      );
    }

    // Atomic transaction: update payment and create history record
    const result = await this.prisma.$transaction(async (tx) => {
      const newRevision = payment.classificationRevision + 1;

      // Update the payment with new classification and incremented revision
      const updatedPayment = await tx.payment.update({
        where: { id: payment.id },
        data: {
          classification,
          classificationRevision: newRevision,
        },
      });

      // Create immutable history record
      await tx.paymentClassificationHistory.create({
        data: {
          paymentId: payment.id,
          actorId: user.id,
          previousClassification: payment.classification,
          newClassification: classification,
          reasonCode,
          classificationRevision: newRevision,
        },
      });

      return updatedPayment;
    });

    // Create audit log entry (outside transaction to avoid coupling)
    await this.prisma.auditLog.create({
      data: {
        actorType: "user",
        actorId: user.id,
        action: "payment.classification.updated",
        resourceType: "payment",
        resourceId: payment.id,
        metadata: {
          previousClassification: payment.classification,
          nextClassification: classification,
          classificationRevision: result.classificationRevision,
          reasonCode,
          assetCode: payment.assetCode,
          assetIssuer: payment.assetIssuer,
          isEligible: payment.isEligible,
        },
      },
    });

    await this.eligibility.evaluatePayments(
      user.id,
      [payment.id],
      "classification_changed",
    );

    return this.toPaymentDto(result);
  }

  async explainEligibility(userId: string, paymentId: string) {
    return this.eligibility.explain(userId, paymentId);
  }

  private protectAmount(amount: string) {
    return this.paymentEncryptionKeyring.encrypt(amount);
  }

  private toPaymentDto(payment: Payment) {
    return {
      id: payment.id,
      network: payment.network,
      operationId: payment.operationId,
      operationIndex: payment.operationIndex,
      stellarTransactionHash: payment.stellarTransactionHash,
      // Owner-only DTO. A row whose ciphertext cannot be read shows null
      // rather than failing the whole listing or exposing the stored value.
      sourceAddress: this.addressCipher.tryReveal(
        { encrypted: payment.sourceAddressEncrypted, plaintext: payment.sourceAddress },
        "source",
      ),
      destinationAddress: this.addressCipher.tryReveal(
        {
          encrypted: payment.destinationAddressEncrypted,
          plaintext: payment.destinationAddress,
        },
        "destination",
      ),
      assetCode: payment.assetCode,
      assetIssuer: payment.assetIssuer,
      occurredAt: payment.occurredAt,
      classification: payment.classification,
      classificationRevision: payment.classificationRevision,
      isEligible: payment.isEligible,
      finalityHeld: payment.finalityHoldAt !== null,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
      memoContext: this.readMemoContext(payment.memo),
    };
  }

  private readMemoContext(memo: Prisma.JsonValue | null): NormalizedMemo {
    return decodeStoredMemo(memo, this.paymentEncryptionKeyring);
  }
}
