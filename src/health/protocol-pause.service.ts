import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

export interface UpdatePauseStateInput {
  network: string;
  contractId: string;
  isPaused: boolean;
  scopes?: string[];
  incidentCommitment?: string | null;
  observedLedger: bigint;
}

export interface ProtocolPauseStateResponseDto {
  network: string;
  contractId: string;
  isPaused: boolean;
  scopes: string[];
  incidentCommitment: string | null;
  observedLedger: string | null;
  lastCheckedAt: Date;
  isFresh: boolean;
}

const FRESHNESS_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class ProtocolPauseService {
  private readonly logger = new Logger(ProtocolPauseService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record or update observed pause state from contracts or indexer.
   * Monotonic: avoids regressing state on older ledgers.
   */
  async updatePauseState(input: UpdatePauseStateInput): Promise<ProtocolPauseStateResponseDto> {
    const existing = await this.prisma.protocolPauseState.findUnique({
      where: {
        network_contractId: {
          network: input.network,
          contractId: input.contractId,
        },
      },
    });

    if (existing && existing.observedLedger && input.observedLedger < existing.observedLedger) {
      // Reorg or out-of-order event: do not regress state
      this.logger.warn("Ignored stale pause state update due to older observed ledger", {
        existingLedger: existing.observedLedger.toString(),
        receivedLedger: input.observedLedger.toString(),
      });
      return this.formatDto(existing);
    }

    const now = new Date();
    const pauseObservedAt = input.isPaused ? (existing?.pauseObservedAt ?? now) : null;
    const unpauseObservedAt = !input.isPaused ? (existing?.unpauseObservedAt ?? now) : null;

    const saved = await this.prisma.protocolPauseState.upsert({
      where: {
        network_contractId: {
          network: input.network,
          contractId: input.contractId,
        },
      },
      update: {
        isPaused: input.isPaused,
        scopes: input.scopes ?? [],
        incidentCommitment: input.incidentCommitment ?? null,
        lastCheckedAt: now,
        observedLedger: input.observedLedger,
        pauseObservedAt,
        unpauseObservedAt,
      },
      create: {
        network: input.network,
        contractId: input.contractId,
        isPaused: input.isPaused,
        scopes: input.scopes ?? [],
        incidentCommitment: input.incidentCommitment ?? null,
        lastCheckedAt: now,
        observedLedger: input.observedLedger,
        pauseObservedAt,
        unpauseObservedAt,
      },
    });

    if (existing && existing.isPaused !== input.isPaused) {
      this.logger.warn(`Protocol pause state changed for contract ${input.contractId} on ${input.network}`, {
        isPaused: input.isPaused,
        scopes: input.scopes,
        incidentCommitment: input.incidentCommitment,
      });
    }

    return this.formatDto(saved);
  }

  /**
   * Get effective pause state for a given contract.
   * Fail closed: If projection is stale (> 5 mins since last verification), fail closed
   * or report degraded freshness so caller does not assume unpaused.
   */
  async getPauseState(
    network: string,
    contractId: string,
  ): Promise<ProtocolPauseStateResponseDto> {
    const state = await this.prisma.protocolPauseState.findUnique({
      where: {
        network_contractId: {
          network,
          contractId,
        },
      },
    });

    if (!state) {
      // Unknown state: fail closed, consider paused with UNKNOWN scope
      return {
        network,
        contractId,
        isPaused: true,
        scopes: ["UNKNOWN_CONTRACT"],
        incidentCommitment: null,
        observedLedger: null,
        lastCheckedAt: new Date(),
        isFresh: false,
      };
    }

    return this.formatDto(state);
  }

  /**
   * List all known contract pause states across a network.
   */
  async listPauseStates(network: string): Promise<ProtocolPauseStateResponseDto[]> {
    const states = await this.prisma.protocolPauseState.findMany({
      where: { network },
      orderBy: { updatedAt: "desc" },
    });
    return states.map((s) => this.formatDto(s));
  }

  private formatDto(record: any): ProtocolPauseStateResponseDto {
    const now = Date.now();
    const lastChecked = new Date(record.lastCheckedAt).getTime();
    const isFresh = now - lastChecked <= FRESHNESS_THRESHOLD_MS;

    // Fail closed principle: stale projection cannot claim contract is unpaused
    const effectiveIsPaused = !isFresh ? true : record.isPaused;

    return {
      network: record.network,
      contractId: record.contractId,
      isPaused: effectiveIsPaused,
      scopes: record.scopes ?? [],
      incidentCommitment: record.incidentCommitment,
      observedLedger: record.observedLedger ? record.observedLedger.toString() : null,
      lastCheckedAt: record.lastCheckedAt,
      isFresh,
    };
  }
}
