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
import { ApiBearerAuth, ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { CreateTrustedSourceDto } from "./dto/create-trusted-source.dto";
import { ListTrustedSourcesDto } from "./dto/list-trusted-sources.dto";
import { UpdateTrustedSourceDto } from "./dto/update-trusted-source.dto";
import { TrustedSourcesService } from "./trusted-sources.service";

@ApiBearerAuth()
@AuthenticatedRoute({ ownership: "user" })
@ApiTags("trusted-sources")
@UseGuards(AuthGuard)
@Controller("trusted-sources")
export class TrustedSourcesController {
  constructor(private readonly trustedSourcesService: TrustedSourcesService) {}

  @Post()
  @ApiOperation({
    summary: "Create a new trusted source",
    description:
      "Create a new trusted source for the authenticated user. Source addresses are normalized and must be unique per user.",
  })
  @ApiResponse({
    status: 201,
    description: "Trusted source created successfully",
    schema: {
      example: {
        id: "ts_abc123",
        sourceAddress: "GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        displayName: "My Employer Account",
        sourceType: "stellar",
        issuer: {
          id: "issuer_123",
          name: "Acme Corp",
          status: "ACTIVE",
          isTrusted: true,
        },
        status: "ACTIVE",
        createdAt: "2026-08-24T10:00:00.000Z",
        updatedAt: "2026-08-24T10:00:00.000Z",
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      "Validation error: invalid address format, duplicate address, or non-existent issuer",
  })
  @ApiResponse({
    status: 401,
    description: "Unauthorized: missing or invalid bearer token",
  })
  createTrustedSource(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateTrustedSourceDto,
  ) {
    return this.trustedSourcesService.createTrustedSource(user, body);
  }

  @Get()
  @ApiOperation({
    summary: "List user's trusted sources",
    description:
      "Retrieve a cursor-paginated, deterministically ordered page of trusted sources " +
      "for the authenticated user with optional filtering. Pass `pageInfo.nextCursor` " +
      "from a response as the next request's `cursor`.",
  })
  @ApiResponse({
    status: 200,
    description: "A page of trusted sources, plus pagination metadata.",
    schema: {
      example: {
        data: [
          {
            id: "ts_abc123",
            sourceAddress: "GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
            displayName: "My Employer Account",
            sourceType: "stellar",
            issuer: {
              id: "issuer_123",
              name: "Acme Corp",
              status: "ACTIVE",
              isTrusted: true,
            },
            status: "ACTIVE",
            createdAt: "2026-08-24T10:00:00.000Z",
            updatedAt: "2026-08-24T10:00:00.000Z",
          },
        ],
        pageInfo: { hasMore: false, nextCursor: null },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: "Unauthorized: missing or invalid bearer token",
  })
  listTrustedSources(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListTrustedSourcesDto,
  ) {
    return this.trustedSourcesService.listTrustedSources(user, query);
  }

  @Get(":id")
  @ApiOperation({
    summary: "Get a specific trusted source",
    description: "Retrieve a specific trusted source by ID. User can only access their own sources.",
  })
  @ApiResponse({
    status: 200,
    description: "Trusted source details",
    schema: {
      example: {
        id: "ts_abc123",
        sourceAddress: "GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        displayName: "My Employer Account",
        sourceType: "stellar",
        issuer: {
          id: "issuer_123",
          name: "Acme Corp",
          status: "ACTIVE",
          isTrusted: true,
        },
        status: "ACTIVE",
        createdAt: "2026-08-24T10:00:00.000Z",
        updatedAt: "2026-08-24T10:00:00.000Z",
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: "Forbidden: user does not have access to this trusted source",
  })
  @ApiResponse({
    status: 401,
    description: "Unauthorized: missing or invalid bearer token",
  })
  getTrustedSource(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") trustedSourceId: string,
  ) {
    return this.trustedSourcesService.getTrustedSource(user, trustedSourceId);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Update a trusted source",
    description:
      "Update a trusted source's metadata (displayName, issuerId). The source address cannot be changed.",
  })
  @ApiResponse({
    status: 200,
    description: "Trusted source updated successfully",
    schema: {
      example: {
        id: "ts_abc123",
        sourceAddress: "GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        displayName: "My Employer Account - Updated",
        sourceType: "stellar",
        issuer: {
          id: "issuer_456",
          name: "Acme Corp Finance",
          status: "ACTIVE",
          isTrusted: true,
        },
        status: "ACTIVE",
        createdAt: "2026-08-24T10:00:00.000Z",
        updatedAt: "2026-08-24T11:00:00.000Z",
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: "Validation error: invalid or non-existent issuer",
  })
  @ApiResponse({
    status: 403,
    description: "Forbidden: user does not have access to this trusted source",
  })
  @ApiResponse({
    status: 401,
    description: "Unauthorized: missing or invalid bearer token",
  })
  updateTrustedSource(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") trustedSourceId: string,
    @Body() body: UpdateTrustedSourceDto,
  ) {
    return this.trustedSourcesService.updateTrustedSource(
      user,
      trustedSourceId,
      body,
    );
  }

  @Delete(":id")
  @ApiOperation({
    summary: "Delete a trusted source",
    description:
      "Delete a trusted source. The source is marked as deleted to preserve audit trails. An audit log entry is created.",
  })
  @ApiResponse({
    status: 200,
    description: "Trusted source deleted successfully",
    schema: {
      example: {
        id: "ts_abc123",
        status: "DELETED",
        retainedForHistory: true,
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: "Forbidden: user does not have access to this trusted source",
  })
  @ApiResponse({
    status: 401,
    description: "Unauthorized: missing or invalid bearer token",
  })
  deleteTrustedSource(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") trustedSourceId: string,
  ) {
    return this.trustedSourcesService.deleteTrustedSource(user, trustedSourceId);
  }
}
