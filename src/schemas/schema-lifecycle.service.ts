import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, ProofType, SchemaLifecycleStatus } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";

export interface RegisterSchemaInput {
  schemaId: string;
  version: string;
  proofType: ProofType;
  status?: SchemaLifecycleStatus;
  predecessorSchemaId?: string;
  maxPayloadBytes?: number;
  contractCompatible?: boolean;
  definition: Record<string, unknown>;
  configVersion: string;
  network: string;
  contractId?: string;
}

export interface SchemaLifecycleResponseDto {
  id: string;
  schemaId: string;
  version: string;
  proofType: ProofType;
  status: SchemaLifecycleStatus;
  predecessorSchemaId: string | null;
  maxPayloadBytes: number;
  contractCompatible: boolean;
  definition: unknown;
  activatedAt: Date;
  deprecatedAt: Date | null;
  sunsetAt: Date | null;
  configVersion: string;
  network: string;
  contractId: string | null;
  canIssue: boolean;
}

export interface CompatibilityEvaluationResult {
  schemaId: string;
  compatible: boolean;
  canIssue: boolean;
  reasons: string[];
}

@Injectable()
export class SchemaLifecycleService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Register or project a schema with lineage cycle check.
   */
  async registerSchema(input: RegisterSchemaInput): Promise<SchemaLifecycleResponseDto> {
    const existing = await this.prisma.protocolSchema.findUnique({
      where: { schemaId: input.schemaId },
    });
    if (existing) {
      throw new ConflictException(`Schema "${input.schemaId}" already exists`);
    }

    let predecessorInternalId: string | null = null;
    if (input.predecessorSchemaId) {
      if (input.predecessorSchemaId === input.schemaId) {
        throw new BadRequestException("Lineage cycle detected: schema cannot be its own predecessor");
      }
      const pred = await this.prisma.protocolSchema.findUnique({
        where: { schemaId: input.predecessorSchemaId },
      });
      if (!pred) {
        throw new NotFoundException(`Predecessor schema "${input.predecessorSchemaId}" not found`);
      }
      predecessorInternalId = pred.id;
    }

    const created = await this.prisma.protocolSchema.create({
      data: {
        schemaId: input.schemaId,
        version: input.version,
        proofType: input.proofType,
        status: input.status ?? SchemaLifecycleStatus.ACTIVE,
        predecessorId: predecessorInternalId,
        maxPayloadBytes: input.maxPayloadBytes ?? 65536,
        contractCompatible: input.contractCompatible ?? true,
        definition: input.definition as Prisma.InputJsonValue,
        configVersion: input.configVersion,
        network: input.network,
        contractId: input.contractId,
      },
      include: {
        predecessor: true,
      },
    });

    return this.formatDto(created);
  }

  /**
   * Evaluate schema suitability during issuance preflight.
   * Fails closed: Deprecated, sunset, or incompatible schemas are rejected.
   */
  async evaluatePreflight(
    schemaId: string,
    payloadSizeBytes?: number,
  ): Promise<CompatibilityEvaluationResult> {
    const schema = await this.prisma.protocolSchema.findUnique({
      where: { schemaId },
    });

    if (!schema) {
      return {
        schemaId,
        compatible: false,
        canIssue: false,
        reasons: ["SCHEMA_UNKNOWN"],
      };
    }

    const reasons: string[] = [];
    let canIssue = true;

    if (schema.status === SchemaLifecycleStatus.DEPRECATED) {
      canIssue = false;
      reasons.push("SCHEMA_DEPRECATED");
    } else if (schema.status === SchemaLifecycleStatus.SUNSET) {
      canIssue = false;
      reasons.push("SCHEMA_SUNSET");
    }

    if (!schema.contractCompatible) {
      canIssue = false;
      reasons.push("CONTRACT_INCOMPATIBLE");
    }

    if (payloadSizeBytes !== undefined && payloadSizeBytes > schema.maxPayloadBytes) {
      canIssue = false;
      reasons.push(`PAYLOAD_LIMIT_EXCEEDED: max is ${schema.maxPayloadBytes} bytes`);
    }

    return {
      schemaId,
      compatible: schema.contractCompatible,
      canIssue,
      reasons,
    };
  }

  /**
   * Transition schema to DEPRECATED.
   */
  async deprecateSchema(schemaId: string): Promise<SchemaLifecycleResponseDto> {
    const schema = await this.getSchemaOrThrow(schemaId);
    const updated = await this.prisma.protocolSchema.update({
      where: { id: schema.id },
      data: {
        status: SchemaLifecycleStatus.DEPRECATED,
        deprecatedAt: new Date(),
      },
      include: { predecessor: true },
    });
    return this.formatDto(updated);
  }

  /**
   * List schemas with optional filtering.
   */
  async listSchemas(options: {
    proofType?: ProofType;
    status?: SchemaLifecycleStatus;
    network?: string;
  } = {}): Promise<SchemaLifecycleResponseDto[]> {
    const where: Prisma.ProtocolSchemaWhereInput = {};
    if (options.proofType) where.proofType = options.proofType;
    if (options.status) where.status = options.status;
    if (options.network) where.network = options.network;

    const schemas = await this.prisma.protocolSchema.findMany({
      where,
      include: { predecessor: true },
      orderBy: { createdAt: "desc" },
    });

    return schemas.map((s) => this.formatDto(s));
  }

  /**
   * Get schema detail and lineage.
   */
  async getSchema(schemaId: string): Promise<SchemaLifecycleResponseDto> {
    const schema = await this.prisma.protocolSchema.findUnique({
      where: { schemaId },
      include: { predecessor: true },
    });
    if (!schema) {
      throw new NotFoundException(`Schema "${schemaId}" not found`);
    }
    return this.formatDto(schema);
  }

  private async getSchemaOrThrow(schemaId: string) {
    const schema = await this.prisma.protocolSchema.findUnique({
      where: { schemaId },
    });
    if (!schema) {
      throw new NotFoundException(`Schema "${schemaId}" not found`);
    }
    return schema;
  }

  private formatDto(schema: any): SchemaLifecycleResponseDto {
    const canIssue =
      schema.status === SchemaLifecycleStatus.ACTIVE && schema.contractCompatible;

    return {
      id: schema.id,
      schemaId: schema.schemaId,
      version: schema.version,
      proofType: schema.proofType,
      status: schema.status,
      predecessorSchemaId: schema.predecessor?.schemaId ?? null,
      maxPayloadBytes: schema.maxPayloadBytes,
      contractCompatible: schema.contractCompatible,
      definition: schema.definition,
      activatedAt: schema.activatedAt,
      deprecatedAt: schema.deprecatedAt,
      sunsetAt: schema.sunsetAt,
      configVersion: schema.configVersion,
      network: schema.network,
      contractId: schema.contractId,
      canIssue,
    };
  }
}
