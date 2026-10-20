import { ConfigService } from "@nestjs/config";
import type { MonitoredAccount, PaymentAccountResolver } from "./payment-account.resolver";
import { PaymentsService } from "./payments.service";

/** syncPayments reads the monitored account, not the login wallet (#321). */
describe("PaymentsService monitored-account sync", () => {
  const user = { id: "user-1", walletAddress: "GWALLET" };
  const config = {
    get: jest.fn((key: string) => (key === "paymentEncryptionKey" ? "a1".repeat(32) : undefined)),
    getOrThrow: jest.fn(() => "testnet"),
  } as unknown as ConfigService;

  function build(resolver?: Partial<PaymentAccountResolver>) {
    const service = new PaymentsService(
      {} as never,
      {} as never,
      config,
      {} as never,
      {} as never,
      {} as never,
      resolver as PaymentAccountResolver | undefined,
    );
    const syncAccount = jest
      .spyOn(service as unknown as { syncAccount: (u: unknown) => Promise<unknown> }, "syncAccount")
      .mockResolvedValue({ synced: true });
    return { service, syncAccount };
  }

  it("syncs the wallet exactly as before when no resolver is wired (regression)", async () => {
    const { service, syncAccount } = build();
    await service.syncPayments(user);
    expect(syncAccount).toHaveBeenCalledWith(user);
  });

  it("syncs the active monitored account and then guards the checkpoint", async () => {
    const account: MonitoredAccount = { accountId: "GROTATED", network: "testnet", epochId: "e1", source: "rotation" };
    const resolver = {
      current: jest.fn().mockResolvedValue(account),
      discardStaleCheckpoint: jest.fn().mockResolvedValue(false),
    };
    const { service, syncAccount } = build(resolver);

    await expect(service.syncPayments(user)).resolves.toEqual({ synced: true });
    expect(syncAccount).toHaveBeenCalledWith({ id: "user-1", walletAddress: "GROTATED" });
    expect(resolver.discardStaleCheckpoint).toHaveBeenCalledWith(user, account);
  });

  it("still guards the checkpoint when the sync throws", async () => {
    const account: MonitoredAccount = { accountId: "GWALLET", network: "testnet", epochId: null, source: "wallet" };
    const resolver = {
      current: jest.fn().mockResolvedValue(account),
      discardStaleCheckpoint: jest.fn().mockResolvedValue(true),
    };
    const { service, syncAccount } = build(resolver);
    syncAccount.mockRejectedValueOnce(new Error("horizon down"));

    await expect(service.syncPayments(user)).rejects.toThrow("horizon down");
    expect(resolver.discardStaleCheckpoint).toHaveBeenCalledTimes(1);
  });
});
