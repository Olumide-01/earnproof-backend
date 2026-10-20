import { PaymentBackfillWorkerService } from "./payment-backfill-worker.service";

describe("PaymentBackfillWorkerService", () => {
  it("runs one lease per tick with a stable owner identity", async () => {
    const backfills = { runLease: jest.fn().mockResolvedValue("idle") };
    const worker = new PaymentBackfillWorkerService(backfills as never);

    await worker.poll();
    await worker.poll();

    expect(backfills.runLease).toHaveBeenCalledTimes(2);
    const [[first], [second]] = backfills.runLease.mock.calls;
    expect(first).toMatch(/^backfill-worker:/);
    expect(second).toBe(first);
  });

  it("never overlaps ticks while a lease is still in flight", async () => {
    let release: (value: string) => void = () => undefined;
    const backfills = {
      runLease: jest.fn(
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const worker = new PaymentBackfillWorkerService(backfills as never);

    const inFlight = worker.poll();
    await worker.poll();
    expect(backfills.runLease).toHaveBeenCalledTimes(1);

    release("completed");
    await inFlight;
    backfills.runLease.mockImplementation(() => Promise.resolve("idle"));
    await worker.poll();
    expect(backfills.runLease).toHaveBeenCalledTimes(2);
  });

  it("stops claiming once shutdown begins", async () => {
    const backfills = { runLease: jest.fn().mockResolvedValue("idle") };
    const worker = new PaymentBackfillWorkerService(backfills as never);

    worker.onApplicationShutdown();
    await worker.poll();

    expect(backfills.runLease).not.toHaveBeenCalled();
  });

  it("contains unexpected errors so the scheduler keeps running", async () => {
    const backfills = { runLease: jest.fn().mockRejectedValue(new Error("db down")) };
    const worker = new PaymentBackfillWorkerService(backfills as never);

    await expect(worker.poll()).resolves.toBeUndefined();
    await worker.poll();
    expect(backfills.runLease).toHaveBeenCalledTimes(2);
  });
});
