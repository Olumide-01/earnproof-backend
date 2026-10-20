import {
  HttpStatus,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AscendingPageOptions,
  AscendingPaymentsPage,
  HorizonClient,
  HorizonCancelledError,
  HorizonReadOptions,
  HorizonReadResult,
} from "./horizon-client";
import {
  HorizonLedgerSummary,
  HorizonOperationSummary,
  HorizonTransactionRecord,
  NormalizedPayment,
} from "./stellar.types";
import { HorizonException } from "../common/exceptions/domain.exceptions";
import { FetchHorizonTransport } from "./horizon-transport";
import { CircuitHorizonTransport } from "./horizon-circuit-transport";
import { CircuitBreakerRegistry } from "../common/resilience/circuit-breaker.registry";

/** Prefix for the per-network Horizon circuit name, kept stable for diagnostics. */
export const HORIZON_CIRCUIT_PREFIX = "horizon";

@Injectable()
export class StellarService {
  private readonly horizonUrl: string;
  private readonly horizon: HorizonClient;

  constructor(
    configService: ConfigService,
    /**
     * Injected only by tests, which supply a scripted transport and a no-op
     * sleep. Production builds its own client from configuration.
     */
    @Optional() horizonClient?: HorizonClient,
    /**
     * Optional so the test constructor (which injects a ready-made client)
     * need not provide it. Production resolves the shared registry, so the
     * Horizon circuit is the same instance the health diagnostics reads.
     */
    @Optional() registry?: CircuitBreakerRegistry,
  ) {
    this.horizonUrl = configService
      .getOrThrow<string>("stellar.horizonUrl")
      .replace(/\/$/, "");

    if (horizonClient) {
      this.horizon = horizonClient;
      return;
    }

    // One circuit per network: testnet being down says nothing about mainnet,
    // and a shared circuit would let one network's outage refuse the other's
    // traffic. The transport wrapper is skipped when no registry is available
    // (only in tests that inject their own client), so the client still works
    // without resilience wiring.
    const baseTransport = new FetchHorizonTransport();
    const network = registry
      ? configService.get<string>("stellar.network") ?? "testnet"
      : "testnet";
    const transport = registry
      ? new CircuitHorizonTransport(
          baseTransport,
          registry.getOrCreate({
            name: `${HORIZON_CIRCUIT_PREFIX}:${network}`,
            failureThreshold: configService.get<number>(
              "stellar.circuitBreaker.failureThreshold",
            ),
            openDurationMs: configService.get<number>(
              "stellar.circuitBreaker.openDurationMs",
            ),
            halfOpenMaxProbes: configService.get<number>(
              "stellar.circuitBreaker.halfOpenMaxProbes",
            ),
            successThreshold: configService.get<number>(
              "stellar.circuitBreaker.successThreshold",
            ),
          }),
        )
      : baseTransport;

    this.horizon = new HorizonClient({
      horizonUrl: this.horizonUrl,
      transport,
    });
  }

  /**
   * Incoming payments for a wallet, newest first.
   *
   * Delegates to {@link HorizonClient}, which walks Horizon's cursors, retries
   * only transient faults, and stops at an explicit page, record, or time
   * bound. Every Horizon failure is collapsed to one dependency error here: the
   * caller is an HTTP handler that can do nothing differently for a 429 than
   * for a 503, and the fault taxonomy that distinguishes them has already done
   * its work inside the retry loop.
   */
  async fetchIncomingPayments(
    walletAddress: string,
    options: HorizonReadOptions = {},
  ): Promise<NormalizedPayment[]> {
    const result = await this.readIncomingPayments(walletAddress, options);
    return result.payments;
  }

  /**
   * The full read result, including the resume cursor and what stopped the walk.
   *
   * Separate from {@link fetchIncomingPayments} so the common caller keeps its
   * simple array contract while a caller that wants to resume, or to alert on
   * malformed records, can reach the detail.
   */
  async readIncomingPayments(
    walletAddress: string,
    options: HorizonReadOptions = {},
  ): Promise<HorizonReadResult> {
    try {
      return await this.horizon.listIncomingPayments(walletAddress, options);
    } catch (error) {
      // Cancellation is the caller's own decision, not a dependency failure;
      // reporting it as one would make a client disconnect look like a Horizon
      // outage on the dashboards.
      if (error instanceof HorizonCancelledError) throw error;

      throw new ServiceUnavailableException(
        "Stellar Horizon is temporarily unavailable",
      );
    }
  }

  /**
   * One ledger's sequence and hash, or `null` when Horizon has no such ledger.
   *
   * Failures collapse to the same dependency error as the payment read: a
   * checkpoint that cannot be verified must stop the sync, not be assumed good.
   */
  async fetchLedger(sequence: number): Promise<HorizonLedgerSummary | null> {
    try {
      return await this.horizon.getLedger(sequence);
    } catch {
      throw new ServiceUnavailableException(
        "Stellar Horizon is temporarily unavailable",
      );
    }
  }

  /** One operation's identity, or `null` when Horizon has no such operation. */
  async fetchOperation(
    operationId: string,
  ): Promise<HorizonOperationSummary | null> {
    try {
      return await this.horizon.getOperation(operationId);
    } catch {
      throw new ServiceUnavailableException(
        "Stellar Horizon is temporarily unavailable",
      );
    }
  }

  async fetchTransaction(
    transactionHash: string,
  ): Promise<HorizonTransactionRecord | null> {
    const response = await fetch(
      `${this.horizonUrl}/transactions/${encodeURIComponent(transactionHash)}`,
    );

    if (!response.ok) {
      // Never echo the response body — Horizon errors can include the raw
      // request path/params, which for this endpoint includes the
      // transaction hash but could carry more in other Horizon error shapes.
      throw new HorizonException(
        "Stellar Horizon is temporarily unavailable",
        response.status === 404
          ? HttpStatus.NOT_FOUND
          : HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const transaction = (await response.json()) as HorizonTransactionRecord;
    return transaction && typeof transaction === "object" ? transaction : null;
  }

  async readPaymentsPageAscending(
    walletAddress: string,
    options: AscendingPageOptions,
  ): Promise<AscendingPaymentsPage> {
    return this.horizon.readPaymentsPageAscending(walletAddress, options);
  }
}
