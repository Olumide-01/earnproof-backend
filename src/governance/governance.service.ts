import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, ProposalLifecycleState } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";

export interface ProjectProposalInput {
  network: string;
  contractId: string;
  proposalId: string;
  proposerAddress: string;
  action: string;
  actionPayload: Record<string, unknown>;
  rawPayloadHash: string;
  status?: ProposalLifecycleState;
  cooldownUntil?: Date;
  expiresAt?: Date;
  observedLedger: bigint;
}

export interface GovernanceProposalResponseDto {
  id: string;
  network: string;
  contractId: string;
  proposalId: string;
  proposerAddress: string;
  action: string;
  actionPayload: unknown;
  rawPayloadHash: string;
  status: ProposalLifecycleState;
  cooldownUntil: Date | null;
  executedAt: Date | null;
  cancelledAt: Date | null;
  expiresAt: Date | null;
  observedLedger: string;
  observedAt: Date;
  isActionable: boolean;
}

const TERMINAL_STATES: ReadonlySet<ProposalLifecycleState> = new Set([
  ProposalLifecycleState.EXECUTED,
  ProposalLifecycleState.CANCELLED,
  ProposalLifecycleState.EXPIRED,
]);

@Injectable()
export class GovernanceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Project/hydrate proposal state from contract events.
   * Monotonic: does not allow replayed older ledgers to regress terminal states.
   */
  async projectProposal(input: ProjectProposalInput): Promise<GovernanceProposalResponseDto> {
    const existing = await this.prisma.contractGovernanceProposal.findUnique({
      where: {
        network_contractId_proposalId: {
          network: input.network,
          contractId: input.contractId,
          proposalId: input.proposalId,
        },
      },
    });

    if (existing) {
      // Monotonic guard: cannot regress terminal states
      if (TERMINAL_STATES.has(existing.status)) {
        return this.formatDto(existing);
      }

      // Reorg/reorder guard: ignore events observed on an older ledger
      if (input.observedLedger < existing.observedLedger) {
        return this.formatDto(existing);
      }

      const updated = await this.prisma.contractGovernanceProposal.update({
        where: { id: existing.id },
        data: {
          status: input.status ?? existing.status,
          cooldownUntil: input.cooldownUntil ?? existing.cooldownUntil,
          expiresAt: input.expiresAt ?? existing.expiresAt,
          observedLedger: input.observedLedger,
          observedAt: new Date(),
        },
      });
      return this.formatDto(updated);
    }

    const created = await this.prisma.contractGovernanceProposal.create({
      data: {
        network: input.network,
        contractId: input.contractId,
        proposalId: input.proposalId,
        proposerAddress: input.proposerAddress,
        action: input.action,
        actionPayload: input.actionPayload as Prisma.InputJsonValue,
        rawPayloadHash: input.rawPayloadHash,
        status: input.status ?? ProposalLifecycleState.PROPOSED,
        cooldownUntil: input.cooldownUntil,
        expiresAt: input.expiresAt,
        observedLedger: input.observedLedger,
      },
    });

    return this.formatDto(created);
  }

  async markExecuted(
    network: string,
    contractId: string,
    proposalId: string,
    observedLedger: bigint,
  ): Promise<GovernanceProposalResponseDto> {
    const existing = await this.getProposalOrThrow(network, contractId, proposalId);
    if (existing.status === ProposalLifecycleState.CANCELLED || existing.status === ProposalLifecycleState.EXPIRED) {
      throw new ConflictException(`Cannot execute proposal in ${existing.status} state`);
    }

    const updated = await this.prisma.contractGovernanceProposal.update({
      where: { id: existing.id },
      data: {
        status: ProposalLifecycleState.EXECUTED,
        executedAt: new Date(),
        observedLedger,
      },
    });
    return this.formatDto(updated);
  }

  async markCancelled(
    network: string,
    contractId: string,
    proposalId: string,
    observedLedger: bigint,
  ): Promise<GovernanceProposalResponseDto> {
    const existing = await this.getProposalOrThrow(network, contractId, proposalId);
    if (existing.status === ProposalLifecycleState.EXECUTED) {
      throw new ConflictException("Cannot cancel an executed proposal");
    }

    const updated = await this.prisma.contractGovernanceProposal.update({
      where: { id: existing.id },
      data: {
        status: ProposalLifecycleState.CANCELLED,
        cancelledAt: new Date(),
        observedLedger,
      },
    });
    return this.formatDto(updated);
  }

  async listProposals(
    network: string,
    contractId: string,
    options: { status?: ProposalLifecycleState; limit?: number } = {},
  ): Promise<GovernanceProposalResponseDto[]> {
    const limit = Math.min(options.limit ?? 50, 100);
    const where: Prisma.ContractGovernanceProposalWhereInput = {
      network,
      contractId,
    };
    if (options.status) {
      where.status = options.status;
    }

    const items = await this.prisma.contractGovernanceProposal.findMany({
      where,
      orderBy: { observedLedger: "desc" },
      take: limit,
    });

    return items.map((p) => this.formatDto(p));
  }

  async getProposal(
    network: string,
    contractId: string,
    proposalId: string,
  ): Promise<GovernanceProposalResponseDto> {
    const proposal = await this.getProposalOrThrow(network, contractId, proposalId);
    return this.formatDto(proposal);
  }

  private async getProposalOrThrow(network: string, contractId: string, proposalId: string) {
    const proposal = await this.prisma.contractGovernanceProposal.findUnique({
      where: {
        network_contractId_proposalId: {
          network,
          contractId,
          proposalId,
        },
      },
    });
    if (!proposal) {
      throw new NotFoundException(`Proposal ${proposalId} not found for contract ${contractId}`);
    }
    return proposal;
  }

  private formatDto(p: any): GovernanceProposalResponseDto {
    const isKnownAction = p.action !== "UNKNOWN" && Boolean(p.action);
    const isActionable =
      isKnownAction &&
      p.status === ProposalLifecycleState.PROPOSED &&
      (!p.expiresAt || new Date(p.expiresAt) > new Date()) &&
      (!p.cooldownUntil || new Date(p.cooldownUntil) <= new Date());

    return {
      id: p.id,
      network: p.network,
      contractId: p.contractId,
      proposalId: p.proposalId,
      proposerAddress: p.proposerAddress,
      action: p.action,
      actionPayload: p.actionPayload,
      rawPayloadHash: p.rawPayloadHash,
      status: p.status,
      cooldownUntil: p.cooldownUntil,
      executedAt: p.executedAt,
      cancelledAt: p.cancelledAt,
      expiresAt: p.expiresAt,
      observedLedger: p.observedLedger.toString(),
      observedAt: p.observedAt,
      isActionable,
    };
  }
}
