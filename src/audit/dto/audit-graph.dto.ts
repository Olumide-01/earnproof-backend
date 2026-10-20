import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from "class-validator";
import {
  AuditCorrelationEdge,
  AuditCorrelationGraphNode,
  AuditMissingLink,
} from "../../common/audit/audit-taxonomy";

export enum GraphTraversalDirection {
  DOWN = "DOWN",
  UP = "UP",
  BOTH = "BOTH",
}

export class AuditGraphQueryDto {
  @ApiProperty({ description: "Target tenant organization ID (enforces tenant boundary)" })
  @IsNotEmpty()
  @IsString()
  organizationId!: string;

  @ApiPropertyOptional({ description: "Starting root AuditLog ID" })
  @IsOptional()
  @IsString()
  rootId?: string;

  @ApiPropertyOptional({ description: "Correlation ID to graph" })
  @IsOptional()
  @IsString()
  correlationId?: string;

  @ApiPropertyOptional({ description: "Maximum traversal depth", default: 3, minimum: 1, maximum: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxDepth?: number = 3;

  @ApiPropertyOptional({ description: "Maximum nodes returned", default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @ApiPropertyOptional({ description: "Cursor for pagination" })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    enum: GraphTraversalDirection,
    description: "Traversal direction: UP (ancestors), DOWN (children), or BOTH",
    default: GraphTraversalDirection.BOTH,
  })
  @IsOptional()
  @IsEnum(GraphTraversalDirection)
  direction?: GraphTraversalDirection = GraphTraversalDirection.BOTH;
}

export class AuditGraphResponseDto {
  @ApiProperty({ description: "Typed redacted audit log nodes in the graph" })
  nodes!: AuditCorrelationGraphNode[];

  @ApiProperty({ description: "Causal and correlation edges between nodes" })
  edges!: AuditCorrelationEdge[];

  @ApiProperty({ description: "Whether cyclic dependencies were detected" })
  cyclesDetected!: boolean;

  @ApiProperty({ description: "Node IDs participating in detected cycles" })
  cycleNodeIds!: string[];

  @ApiProperty({ description: "Links that could not be resolved (retention expired or cross-tenant blocked)" })
  missingLinks!: AuditMissingLink[];

  @ApiProperty({ description: "Pagination metadata" })
  pageInfo!: {
    hasMore: boolean;
    nextCursor: string | null;
  };
}
