/**
 * Provenance disclosure controller.
 *
 * Exposes read-only endpoints for retrieving verification source provenance
 * chains. Enforces tenant boundaries and authorization.
 *
 * All endpoints return only public-facing data: no internal hashes or
 * source payloads, only auditable lineage metadata.
 */

import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerTokenAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { AuthGuard } from "../auth/auth.guard";
import { AuthenticatedUser, CurrentUser } from "../auth/auth.types";
import { VerificationProvenanceService } from "./verification-provenance.service";
import {
  VerificationProvenanceDto,
  ListVerificationProvenanceResponseDto,
  VerificationProvenanceSummaryDto,
  VerificationProvenanceSourcesByTypeDto,
} from "./dto/verification-provenance.dto";

/**
 * Query parameters for source filtering.
 */
class GetProvenanceSourcesQueryDto {
  sourceType?: string;
}

/**
 * Provenance disclosure controller.
 *
 * Provides read-only access to verification decision lineage for authorized users.
 */
@Controller("api/v1/proofs/:proofId/provenance")
@ApiTags("Proofs - Provenance Disclosure")
@UseGuards(AuthGuard)
@ApiBearerTokenAuth()
export class ProvenanceDisclosureController {
  constructor(private readonly provenanceService: VerificationProvenanceService) {}

  /**
   * Get latest provenance for a proof.
   *
   * Returns the most recent verification decision and complete source lineage.
   * Accessible only by the proof owner.
   *
   * @param proofId Proof to query
   * @param user Authenticated user
   * @returns Latest provenance record
   */
  @Get()
  @ApiOperation({
    summary: "Get latest verification provenance for a proof",
    description:
      "Retrieve the most recent verification decision and complete source lineage. " +
      "Includes credential, backend, contract, and Stellar observations in order. " +
      "Accessible only by the proof owner.",
  })
  @ApiParam({
    name: "proofId",
    description: "Proof ID",
    example: "proof-abc123",
  })
  @ApiOkResponse({
    type: VerificationProvenanceDto,
    description: "Provenance record with complete source lineage",
  })
  async getLatestProvenance(
    @Param("proofId") proofId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<VerificationProvenanceDto | { message: string }> {
    const provenance = await this.provenanceService.getProvenanceForProof(
      proofId,
      user.id,
    );

    if (!provenance) {
      throw new NotFoundException(
        "No provenance found for this proof. Provenance is recorded asynchronously after verification.",
      );
    }

    return this.provenanceService.toResponseDto(provenance);
  }

  /**
   * Get all provenance records for a proof.
   *
   * Returns chronological list of all verification decisions and lineage.
   * Useful for auditing verification history.
   *
   * @param proofId Proof to query
   * @param user Authenticated user
   * @returns List of provenance records
   */
  @Get("list")
  @ApiOperation({
    summary: "List all provenance records for a proof",
    description:
      "Retrieve chronological list of all verification decisions and source lineage. " +
      "Useful for auditing verification history and decision changes over time.",
  })
  @ApiParam({
    name: "proofId",
    description: "Proof ID",
    example: "proof-abc123",
  })
  @ApiOkResponse({
    type: ListVerificationProvenanceResponseDto,
    description: "List of provenance records",
  })
  async listProvenance(
    @Param("proofId") proofId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ListVerificationProvenanceResponseDto> {
    const provenances = await this.provenanceService.listProvenanceForProof(
      proofId,
      user.id,
    );

    if (provenances.length === 0) {
      return {
        proofId,
        provenances: [],
        total: 0,
      };
    }

    return {
      proofId,
      provenances: provenances.map((p) => this.provenanceService.toResponseDto(p)),
      total: provenances.length,
    };
  }

  /**
   * Get provenance sources filtered by type.
   *
   * Returns only sources of a specific type (credential, backend, contract, Stellar).
   * Useful for investigating specific observation categories.
   *
   * @param proofId Proof to query
   * @param sourceType Source type filter (CREDENTIAL_SOURCE, BACKEND_OBSERVATION, CONTRACT_OBSERVATION, STELLAR_OBSERVATION)
   * @param user Authenticated user
   * @returns Filtered sources
   */
  @Get("sources")
  @ApiOperation({
    summary: "Get provenance sources filtered by type",
    description:
      "Retrieve only sources of a specific type (CREDENTIAL_SOURCE, BACKEND_OBSERVATION, " +
      "CONTRACT_OBSERVATION, STELLAR_OBSERVATION). Useful for investigating specific observation categories.",
  })
  @ApiParam({
    name: "proofId",
    description: "Proof ID",
    example: "proof-abc123",
  })
  @ApiQuery({
    name: "sourceType",
    enum: [
      "CREDENTIAL_SOURCE",
      "BACKEND_OBSERVATION",
      "CONTRACT_OBSERVATION",
      "STELLAR_OBSERVATION",
    ],
    description: "Filter sources by type",
    required: false,
  })
  @ApiOkResponse({
    type: VerificationProvenanceSourcesByTypeDto,
    description: "Filtered sources",
  })
  async getSourcesByType(
    @Param("proofId") proofId: string,
    @Query("sourceType") sourceType?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ): Promise<VerificationProvenanceSourcesByTypeDto> {
    if (!user || !sourceType) {
      throw new NotFoundException("sourceType query parameter is required");
    }

    const sources = await this.provenanceService.getSourcesByType(
      proofId,
      sourceType,
      user.id,
    );

    if (sources.length === 0) {
      return {
        sourceType,
        sources: [],
        total: 0,
      };
    }

    const dtoSources = sources.map((s) => ({
      sourceType: s.sourceType,
      sourceId: s.sourceId,
      sourceLabel: s.sourceLabel || undefined,
      observedAt: s.observedAt.toISOString(),
      observationOrder: s.observationOrder,
      missingLinkReason: s.missingLinkReason || undefined,
    }));

    return {
      sourceType,
      sources: dtoSources,
      total: sources.length,
    };
  }

  /**
   * Get provenance availability summary for a proof.
   *
   * Returns boolean flag indicating whether provenance exists, along with
   * summary metadata. Useful for quick checks without fetching full lineage.
   *
   * @param proofId Proof to query
   * @param user Authenticated user
   * @returns Provenance availability summary
   */
  @Get("summary")
  @ApiOperation({
    summary: "Get provenance availability summary",
    description:
      "Quick check for whether provenance data exists for a proof, along with summary metadata. " +
      "Useful for conditional rendering or integration logic.",
  })
  @ApiParam({
    name: "proofId",
    description: "Proof ID",
    example: "proof-abc123",
  })
  @ApiOkResponse({
    type: VerificationProvenanceSummaryDto,
    description: "Provenance availability summary",
  })
  async getProvenanceSummary(
    @Param("proofId") proofId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<VerificationProvenanceSummaryDto> {
    const provenance = await this.provenanceService.getProvenanceForProof(
      proofId,
      user.id,
    );

    if (!provenance) {
      return {
        proofId,
        hasProvenance: false,
      };
    }

    return {
      proofId,
      hasProvenance: true,
      latestDecidedAt: provenance.decidedAt.toISOString(),
      provenanceCount: 1, // This gets the latest; use listProvenance for full count
      latestVerificationResult: provenance.verificationResult,
      latestSourceCount: provenance.sourceCount,
    };
  }
}
