import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import {
  AuditCorrelationEdge,
  AuditCorrelationGraphNode,
  AuditMissingLink,
} from "../common/audit/audit-taxonomy";
import {
  AuditGraphQueryDto,
  AuditGraphResponseDto,
  GraphTraversalDirection,
} from "./dto/audit-graph.dto";

interface RawAuditRecord {
  id: string;
  action: string;
  actorType: string;
  actorId: string | null;
  resourceType: string;
  resourceId: string | null;
  correlationId: string | null;
  parentId: string | null;
  organizationId: string | null;
  metadata: unknown;
  createdAt: Date;
}

@Injectable()
export class AuditGraphService {
  private readonly logger = new Logger(AuditGraphService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Builds an authorized, bounded causal correlation graph for audit analysis.
   *
   * Enforces:
   * 1. Strict tenant boundary: will never return nodes from outside `query.organizationId`.
   * 2. Bounded depth and node limits: prevents unbounded traversal / DOS.
   * 3. Cycle detection: detects circular parent/correlation graphs safely without infinite loops.
   * 4. Missing link attribution: reports links lost to retention pruning or cross-tenant blocks.
   * 5. Redaction: strips sensitive fields from node metadata.
   */
  async buildCorrelationGraph(query: AuditGraphQueryDto): Promise<AuditGraphResponseDto> {
    const orgId = query.organizationId;
    if (!orgId) {
      throw new BadRequestException("organizationId is required for graph traversal");
    }

    if (!query.rootId && !query.correlationId) {
      throw new BadRequestException("Either rootId or correlationId must be provided");
    }

    const maxDepth = Math.min(Math.max(query.maxDepth ?? 3, 1), 10);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const direction = query.direction ?? GraphTraversalDirection.BOTH;

    // Find starting root nodes within the tenant
    let initialNodes: RawAuditRecord[] = [];

    if (query.rootId) {
      const root = await this.prisma.auditLog.findUnique({
        where: { id: query.rootId },
      });
      if (!root) {
        throw new NotFoundException(`Audit log node ${query.rootId} not found`);
      }
      if (root.organizationId !== orgId) {
        throw new BadRequestException("Cross-tenant access violation: rootId belongs to another tenant");
      }
      initialNodes = [root];
    } else if (query.correlationId) {
      initialNodes = await this.prisma.auditLog.findMany({
        where: {
          organizationId: orgId,
          correlationId: query.correlationId,
        },
        orderBy: { createdAt: "asc" },
        take: limit,
      });

      if (initialNodes.length === 0) {
        return {
          nodes: [],
          edges: [],
          cyclesDetected: false,
          cycleNodeIds: [],
          missingLinks: [],
          pageInfo: { hasMore: false, nextCursor: null },
        };
      }
    }

    const nodesMap = new Map<string, AuditCorrelationGraphNode>();
    const edges: AuditCorrelationEdge[] = [];
    const missingLinks: AuditMissingLink[] = [];
    const visited = new Set<string>();
    const cyclesDetectedNodeIds = new Set<string>();

    // BFS Queue: [record, depth]
    const queue: Array<{ record: RawAuditRecord; depth: number }> = [];

    for (const root of initialNodes) {
      queue.push({ record: root, depth: 0 });
    }

    let hasMore = false;
    let nextCursor: string | null = null;

    while (queue.length > 0) {
      const current = queue.shift()!;
      const { record, depth } = current;

      if (visited.has(record.id)) {
        cyclesDetectedNodeIds.add(record.id);
        continue;
      }

      visited.add(record.id);

      // Add to nodes map
      nodesMap.set(record.id, {
        id: record.id,
        action: record.action,
        actorType: record.actorType,
        actorId: record.actorId,
        resourceType: record.resourceType,
        resourceId: record.resourceId,
        correlationId: record.correlationId,
        parentId: record.parentId,
        depth,
        createdAt: record.createdAt.toISOString(),
        metadata: this.redactMetadata(record.metadata),
      });

      if (nodesMap.size >= limit) {
        if (queue.length > 0) {
          hasMore = true;
          nextCursor = record.id;
        }
        break;
      }

      // Check depth limit
      if (depth >= maxDepth) {
        // If there are unexpanded parents or children, record DEPTH_LIMIT_REACHED
        if (record.parentId && !nodesMap.has(record.parentId)) {
          missingLinks.push({
            sourceNodeId: record.id,
            targetId: record.parentId,
            reason: "DEPTH_LIMIT_REACHED",
          });
        }
        continue;
      }

      // 1. Traverse UP (Parent)
      if (direction === GraphTraversalDirection.UP || direction === GraphTraversalDirection.BOTH) {
        if (record.parentId) {
          const parent = await this.prisma.auditLog.findUnique({
            where: { id: record.parentId },
          });

          if (!parent) {
            missingLinks.push({
              sourceNodeId: record.id,
              targetId: record.parentId,
              reason: "RETENTION_EXPIRED",
            });
          } else if (parent.organizationId !== orgId) {
            // Block cross-tenant parent
            missingLinks.push({
              sourceNodeId: record.id,
              targetId: record.parentId,
              reason: "CROSS_TENANT_BLOCKED",
            });
          } else {
            edges.push({
              fromNodeId: record.id,
              toNodeId: parent.id,
              relationship: "PARENT",
            });

            if (visited.has(parent.id)) {
              cyclesDetectedNodeIds.add(parent.id);
            } else {
              queue.push({ record: parent, depth: depth + 1 });
            }
          }
        }
      }

      // 2. Traverse DOWN (Children)
      if (direction === GraphTraversalDirection.DOWN || direction === GraphTraversalDirection.BOTH) {
        const children = await this.prisma.auditLog.findMany({
          where: {
            parentId: record.id,
            organizationId: orgId, // strict tenant scoping
          },
          take: 20,
        });

        for (const child of children) {
          edges.push({
            fromNodeId: record.id,
            toNodeId: child.id,
            relationship: "CHILD",
          });

          if (visited.has(child.id)) {
            cyclesDetectedNodeIds.add(child.id);
          } else {
            queue.push({ record: child, depth: depth + 1 });
          }
        }
      }

      // 3. Traverse Correlated Nodes (if correlationId present and under depth limit)
      if (record.correlationId && depth < maxDepth) {
        const correlated = await this.prisma.auditLog.findMany({
          where: {
            correlationId: record.correlationId,
            organizationId: orgId,
            id: { not: record.id },
          },
          take: 10,
        });

        for (const corr of correlated) {
          if (!edges.some((e) => (e.fromNodeId === record.id && e.toNodeId === corr.id) || (e.fromNodeId === corr.id && e.toNodeId === record.id))) {
            edges.push({
              fromNodeId: record.id,
              toNodeId: corr.id,
              relationship: "CORRELATION",
            });
          }

          if (visited.has(corr.id)) {
            // visited already
          } else {
            queue.push({ record: corr, depth: depth + 1 });
          }
        }
      }
    }

    // Deduplicate edges
    const uniqueEdges = this.deduplicateEdges(edges);

    return {
      nodes: Array.from(nodesMap.values()),
      edges: uniqueEdges,
      cyclesDetected: cyclesDetectedNodeIds.size > 0,
      cycleNodeIds: Array.from(cyclesDetectedNodeIds),
      missingLinks,
      pageInfo: {
        hasMore,
        nextCursor,
      },
    };
  }

  /**
   * Privacy-safe metadata redaction: strips secret, amount, credential, and PII fields.
   */
  private redactMetadata(metadata: unknown): Record<string, unknown> | null {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return null;
    }

    const forbiddenKeyPattern = /token|secret|password|signature|private|amount|balance|salary|income|address/i;
    const cleaned: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(metadata as Record<string, unknown>)) {
      if (forbiddenKeyPattern.test(key) && !key.toLowerCase().endsWith("hash")) {
        cleaned[key] = "[REDACTED]";
      } else if (val !== null && typeof val === "object" && !Array.isArray(val)) {
        cleaned[key] = this.redactMetadata(val);
      } else {
        cleaned[key] = val;
      }
    }

    return cleaned;
  }

  private deduplicateEdges(edges: AuditCorrelationEdge[]): AuditCorrelationEdge[] {
    const seen = new Set<string>();
    const result: AuditCorrelationEdge[] = [];

    for (const edge of edges) {
      const key = `${edge.fromNodeId}->${edge.toNodeId}:${edge.relationship}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(edge);
      }
    }

    return result;
  }
}
