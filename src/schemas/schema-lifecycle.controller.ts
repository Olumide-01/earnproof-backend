import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { ProofType, SchemaLifecycleStatus } from "@prisma/client";
import { AuthenticatedRoute, PublicRoute } from "../common/decorators/authorization-policy.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { SESSION_AUTH_SCHEME } from "../common/swagger/security-schemes";
import {
  CompatibilityEvaluationResult,
  RegisterSchemaInput,
  SchemaLifecycleResponseDto,
  SchemaLifecycleService,
} from "./schema-lifecycle.service";

@ApiTags("schemas")
@Controller("schemas/lifecycle")
export class SchemaLifecycleController {
  constructor(private readonly lifecycleService: SchemaLifecycleService) {}

  @PublicRoute()
  @Get()
  @ApiOperation({ summary: "List active, deprecated, and sunset schemas" })
  @ApiQuery({ name: "proofType", required: false, enum: ProofType })
  @ApiQuery({ name: "status", required: false, enum: SchemaLifecycleStatus })
  @ApiQuery({ name: "network", required: false, example: "testnet" })
  async listSchemas(
    @Query("proofType") proofType?: ProofType,
    @Query("status") status?: SchemaLifecycleStatus,
    @Query("network") network?: string,
  ): Promise<SchemaLifecycleResponseDto[]> {
    return this.lifecycleService.listSchemas({ proofType, status, network });
  }

  @PublicRoute()
  @Get(":schemaId")
  @ApiOperation({ summary: "Get schema definition, lineage, and policy state" })
  async getSchema(
    @Param("schemaId") schemaId: string,
  ): Promise<SchemaLifecycleResponseDto> {
    return this.lifecycleService.getSchema(schemaId);
  }

  @PublicRoute()
  @Get(":schemaId/compatibility")
  @ApiOperation({ summary: "Evaluate schema issuance preflight and contract compatibility" })
  @ApiQuery({ name: "payloadSizeBytes", required: false, type: Number })
  async evaluateCompatibility(
    @Param("schemaId") schemaId: string,
    @Query("payloadSizeBytes") payloadSizeBytes?: string,
  ): Promise<CompatibilityEvaluationResult> {
    const size = payloadSizeBytes ? parseInt(payloadSizeBytes, 10) : undefined;
    return this.lifecycleService.evaluatePreflight(schemaId, size);
  }

  @AuthenticatedRoute({ ownership: "user" })
  @ApiBearerAuth(SESSION_AUTH_SCHEME)
  @UseGuards(AuthGuard)
  @Post()
  @ApiOperation({ summary: "Register a new protocol schema version" })
  async registerSchema(
    @Body() input: RegisterSchemaInput,
  ): Promise<SchemaLifecycleResponseDto> {
    return this.lifecycleService.registerSchema(input);
  }

  @AuthenticatedRoute({ ownership: "user" })
  @ApiBearerAuth(SESSION_AUTH_SCHEME)
  @UseGuards(AuthGuard)
  @Post(":schemaId/deprecate")
  @ApiOperation({ summary: "Mark a schema as deprecated" })
  async deprecateSchema(
    @Param("schemaId") schemaId: string,
  ): Promise<SchemaLifecycleResponseDto> {
    return this.lifecycleService.deprecateSchema(schemaId);
  }
}
