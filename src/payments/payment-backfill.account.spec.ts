import { ConfigService } from "@nestjs/config";
import { PaymentBackfillService } from "./payment-backfill.service";

/** Which account a backfill job scans (#321). */
describe("PaymentBackfillService scanned account", () => {
  function build(job: Record<string, unknown>) {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([job]),
      user: { findUnique: jest.fn().mockResolvedValue({ walletAddress: "GWALLET" }) },
      paymentBackfillJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    // Stop after the read: the address it was asked for is what matters here.
    const stellar = { readPaymentsPageAscending: jest.fn().mockRejectedValue(new Error("stop")) };
    const config = { get: jest.fn(() => undefined) } as unknown as ConfigService;
    return { stellar, service: new PaymentBackfillService(prisma as never, stellar as never, config) };
  }

  const baseJob = { id: "job-1", userId: "user-1", startLedger: 100, endLedger: 200, checkpointCursor: null, attempts: 1 };

  it("scans the account a rotation planned the job for", async () => {
    const { service, stellar } = build({ ...baseJob, accountId: "GROTATED" });
    await service.runLease("owner-1");
    expect(stellar.readPaymentsPageAscending).toHaveBeenCalledWith("GROTATED", expect.any(Object));
  });

  it("scans the user's wallet for legacy jobs (regression)", async () => {
    const { service, stellar } = build({ ...baseJob, accountId: null });
    await service.runLease("owner-1");
    expect(stellar.readPaymentsPageAscending).toHaveBeenCalledWith("GWALLET", expect.any(Object));
  });
});
