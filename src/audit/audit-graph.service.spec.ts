import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AuditGraphService } from "./audit-graph.service";
import { GraphTraversalDirection } from "./dto/audit-graph.dto";

describe("AuditGraphService", () => {
  let service: AuditGraphService;
  let prismaMock: any;

  beforeEach(() => {
    prismaMock = {
      auditLog: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
    };

    service = new AuditGraphService(prismaMock as any);
  });

  describe("buildCorrelationGraph", () => {
    it("throws BadRequestException if organizationId is missing", async () => {
      await expect(
        service.buildCorrelationGraph({ organizationId: "", rootId: "root_1" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException if neither rootId nor correlationId is provided", async () => {
      await expect(
        service.buildCorrelationGraph({ organizationId: "org_1" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException if rootId does not exist", async () => {
      prismaMock.auditLog.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.buildCorrelationGraph({ organizationId: "org_1", rootId: "non_existent" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequestException if rootId belongs to a different tenant", async () => {
      prismaMock.auditLog.findUnique.mockResolvedValueOnce({
        id: "root_other",
        organizationId: "other_org",
      });

      await expect(
        service.buildCorrelationGraph({ organizationId: "org_1", rootId: "root_other" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("traverses branching causal parent and children within the same tenant", async () => {
      const root = {
        id: "node_parent",
        organizationId: "org_1",
        action: "organization.created",
        actorType: "user",
        actorId: "user_1",
        resourceType: "organization",
        resourceId: "org_1",
        correlationId: "corr_123",
        parentId: null,
        metadata: { name: "Acme Corp", secretToken: "supersecret" },
        createdAt: new Date("2026-10-16T10:00:00Z"),
      };

      const child1 = {
        id: "node_child_1",
        organizationId: "org_1",
        action: "issuer.created",
        actorType: "user",
        actorId: "user_1",
        resourceType: "issuer",
        resourceId: "iss_1",
        correlationId: "corr_123",
        parentId: "node_parent",
        metadata: { issuerName: "Acme Issuer" },
        createdAt: new Date("2026-10-16T10:05:00Z"),
      };

      const child2 = {
        id: "node_child_2",
        organizationId: "org_1",
        action: "api_key.created",
        actorType: "user",
        actorId: "user_1",
        resourceType: "api_key",
        resourceId: "key_1",
        correlationId: "corr_123",
        parentId: "node_parent",
        metadata: { keyLabel: "Prod Key", amountPaid: "100.00" },
        createdAt: new Date("2026-10-16T10:10:00Z"),
      };

      prismaMock.auditLog.findUnique.mockResolvedValueOnce(root);
      // Children of node_parent
      prismaMock.auditLog.findMany
        .mockResolvedValueOnce([child1, child2]) // findMany for children of node_parent
        .mockResolvedValueOnce([]) // correlated for node_parent
        .mockResolvedValueOnce([]) // children of child1
        .mockResolvedValueOnce([]) // correlated for child1
        .mockResolvedValueOnce([]) // children of child2
        .mockResolvedValueOnce([]); // correlated for child2

      const graph = await service.buildCorrelationGraph({
        organizationId: "org_1",
        rootId: "node_parent",
        maxDepth: 3,
      });

      expect(graph.nodes).toHaveLength(3);
      expect(graph.edges).toHaveLength(2);
      expect(graph.cyclesDetected).toBe(false);

      // Verify metadata redaction
      const parentNode = graph.nodes.find((n) => n.id === "node_parent");
      expect(parentNode?.metadata?.secretToken).toBe("[REDACTED]");
      expect(parentNode?.metadata?.name).toBe("Acme Corp");

      const child2Node = graph.nodes.find((n) => n.id === "node_child_2");
      expect(child2Node?.metadata?.amountPaid).toBe("[REDACTED]");
    });

    it("enforces tenant boundary: flags cross-tenant parent as CROSS_TENANT_BLOCKED and does not include node", async () => {
      const child = {
        id: "child_node",
        organizationId: "org_1",
        action: "proof.created",
        actorType: "user",
        actorId: "u1",
        resourceType: "proof",
        resourceId: "p1",
        correlationId: null,
        parentId: "foreign_parent",
        metadata: {},
        createdAt: new Date(),
      };

      const foreignParent = {
        id: "foreign_parent",
        organizationId: "other_tenant", // foreign tenant
        action: "admin.override",
        actorType: "admin",
        actorId: "admin_1",
        resourceType: "system",
        resourceId: "sys",
        correlationId: null,
        parentId: null,
        metadata: {},
        createdAt: new Date(),
      };

      prismaMock.auditLog.findUnique
        .mockResolvedValueOnce(child) // root
        .mockResolvedValueOnce(foreignParent); // parent lookup

      prismaMock.auditLog.findMany.mockResolvedValue([]); // children of child

      const graph = await service.buildCorrelationGraph({
        organizationId: "org_1",
        rootId: "child_node",
        direction: GraphTraversalDirection.UP,
      });

      // foreign parent should NOT be included in nodes
      expect(graph.nodes).toHaveLength(1);
      expect(graph.nodes[0].id).toBe("child_node");
      expect(graph.missingLinks).toContainEqual({
        sourceNodeId: "child_node",
        targetId: "foreign_parent",
        reason: "CROSS_TENANT_BLOCKED",
      });
    });

    it("handles retention pruning: flags pruned parent as RETENTION_EXPIRED", async () => {
      const child = {
        id: "child_node",
        organizationId: "org_1",
        action: "proof.verified",
        actorType: "user",
        actorId: "u1",
        resourceType: "proof",
        resourceId: "p1",
        correlationId: null,
        parentId: "pruned_parent_id",
        metadata: {},
        createdAt: new Date(),
      };

      prismaMock.auditLog.findUnique
        .mockResolvedValueOnce(child) // root
        .mockResolvedValueOnce(null); // parent is gone due to retention pruning

      prismaMock.auditLog.findMany.mockResolvedValue([]);

      const graph = await service.buildCorrelationGraph({
        organizationId: "org_1",
        rootId: "child_node",
        direction: GraphTraversalDirection.UP,
      });

      expect(graph.nodes).toHaveLength(1);
      expect(graph.missingLinks).toContainEqual({
        sourceNodeId: "child_node",
        targetId: "pruned_parent_id",
        reason: "RETENTION_EXPIRED",
      });
    });

    it("detects cyclic causal references without infinite looping", async () => {
      // Node A points to Node B, and Node B points back to Node A
      const nodeA = {
        id: "node_a",
        organizationId: "org_1",
        action: "action.a",
        actorType: "system",
        actorId: "sys",
        resourceType: "res",
        resourceId: "1",
        correlationId: null,
        parentId: "node_b",
        metadata: {},
        createdAt: new Date(),
      };

      const nodeB = {
        id: "node_b",
        organizationId: "org_1",
        action: "action.b",
        actorType: "system",
        actorId: "sys",
        resourceType: "res",
        resourceId: "2",
        correlationId: null,
        parentId: "node_a", // cycle back to A
        metadata: {},
        createdAt: new Date(),
      };

      prismaMock.auditLog.findUnique
        .mockResolvedValueOnce(nodeA) // root
        .mockResolvedValueOnce(nodeB) // parent of A
        .mockResolvedValueOnce(nodeA); // parent of B (cycle)

      prismaMock.auditLog.findMany.mockResolvedValue([]);

      const graph = await service.buildCorrelationGraph({
        organizationId: "org_1",
        rootId: "node_a",
        maxDepth: 5,
        direction: GraphTraversalDirection.UP,
      });

      expect(graph.cyclesDetected).toBe(true);
      expect(graph.cycleNodeIds).toContain("node_a");
      expect(graph.nodes).toHaveLength(2);
    });

    it("respects maxDepth bound and records DEPTH_LIMIT_REACHED", async () => {
      const node1 = {
        id: "node_1",
        organizationId: "org_1",
        action: "act.1",
        actorType: "user",
        actorId: "u1",
        resourceType: "r",
        resourceId: "1",
        correlationId: null,
        parentId: "node_2",
        metadata: {},
        createdAt: new Date(),
      };

      const node2 = {
        id: "node_2",
        organizationId: "org_1",
        action: "act.2",
        actorType: "user",
        actorId: "u1",
        resourceType: "r",
        resourceId: "2",
        correlationId: null,
        parentId: "node_3",
        metadata: {},
        createdAt: new Date(),
      };

      prismaMock.auditLog.findUnique
        .mockResolvedValueOnce(node1) // depth 0
        .mockResolvedValueOnce(node2); // depth 1

      prismaMock.auditLog.findMany.mockResolvedValue([]);

      const graph = await service.buildCorrelationGraph({
        organizationId: "org_1",
        rootId: "node_1",
        maxDepth: 1, // depth limit 1
        direction: GraphTraversalDirection.UP,
      });

      expect(graph.nodes).toHaveLength(2);
      expect(graph.missingLinks).toContainEqual({
        sourceNodeId: "node_2",
        targetId: "node_3",
        reason: "DEPTH_LIMIT_REACHED",
      });
    });
  });
});
