import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import {
  RevocationCheckpointStatus,
  RevocationCheckpointQuarantineReason,
} from '@prisma/client';

export interface UpsertRevocationCheckpointInput {
  ledger: string;
  contractIdentity: string;
  algorithm: string;
  sequence: bigint;
  root: string;
  observedAt: Date;
}

export interface RevocationCheckpointFreshnessDto {
  sequence: string;
  root: string;
  observedAt: string;
  acceptedAt: string;
  age: {
    seconds: number;
    staleBeyond: boolean;
  };
}

export interface UpsertCheckpointResult {
  status: 'accepted' | 'quarantined';
  reason?: RevocationCheckpointQuarantineReason;
  head: {
    sequence: string;
    root: string;
    observedAt: string;
    acceptedAt: string;
  };
}

@Injectable()
export class RevocationCheckpointService {
  private readonly logger = new Logger(RevocationCheckpointService.name);
  private readonly freshnessThresholdMs = 3600000; // 1 hour default

  // Allowed algorithms for validation
  private readonly allowedAlgorithms = [
    'sha256',
    'merkle-tree-v1',
    'merkle-tree-v2',
  ];
  private readonly allowedLedgers = ['stellar', 'ethereum'];

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validate and normalize checkpoint input.
   * Throws BadRequestException on invalid input.
   */
  private validateInput(input: UpsertRevocationCheckpointInput): void {
    if (!input.ledger || !input.ledger.trim()) {
      throw new BadRequestException('ledger is required');
    }
    if (!this.allowedLedgers.includes(input.ledger)) {
      throw new BadRequestException(
        `ledger must be one of: ${this.allowedLedgers.join(', ')}`,
      );
    }

    if (!input.contractIdentity || !input.contractIdentity.trim()) {
      throw new BadRequestException('contractIdentity is required');
    }

    if (!input.algorithm || !input.algorithm.trim()) {
      throw new BadRequestException('algorithm is required');
    }
    if (!this.allowedAlgorithms.includes(input.algorithm)) {
      throw new BadRequestException(
        `algorithm must be one of: ${this.allowedAlgorithms.join(', ')}`,
      );
    }

    if (input.sequence < 0n) {
      throw new BadRequestException('sequence must be non-negative');
    }

    if (!input.root || !input.root.trim()) {
      throw new BadRequestException('root is required');
    }
    if (!/^[0-9a-f]+$/i.test(input.root)) {
      throw new BadRequestException('root must be a valid hex string');
    }

    if (input.observedAt > new Date()) {
      throw new BadRequestException('observedAt must not be in the future');
    }
  }

  /**
   * Upsert a revocation checkpoint with monotonicity enforcement.
   * 
   * Returns:
   * - status: 'accepted' if checkpoint advances the stream or is an identical replay
   * - status: 'quarantined' if checkpoint violates monotonicity
   * - head: current accepted head for the stream
   */
  async upsertCheckpoint(
    input: UpsertRevocationCheckpointInput,
  ): Promise<UpsertCheckpointResult> {
    // 1. Validate input
    this.validateInput(input);

    const streamKey = {
      ledger: input.ledger,
      contractIdentity: input.contractIdentity,
      algorithm: input.algorithm,
    };

    // 2. Read current head (if exists)
    const currentHead = await this.prisma.revocationCheckpointStreamHead.findUnique(
      {
        where: {
          stream_unique: streamKey,
        },
      },
    );

    // 3. Check for monotonicity violations
    const violations: RevocationCheckpointQuarantineReason[] = [];

    if (currentHead) {
      if (input.sequence < currentHead.sequence) {
        violations.push(RevocationCheckpointQuarantineReason.LOWER_SEQUENCE);
      } else if (
        input.sequence === currentHead.sequence &&
        input.root !== currentHead.root
      ) {
        violations.push(RevocationCheckpointQuarantineReason.SEQUENCE_CONFLICT);
      } else if (
        input.sequence === currentHead.sequence &&
        input.root === currentHead.root &&
        input.observedAt.getTime() === currentHead.observedAt.getTime()
      ) {
        // Identical replay: idempotent, return current head
        return {
          status: 'accepted',
          head: this.formatStreamHead(currentHead),
        };
      }
    }

    // 4. If violations exist, quarantine and return
    if (violations.length > 0) {
      const quarantineDetails = this.formatQuarantineDetails(violations, currentHead);

      try {
        // Upsert ensures idempotency: if same quarantined checkpoint already exists, it's a no-op
        await this.prisma.revocationCheckpoint.upsert({
          where: {
            checkpoint_idempotency: {
              ledger: input.ledger,
              contractIdentity: input.contractIdentity,
              algorithm: input.algorithm,
              sequence: input.sequence,
              root: input.root,
            },
          },
          create: {
            ledger: input.ledger,
            contractIdentity: input.contractIdentity,
            algorithm: input.algorithm,
            sequence: input.sequence,
            root: input.root,
            observedAt: input.observedAt,
            status: RevocationCheckpointStatus.QUARANTINED,
            quarantineReason: violations[0],
            quarantineDetails,
            quarantinedAt: new Date(),
          },
          update: {
            // Replay of same quarantined checkpoint: no-op
          },
        });
      } catch (error) {
        this.logger.error('Failed to create quarantined checkpoint', {
          input,
          error,
        });
        throw error;
      }

      this.logger.warn('Checkpoint quarantined', {
        ledger: input.ledger,
        contractIdentity: input.contractIdentity,
        algorithm: input.algorithm,
        sequence: input.sequence.toString(),
        reason: violations[0],
      });

      return {
        status: 'quarantined',
        reason: violations[0],
        head: currentHead ? this.formatStreamHead(currentHead) : this.formatStreamHeadForMissing(),
      };
    }

    // 5. No violations: accept and update head
    try {
      // Create the accepted checkpoint
      await this.prisma.revocationCheckpoint.create({
        data: {
          ledger: input.ledger,
          contractIdentity: input.contractIdentity,
          algorithm: input.algorithm,
          sequence: input.sequence,
          root: input.root,
          observedAt: input.observedAt,
          status: RevocationCheckpointStatus.ACCEPTED,
          acceptedAt: new Date(),
        },
      });

      // Update or create the stream head
      const newHead = await this.prisma.revocationCheckpointStreamHead.upsert({
        where: {
          stream_unique: streamKey,
        },
        create: {
          ledger: input.ledger,
          contractIdentity: input.contractIdentity,
          algorithm: input.algorithm,
          sequence: input.sequence,
          root: input.root,
          observedAt: input.observedAt,
          acceptedAt: new Date(),
          version: 1,
        },
        update: {
          sequence: input.sequence,
          root: input.root,
          observedAt: input.observedAt,
          acceptedAt: new Date(),
          version: { increment: 1 },
        },
      });

      this.logger.debug('Checkpoint accepted', {
        ledger: input.ledger,
        contractIdentity: input.contractIdentity,
        algorithm: input.algorithm,
        sequence: input.sequence.toString(),
      });

      return {
        status: 'accepted',
        head: this.formatStreamHead(newHead),
      };
    } catch (error) {
      this.logger.error('Failed to create accepted checkpoint', { input, error });
      throw error;
    }
  }

