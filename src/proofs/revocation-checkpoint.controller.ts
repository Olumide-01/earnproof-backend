import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  UseGuards,
  Param,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RevocationCheckpointService } from './revocation-checkpoint.service';
import {
  CreateRevocationCheckpointDto,
  CreateRevocationCheckpointResponseDto,
} from './dto/create-revocation-checkpoint.dto';
import { RevocationCheckpointQuarantineReason } from '@prisma/client';

@ApiTags('Revocation Checkpoints')
@Controller('api/v1/revocation-checkpoints')
export class RevocationCheckpointController {
  constructor(
    private readonly revocationCheckpointService: RevocationCheckpointService,
  ) {}

  /**
   * Create or update a revocation checkpoint.
   * Enforces monotonicity: sequence must increase or be identical replay.
   * Regressed roots are quarantined, never silently accepted.
   */
  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create or update a revocation checkpoint',
    description:
      'Persist a revocation checkpoint with monotonic enforcement. ' +
      'If sequence is lower than current head or same sequence with different root, ' +
      'the checkpoint is quarantined and does not advance the stream.',
  })
  @ApiResponse({
    status: 201,
    description: 'Checkpoint created or quarantined',
    type: CreateRevocationCheckpointResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid input (malformed, unknown algorithm, etc.)',
  })
  async createCheckpoint(
    @Body() dto: CreateRevocationCheckpointDto,
  ): Promise<CreateRevocationCheckpointResponseDto> {
    // Parse sequence as BigInt
    let sequence: bigint;
    try {
      sequence = BigInt(dto.sequence);
    } catch {
      throw new BadRequestException('sequence must be a valid integer');
    }

    // Parse observedAt as Date
    const observedAt = new Date(dto.observedAt);
    if (isNaN(observedAt.getTime())) {
      throw new BadRequestException('observedAt must be a valid ISO 8601 timestamp');
    }

    const result = await this.revocationCheckpointService.upsertCheckpoint({
      ledger: dto.ledger,
      contractIdentity: dto.contractIdentity,
      algorithm: dto.algorithm,
      sequence,
      root: dto.root,
      observedAt,
    });

    return {
      status: result.status,
      checkpoint: {
        id: '', // Populated on success in real implementation
        sequence: result.head.sequence,
        root: result.head.root,
        observedAt: result.head.observedAt,
        acceptedAt: result.head.acceptedAt,
        status: result.status === 'accepted' ? 'ACCEPTED' : 'QUARANTINED',
        quarantineReason: result.reason,
      },
      head: result.head,
    };
  }

  /**
   * Get the latest accepted checkpoint (stream head) with freshness metadata.
   */
  @Get('fresh')
  @ApiOperation({
    summary: 'Get the latest accepted checkpoint with freshness metadata',
    description:
      'Retrieve the current accepted head for a stream with freshness indicators. ' +
      'Includes age in seconds and staleness indicator (default 1 hour threshold).',
  })
  @ApiResponse({
    status: 200,
    description: 'Freshness metadata for the stream head',
    schema: {
      type: 'object',
      properties: {
        sequence: { type: 'string' },
        root: { type: 'string' },
        observedAt: { type: 'string', format: 'date-time' },
        acceptedAt: { type: 'string', format: 'date-time' },
        age: {
          type: 'object',
          properties: {
            seconds: { type: 'number' },
            staleBeyond: { type: 'boolean' },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'No checkpoint exists for this stream' })
  async getFreshCheckpoint(
    @Query('ledger') ledger: string,
    @Query('contractIdentity') contractIdentity: string,
    @Query('algorithm') algorithm: string,
  ) {
    if (!ledger || !contractIdentity || !algorithm) {
      throw new BadRequestException(
        'ledger, contractIdentity, and algorithm query parameters are required',
      );
    }

    return this.revocationCheckpointService.getFreshCheckpoint(
      ledger,
      contractIdentity,
      algorithm,
    );
  }

  /**
   * List quarantined checkpoints.
   * Useful for operators to review regressed roots and conflicts.
   */
  @Get('quarantine')
  @ApiOperation({
    summary: 'List quarantined checkpoints',
    description:
      'Query quarantined checkpoints (regressed roots, conflicts, etc.) for operator review. ' +
      'Supports filtering by stream identity and quarantine reason.',
  })
  @ApiResponse({
    status: 200,
    description: 'List of quarantined checkpoints',
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              ledger: { type: 'string' },
              contractIdentity: { type: 'string' },
              algorithm: { type: 'string' },
              sequence: { type: 'string' },
              root: { type: 'string' },
              observedAt: { type: 'string', format: 'date-time' },
              quarantineReason: { type: 'string' },
              quarantineDetails: { type: 'string' },
              quarantinedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
        total: { type: 'number' },
      },
    },
  })
  async listQuarantined(
    @Query('ledger') ledger?: string,
    @Query('contractIdentity') contractIdentity?: string,
    @Query('algorithm') algorithm?: string,
    @Query('reason') reason?: RevocationCheckpointQuarantineReason,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 50;
    const offsetNum = offset ? parseInt(offset, 10) : 0;

    if (isNaN(limitNum) || isNaN(offsetNum)) {
      throw new BadRequestException('limit and offset must be valid integers');
    }

    return this.revocationCheckpointService.listQuarantined({
      ledger,
      contractIdentity,
      algorithm,
      reason,
      limit: limitNum,
      offset: offsetNum,
    });
  }
}
