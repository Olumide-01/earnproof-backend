import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from "@nestjs/swagger";
import { AuthGuard } from "../common/guards/auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthenticatedUser } from "../auth/auth.types";
import { AccessReviewService } from "./access-review.service";
import { CreateAccessReviewDto } from "./dto/create-access-review.dto";
import {
  AccessReviewCampaignDto,
  ListAccessReviewsDto,
} from "./dto/access-review-response.dto";
import { ReviewEntryDecisionDto } from "./dto/review-entry-decision.dto";

@ApiTags("Organization Access Reviews")
@Controller("organizations/:organizationId/access-reviews")
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class AccessReviewController {
  constructor(private readonly accessReviewService: AccessReviewService) {}

  @Post()
  @ApiOperation({ summary: "Create a new access review campaign" })
  @ApiParam({ name: "organizationId", description: "Organization ID" })
  @ApiResponse({
    status: 201,
    description: "Access review campaign created successfully",
    type: AccessReviewCampaignDto,
  })
  @ApiResponse({ status: 403, description: "Insufficient permissions" })
  async createReview(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Body() input: CreateAccessReviewDto,
  ): Promise<AccessReviewCampaignDto> {
    return this.accessReviewService.createReview(user, organizationId, input);
  }

  @Get()
  @ApiOperation({ summary: "List access review campaigns" })
  @ApiParam({ name: "organizationId", description: "Organization ID" })
  @ApiResponse({
    status: 200,
    description: "Access review campaigns retrieved successfully",
  })
  async listReviews(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Query() query: ListAccessReviewsDto,
  ): Promise<{
    items: AccessReviewCampaignDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    return this.accessReviewService.listReviews(user, organizationId, query);
  }

  @Get(":reviewId")
  @ApiOperation({ summary: "Get access review campaign details" })
  @ApiParam({ name: "organizationId", description: "Organization ID" })
  @ApiParam({ name: "reviewId", description: "Access review campaign ID" })
  @ApiResponse({
    status: 200,
    description: "Access review campaign retrieved successfully",
    type: AccessReviewCampaignDto,
  })
  @ApiResponse({ status: 404, description: "Access review campaign not found" })
  async getReview(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Param("reviewId") reviewId: string,
    @Query("includeEntries") includeEntries?: string,
  ): Promise<AccessReviewCampaignDto> {
    return this.accessReviewService.getReview(
      user, 
      organizationId, 
      reviewId, 
      includeEntries === "true"
    );
  }

  @Patch(":reviewId/entries/:entryId/review")
  @ApiOperation({ summary: "Review an access entry (approve/recommend changes/remove)" })
  @ApiParam({ name: "organizationId", description: "Organization ID" })
  @ApiParam({ name: "reviewId", description: "Access review campaign ID" })
  @ApiParam({ name: "entryId", description: "Access review entry ID" })
  @ApiResponse({ status: 200, description: "Review decision recorded successfully" })
  @ApiResponse({ status: 404, description: "Review entry not found" })
  @ApiResponse({ status: 403, description: "Insufficient permissions" })
  async reviewEntry(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Param("reviewId") reviewId: string,
    @Param("entryId") entryId: string,
    @Body() decision: ReviewEntryDecisionDto,
  ): Promise<void> {
    return this.accessReviewService.reviewEntry(
      user,
      organizationId,
      reviewId,
      entryId,
      decision,
    );
  }

  @Post(":reviewId/apply-recommendations")
  @ApiOperation({ summary: "Apply approved role changes and removals" })
  @ApiParam({ name: "organizationId", description: "Organization ID" })
  @ApiParam({ name: "reviewId", description: "Access review campaign ID" })
  @ApiResponse({
    status: 200,
    description: "Recommendations applied successfully",
    schema: {
      type: "object",
      properties: {
        applied: { type: "number" },
        skipped: { type: "number" },
        failed: { type: "number" },
      },
    },
  })
  @ApiResponse({ status: 403, description: "Insufficient permissions" })
  async applyRecommendations(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Param("reviewId") reviewId: string,
  ): Promise<{ applied: number; skipped: number; failed: number }> {
    return this.accessReviewService.applyRecommendations(user, organizationId, reviewId);
  }

  @Patch(":reviewId/complete")
  @ApiOperation({ summary: "Mark access review campaign as completed" })
  @ApiParam({ name: "organizationId", description: "Organization ID" })
  @ApiParam({ name: "reviewId", description: "Access review campaign ID" })
  @ApiResponse({ status: 200, description: "Access review completed successfully" })
  @ApiResponse({ status: 404, description: "Access review campaign not found" })
  @ApiResponse({ status: 403, description: "Insufficient permissions" })
  async completeReview(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Param("reviewId") reviewId: string,
  ): Promise<void> {
    return this.accessReviewService.completeReview(user, organizationId, reviewId);
  }

  @Patch(":reviewId/cancel")
  @ApiOperation({ summary: "Cancel access review campaign" })
  @ApiParam({ name: "organizationId", description: "Organization ID" })
  @ApiParam({ name: "reviewId", description: "Access review campaign ID" })
  @ApiResponse({ status: 200, description: "Access review cancelled successfully" })
  @ApiResponse({ status: 404, description: "Access review campaign not found" })
  @ApiResponse({ status: 403, description: "Insufficient permissions" })
  async cancelReview(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Param("reviewId") reviewId: string,
  ): Promise<void> {
    return this.accessReviewService.cancelReview(user, organizationId, reviewId);
  }
}