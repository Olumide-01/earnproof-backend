import { ForbiddenException, NotFoundException, BadRequestException } from "@nestjs/common";
import { SupportAccessStatus } from "@prisma/client";
import { SupportAccessService } from "./support-access.service";

describe("SupportAccessService", () => {
  let service: SupportAccessService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      supportAccessGrant: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
    };
    service = new SupportAccessService(mockPrisma);
  });

  it("creates a pending support access grant", async () => {
    mockPrisma.supportAccessGrant.create.mockResolvedValue({
      id: "grant-1",
      status: SupportAccessStatus.PENDING,
    });

    const grant = await service.createGrant("org-1", "user-req", {
      supportUserId: "supp-1",
      reason: "investigating audit mismatch",
      capabilities: ["read:audit"],
      durationMinutes: 60,
    });

    expect(grant.id).toBe("grant-1");
    expect(mockPrisma.supportAccessGrant.create).toHaveBeenCalled();
  });

  it("prevents self-approval of support access grants", async () => {
    mockPrisma.supportAccessGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      requestedById: "admin-1",
      status: SupportAccessStatus.PENDING,
      expiresAt: new Date(Date.now() + 100000),
    });

    await expect(service.approveGrant("grant-1", "admin-1")).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("approves grant when decided by another admin", async () => {
    mockPrisma.supportAccessGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      requestedById: "admin-1",
      status: SupportAccessStatus.PENDING,
      expiresAt: new Date(Date.now() + 100000),
    });
    mockPrisma.supportAccessGrant.update.mockResolvedValue({
      id: "grant-1",
      status: SupportAccessStatus.APPROVED,
    });

    const res = await service.approveGrant("grant-1", "admin-2");
    expect(res.status).toBe(SupportAccessStatus.APPROVED);
  });

  it("asserts active capability fails on expired or missing grant", async () => {
    mockPrisma.supportAccessGrant.findFirst.mockResolvedValue(null);

    const hasCap = await service.assertActiveCapability("org-1", "supp-1", "read:audit");
    expect(hasCap).toBe(false);
  });

  it("asserts active capability succeeds on matching active grant", async () => {
    mockPrisma.supportAccessGrant.findFirst.mockResolvedValue({
      id: "grant-1",
      status: SupportAccessStatus.ACTIVE,
      capabilities: ["read:audit", "read:proof"],
    });

    const hasCap = await service.assertActiveCapability("org-1", "supp-1", "read:audit");
    expect(hasCap).toBe(true);
  });
});
