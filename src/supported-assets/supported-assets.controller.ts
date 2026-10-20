import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
} from "@nestjs/swagger";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { AuthGuard } from "../common/guards/auth.guard";
import { AuthenticatedUser } from "../auth/auth.types";
import { SupportedAssetsService } from "./supported-assets.service";
import { CreateSupportedAssetDto } from "./dto/create-supported-asset.dto";
import { UpdateSupportedAssetDto } from "./dto/update-supported-asset.dto";
import { UpdateAssetStatusDto } from "./dto/update-asset-status.dto";
import { ListSupportedAssetsDto } from "./dto/list-supported-assets.dto";
import { SupportedAssetResponseDto } from "./dto/supported-asset-response.dto";

@ApiTags("supported-assets")
@Controller("supported-assets")
export class SupportedAssetsController {
  constructor(
    private readonly supportedAssetsService: SupportedAssetsService,
  ) {}

  @Post()
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @AuthenticatedRoute({ roles: ["ADMIN"] })
  @ApiOperation({
    summary: "Create a new supported asset",
    description:
      "Create a new supported asset for an organization. Requires ADMIN role or organization OWNER/ADMIN role.",
  })
  @ApiResponse({
    status: 201,
    description: "Asset created successfully",
    type: SupportedAssetResponseDto,
  })
  @ApiResponse({
    status: 409,
    description:
      "Asset with this code, issuer, and network already exists in the organization",
  })
  @ApiResponse({
    status: 403,
    description: "Insufficient permissions",
  })
  @ApiResponse({
    status: 404,
    description: "Organization not found",
  })
  @ApiResponse({
    status: 400,
    description: "Invalid input data",
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  createAsset(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateSupportedAssetDto,
  ) {
    return this.supportedAssetsService.createAsset(user, input);
  }

  @Get()
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @AuthenticatedRoute({ roles: ["ADMIN"] })
  @ApiOperation({
    summary: "List supported assets",
    description:
      "List supported assets with optional filtering by organization, network, and status. Non-admin users can only see assets from their organizations.",
  })
  @ApiResponse({
    status: 200,
    description: "Assets retrieved successfully",
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 400,
    description: "Invalid pagination or filter parameters",
    type: ApiErrorDto,
  })
  listAssets(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListSupportedAssetsDto,
  ) {
    return this.supportedAssetsService.listAssets(user, query);
  }

  @Get(":id")
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @AuthenticatedRoute({ roles: ["ADMIN"] })
  @ApiOperation({
    summary: "Get supported asset details",
    description:
      "Get full details of a specific supported asset. Requires membership in the asset's organization.",
  })
  @ApiResponse({
    status: 200,
    description: "Asset retrieved successfully",
    type: SupportedAssetResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: "Asset not found",
  })
  @ApiResponse({
    status: 403,
    description: "Insufficient permissions",
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  getAsset(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") assetId: string,
  ) {
    return this.supportedAssetsService.getAsset(user, assetId);
  }

  @Patch(":id")
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @AuthenticatedRoute({ roles: ["ADMIN"] })
  @ApiOperation({
    summary: "Update supported asset",
    description:
      "Update asset metadata (decimals only). Code, issuer, and network are immutable. Requires organization OWNER/ADMIN role.",
  })
  @ApiResponse({
    status: 200,
    description: "Asset updated successfully",
    type: SupportedAssetResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: "Asset not found",
  })
  @ApiResponse({
    status: 409,
    description: "Optimistic lock conflict - asset was modified concurrently",
  })
  @ApiResponse({
    status: 403,
    description: "Insufficient permissions",
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  updateAsset(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") assetId: string,
    @Body() input: UpdateSupportedAssetDto,
  ) {
    return this.supportedAssetsService.updateAsset(user, assetId, input);
  }

  @Patch(":id/status")
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @AuthenticatedRoute({ roles: ["ADMIN"] })
  @ApiOperation({
    summary: "Update supported asset status",
    description:
      "Activate, suspend, or revoke an asset. Valid transitions: PENDING→ACTIVE, ACTIVE↔SUSPENDED, ACTIVE→REVOKED. Requires organization OWNER/ADMIN role.",
  })
  @ApiResponse({
    status: 200,
    description: "Asset status updated successfully",
    type: SupportedAssetResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: "Asset not found",
  })
  @ApiResponse({
    status: 400,
    description: "Invalid status transition",
  })
  @ApiResponse({
    status: 409,
    description: "Optimistic lock conflict - asset was modified concurrently",
  })
  @ApiResponse({
    status: 403,
    description: "Insufficient permissions",
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  updateAssetStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") assetId: string,
    @Body() input: UpdateAssetStatusDto,
  ) {
    return this.supportedAssetsService.updateAssetStatus(user, assetId, input);
  }

  @Delete(":id")
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @AuthenticatedRoute({ roles: ["ADMIN"] })
  @ApiOperation({
    summary: "Delete supported asset (soft delete)",
    description:
      "Soft delete an asset by setting status to DELETED. Only organization OWNERs can delete assets.",
  })
  @ApiResponse({
    status: 200,
    description: "Asset deleted successfully",
    type: SupportedAssetResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: "Asset not found",
  })
  @ApiResponse({
    status: 403,
    description: "Insufficient permissions - only owners can delete",
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  deleteAsset(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") assetId: string,
  ) {
    return this.supportedAssetsService.deleteAsset(user, assetId);
  }
}