  /**
   * Get the latest accepted checkpoint (stream head) with freshness metadata.
   * Throws NotFoundException if no checkpoint exists for the stream.
   */
  async getFreshCheckpoint(
    ledger: string,
    contractIdentity: string,
    algorithm: string,
    freshnessThresholdMs?: number,
  ): Promise<RevocationCheckpointFreshnessDto> {
    const head = await this.prisma.revocationCheckpointStreamHead.findUnique({
      where: {
        stream_unique: {
          ledger,
          contractIdentity,
          algorithm,
        },
      },
    });

    if (!head) {
      throw new NotFoundException(
        `No checkpoint exists for stream: ${ledger}/${contractIdentity}/${algorithm}`,
      );
    }

    const threshold = freshnessThresholdMs ?? this.freshnessThresholdMs;
    const ageMs = Date.now() - head.acceptedAt.getTime();

    return {
      sequence: head.sequence.toString(),
      root: head.root,
      observedAt: head.observedAt.toISOString(),
      acceptedAt: head.acceptedAt.toISOString(),
      age: {
        seconds: Math.floor(ageMs / 1000),
        staleBeyond: ageMs > threshold,
      },
    };
  }

  /**
   * List quarantined checkpoints with optional filters.
   */
  async listQuarantined(filters: {
    ledger?: string;
    contractIdentity?: string;
    algorithm?: string;
    reason?: RevocationCheckpointQuarantineReason;
    limit?: number;
    offset?: number;
  }): Promise<{
    items: Array<{
      id: string;
      ledger: string;
      contractIdentity: string;
      algorithm: string;
      sequence: string;
      root: string;
      observedAt: string;
      quarantineReason: RevocationCheckpointQuarantineReason;
      quarantineDetails: string | null;
      quarantinedAt: string;
    }>;
    total: number;
  }> {
    const where: any = { status: RevocationCheckpointStatus.QUARANTINED };

    if (filters.ledger) where.ledger = filters.ledger;
    if (filters.contractIdentity) where.contractIdentity = filters.contractIdentity;
    if (filters.algorithm) where.algorithm = filters.algorithm;
    if (filters.reason) where.quarantineReason = filters.reason;

    const limit = Math.min(filters.limit ?? 50, 500);
    const offset = filters.offset ?? 0;

    const [items, total] = await Promise.all([
      this.prisma.revocationCheckpoint.findMany({
        where,
        select: {
          id: true,
          ledger: true,
          contractIdentity: true,
          algorithm: true,
          sequence: true,
          root: true,
          observedAt: true,
          quarantineReason: true,
          quarantineDetails: true,
          quarantinedAt: true,
        },
        orderBy: { quarantinedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.revocationCheckpoint.count({ where }),
    ]);

    return {
      items: items.map((item) => ({
        ...item,
        sequence: item.sequence.toString(),
        observedAt: item.observedAt.toISOString(),
        quarantinedAt: item.quarantinedAt!.toISOString(),
      })),
      total,
    };
  }

  // --- Private helpers ---

  private formatStreamHead(
    head: any,
  ): {
    sequence: string;
    root: string;
    observedAt: string;
    acceptedAt: string;
  } {
    return {
      sequence: head.sequence.toString(),
      root: head.root,
      observedAt: head.observedAt.toISOString(),
      acceptedAt: head.acceptedAt.toISOString(),
    };
  }

  private formatStreamHeadForMissing(): any {
    return {
      sequence: '0',
      root: '',
      observedAt: new Date(0).toISOString(),
      acceptedAt: new Date(0).toISOString(),
    };
  }

  private formatQuarantineDetails(
    reasons: RevocationCheckpointQuarantineReason[],
    currentHead: any,
  ): string {
    const parts: string[] = [];

    if (reasons.includes(RevocationCheckpointQuarantineReason.LOWER_SEQUENCE)) {
      parts.push(`sequence is lower than current head (${currentHead?.sequence ?? 'none'})`);
    }

    if (reasons.includes(RevocationCheckpointQuarantineReason.SEQUENCE_CONFLICT)) {
      parts.push(`same sequence (${currentHead?.sequence}) but different root`);
    }

    return parts.join('; ');
  }
}
