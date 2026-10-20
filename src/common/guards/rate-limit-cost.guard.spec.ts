import { RoleAwareThrottlerGuard } from "./rate-limit.guard";
import { THROTTLE_COST_KEY } from "../rate-limit/throttle-cost.decorator";

/**
 * In-memory throttler storage: counts hits per key so a batch's pre-charged
 * cost, plus the base guard's own final hit, are observable as totalHits.
 */
function fakeStorage() {
  const hits = new Map<string, number>();
  return {
    hits,
    increment: jest.fn(async (key: string, _ttl, limit: number) => {
      const total = (hits.get(key) ?? 0) + 1;
      hits.set(key, total);
      return {
        totalHits: total,
        timeToExpire: 60,
        isBlocked: total > limit,
        timeToBlockExpire: 60,
      };
    }),
  };
}

function makeGuard(resolver: unknown, storage: ReturnType<typeof fakeStorage>) {
  const reflector = {
    getAllAndOverride: jest.fn((key: string) =>
      key === THROTTLE_COST_KEY ? resolver : undefined,
    ),
  };
  const config = { get: jest.fn((_k: string, def: number) => def) };
  const sessionService = { tryIdentify: jest.fn().mockResolvedValue(null) };
  const guard = new RoleAwareThrottlerGuard(
    { throttlers: [], setHeaders: false } as never,
    storage as never,
    reflector as never,
    config as never,
    sessionService as never,
  );
  // handleRequest reads commonOptions.setHeaders; onModuleInit normally sets it.
  (guard as unknown as { commonOptions: object }).commonOptions = {
    setHeaders: false,
  };
  return guard;
}

function requestProps(body: unknown, limit = 10) {
  const request = { headers: {}, body };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ header: jest.fn() }),
    }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  };
  return {
    context,
    limit,
    ttl: 60_000,
    throttler: { name: "verification", setHeaders: false },
    blockDuration: 60_000,
    getTracker: () => Promise.resolve("ip:test"),
    generateKey: () => "key:test",
  } as never;
}

describe("RoleAwareThrottlerGuard batch throttle cost", () => {
  it("charges N tokens for a batch of N items", async () => {
    const storage = fakeStorage();
    const resolver = (req: { body: { items: unknown[] } }) => req.body.items.length;
    const guard = makeGuard(resolver, storage);

    await guard["handleRequest"](requestProps({ items: [1, 2, 3, 4, 5] }));

    // 4 pre-charged increments + 1 from the base guard = 5 total.
    expect(storage.increment).toHaveBeenCalledTimes(5);
    expect(storage.hits.get("key:test")).toBe(5);
  });

  it("charges a single token when no cost resolver is present", async () => {
    const storage = fakeStorage();
    const guard = makeGuard(undefined, storage);

    await guard["handleRequest"](requestProps({ items: [1, 2, 3] }));

    expect(storage.increment).toHaveBeenCalledTimes(1);
  });

  it("throws once the batch cost exhausts the limit", async () => {
    const storage = fakeStorage();
    const resolver = () => 11; // limit is 10
    const guard = makeGuard(resolver, storage);

    await expect(
      guard["handleRequest"](requestProps({ items: [] }, 10)),
    ).rejects.toBeTruthy();
  });

  it("clamps a nonsensical cost to at least one token", async () => {
    const storage = fakeStorage();
    const resolver = () => 0;
    const guard = makeGuard(resolver, storage);

    await guard["handleRequest"](requestProps({ items: [] }));
    expect(storage.increment).toHaveBeenCalledTimes(1);
  });
});
