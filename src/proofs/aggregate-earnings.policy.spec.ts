import {
  AggregationComponent,
  AggregationPolicyError,
  MAX_COMPONENT_PAYMENTS,
  MAX_PERIOD_DAYS,
  ROUNDING_INCREMENTS,
  RoundingIncrement,
  aggregateEarnings,
  floorToIncrement,
  formatStroops,
  parseStroops,
  resolveAsset,
  resolvePeriod,
} from "./aggregate-earnings.policy";

const USDC = { code: "USDC", issuer: "GISSUER" };
const START = new Date("2026-01-01T00:00:00.000Z");
const END = new Date("2026-02-01T00:00:00.000Z");
const PERIOD = { start: START, end: END };
const DAY_MS = 24 * 60 * 60 * 1000;

function component(
  operationId: string,
  amount: string | null,
  overrides: Partial<AggregationComponent> = {},
): AggregationComponent {
  return {
    operationId,
    amount,
    occurredAt: new Date("2026-01-15T00:00:00.000Z"),
    assetCode: USDC.code,
    assetIssuer: USDC.issuer,
    ...overrides,
  };
}

function rules(roundingIncrement: RoundingIncrement = "0.0000001") {
  return { asset: USDC, period: PERIOD, roundingIncrement };
}

function rejection(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (error instanceof AggregationPolicyError) return error.reason;
    throw error;
  }
  throw new Error("expected a policy rejection");
}

/** Deterministic PRNG (mulberry32), so every "property" run is reproducible. */
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function randomAmount(random: () => number): string {
  const whole = Math.floor(random() * 1_000_000);
  const fraction = Math.floor(random() * 10_000_000).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
}

// ---------------------------------------------------------------------------
// Numeric normalisation
// ---------------------------------------------------------------------------

describe("parseStroops", () => {
  it.each([
    ["0", BigInt(0)],
    ["1", BigInt(10_000_000)],
    ["1.5", BigInt(15_000_000)],
    ["0.0000001", BigInt(1)],
    ["922337203685.4775807", BigInt("9223372036854775807")],
    ["9999999999999999999.9999999", BigInt("99999999999999999999999999")],
  ])("parses %s", (amount, stroops) => {
    expect(parseStroops(amount)).toBe(stroops);
  });

  it.each([
    ["eight fractional digits", "1.00000001"],
    ["a trailing point", "1."],
    ["a leading point", ".5"],
    ["a sign", "-1"],
    ["a plus sign", "+1"],
    ["exponent notation", "1e3"],
    ["whitespace", " 1"],
    ["a comma", "1,000"],
    ["twenty integer digits", "1".repeat(20)],
    ["empty", ""],
  ])("rejects %s", (_label, amount) => {
    expect(parseStroops(amount)).toBeNull();
  });
});

describe("formatStroops", () => {
  it("formats with exactly seven decimals", () => {
    expect(formatStroops(BigInt(0))).toBe("0.0000000");
    expect(formatStroops(BigInt(1))).toBe("0.0000001");
    expect(formatStroops(BigInt(12_345_000_000))).toBe("1234.5000000");
  });

  it("round-trips every parseable amount", () => {
    const random = prng(7);
    for (let i = 0; i < 200; i += 1) {
      const stroops = parseStroops(randomAmount(random)) as bigint;
      expect(parseStroops(formatStroops(stroops))).toBe(stroops);
    }
  });
});

describe("floorToIncrement", () => {
  it.each([
    ["1", "1234.9999999", "1234.0000000"],
    ["10", "1234.9999999", "1230.0000000"],
    ["1000", "999.9999999", "0.0000000"],
    ["0.01", "5.0099999", "5.0000000"],
    ["0.0000001", "5.0099999", "5.0099999"],
    ["100", "300.0000000", "300.0000000"],
  ] as const)("floors to %s", (increment, total, expected) => {
    expect(formatStroops(floorToIncrement(parseStroops(total) as bigint, increment))).toBe(
      expected,
    );
  });

  it("never overstates and loses less than one increment (property)", () => {
    const random = prng(11);
    for (let i = 0; i < 500; i += 1) {
      const total = parseStroops(randomAmount(random)) as bigint;
      for (const increment of ROUNDING_INCREMENTS) {
        const step = parseStroops(increment) as bigint;
        const floored = floorToIncrement(total, increment);
        expect(floored <= total).toBe(true);
        expect(total - floored < step).toBe(true);
        expect(floored % step).toBe(BigInt(0));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Asset and period rules
// ---------------------------------------------------------------------------

describe("resolveAsset", () => {
  it("collapses repeated mentions of one asset", () => {
    expect(resolveAsset([USDC, { ...USDC }])).toEqual(USDC);
  });

  it("treats a missing issuer as native", () => {
    expect(resolveAsset([{ code: "XLM", issuer: null }])).toEqual({ code: "XLM", issuer: null });
  });

  it.each([
    ["two codes", [USDC, { code: "EURC", issuer: "GISSUER" }]],
    ["one code from two issuers", [USDC, { code: "USDC", issuer: "GOTHER" }]],
    ["native and issued", [{ code: "XLM", issuer: null }, USDC]],
  ])("refuses %s without a conversion policy", (_label, assets) => {
    expect(rejection(() => resolveAsset(assets))).toBe("cross_asset_unsupported");
  });

  it("does not accept an unknown conversion policy name", () => {
    expect(
      rejection(() => resolveAsset([USDC, { code: "XLM", issuer: null }], "spot-rate-v1")),
    ).toBe("cross_asset_unsupported");
  });

  it("refuses an empty asset list", () => {
    expect(rejection(() => resolveAsset([]))).toBe("cross_asset_unsupported");
  });
});

describe("resolvePeriod", () => {
  const now = new Date("2026-06-01T00:00:00.000Z");

  it("accepts a period ending exactly now", () => {
    expect(resolvePeriod("2026-05-01T00:00:00.000Z", now.toISOString(), now).end).toEqual(now);
  });

  it("refuses a period ending one millisecond in the future", () => {
    expect(
      rejection(() =>
        resolvePeriod("2026-05-01T00:00:00.000Z", new Date(now.getTime() + 1).toISOString(), now),
      ),
    ).toBe("future_period");
  });

  it(`accepts exactly ${MAX_PERIOD_DAYS} days and refuses one millisecond more`, () => {
    const end = new Date("2026-05-31T00:00:00.000Z");
    const start = new Date(end.getTime() - MAX_PERIOD_DAYS * DAY_MS);
    expect(() => resolvePeriod(start.toISOString(), end.toISOString(), now)).not.toThrow();
    expect(
      rejection(() =>
        resolvePeriod(new Date(start.getTime() - 1).toISOString(), end.toISOString(), now),
      ),
    ).toBe("period_too_long");
  });

  it.each([
    ["an empty period", "2026-05-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z"],
    ["a reversed period", "2026-05-02T00:00:00.000Z", "2026-05-01T00:00:00.000Z"],
    ["an unparseable date", "not-a-date", "2026-05-01T00:00:00.000Z"],
  ])("refuses %s", (_label, start, end) => {
    expect(rejection(() => resolvePeriod(start, end, now))).toBe("invalid_period");
  });
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

describe("aggregateEarnings", () => {
  it("sums exactly and floors to the increment", () => {
    const result = aggregateEarnings(
      [component("op-1", "100.1234567"), component("op-2", "250.9000000")],
      rules("1"),
    );
    expect(result).toMatchObject({ disclosedAmount: "351.0000000", paymentCount: 2 });
  });

  it("counts a payment at periodStart and excludes one at periodEnd", () => {
    const result = aggregateEarnings(
      [
        component("op-start", "1", { occurredAt: START }),
        component("op-last-ms", "2", { occurredAt: new Date(END.getTime() - 1) }),
        component("op-end", "4", { occurredAt: END }),
        component("op-before", "8", { occurredAt: new Date(START.getTime() - 1) }),
      ],
      rules(),
    );
    expect(result).toMatchObject({ disclosedAmount: "3.0000000", paymentCount: 2 });
  });

  it("ignores payments in another asset even if a caller passed them", () => {
    const result = aggregateEarnings(
      [
        component("op-1", "1"),
        component("op-2", "2"),
        component("op-3", "1000", { assetCode: "EURC" }),
        component("op-4", "1000", { assetIssuer: "GOTHER" }),
      ],
      rules(),
    );
    expect(result.disclosedAmount).toBe("3.0000000");
  });

  it("counts a duplicated payment once", () => {
    const result = aggregateEarnings(
      [component("op-1", "10"), component("op-1", "10"), component("op-2", "5")],
      rules(),
    );
    expect(result).toMatchObject({ disclosedAmount: "15.0000000", paymentCount: 2 });
  });

  it("refuses a duplicated payment with conflicting amounts", () => {
    expect(
      rejection(() =>
        aggregateEarnings(
          [component("op-1", "10"), component("op-1", "11"), component("op-2", "5")],
          rules(),
        ),
      ),
    ).toBe("amount_unavailable");
  });

  it("refuses fewer than two payments", () => {
    expect(rejection(() => aggregateEarnings([component("op-1", "10")], rules()))).toBe(
      "insufficient_payments",
    );
    expect(
      rejection(() => aggregateEarnings([component("op-1", "10"), component("op-1", "10")], rules())),
    ).toBe("insufficient_payments");
  });

  it(`accepts ${MAX_COMPONENT_PAYMENTS} payments and refuses one more`, () => {
    const many = Array.from({ length: MAX_COMPONENT_PAYMENTS + 1 }, (_, i) =>
      component(`op-${i}`, "1"),
    );
    expect(aggregateEarnings(many.slice(0, MAX_COMPONENT_PAYMENTS), rules()).paymentCount).toBe(
      MAX_COMPONENT_PAYMENTS,
    );
    expect(rejection(() => aggregateEarnings(many, rules()))).toBe("limit_exceeded");
  });

  it.each([
    ["undecryptable", null],
    ["malformed", "1.00000001"],
    ["negative", "-5"],
  ])("refuses the whole aggregate when an amount is %s", (_label, amount) => {
    expect(
      rejection(() => aggregateEarnings([component("op-1", "10"), component("op-2", amount)], rules())),
    ).toBe("amount_unavailable");
  });

  it("refuses a total that floors to zero", () => {
    expect(
      rejection(() =>
        aggregateEarnings([component("op-1", "400"), component("op-2", "599.9999999")], rules("1000")),
      ),
    ).toBe("below_rounding_increment");
  });

  it("accepts a total exactly equal to the increment", () => {
    expect(
      aggregateEarnings([component("op-1", "400"), component("op-2", "600")], rules("1000"))
        .disclosedAmount,
    ).toBe("1000.0000000");
  });

  it("orders canonical components by operation id", () => {
    const result = aggregateEarnings(
      [component("op-b", "2"), component("op-a", "1")],
      rules(),
    );
    expect(result.canonicalComponents).toEqual([
      ["op-a", "10000000"],
      ["op-b", "20000000"],
    ]);
  });
});

describe("aggregateEarnings properties", () => {
  it("does not depend on row order, and equals the exact floored sum", () => {
    const random = prng(2026);
    for (let run = 0; run < 100; run += 1) {
      const count = 2 + Math.floor(random() * 40);
      const components = Array.from({ length: count }, (_, i) =>
        component(`op-${run}-${i}`, randomAmount(random), {
          occurredAt: new Date(START.getTime() + Math.floor(random() * (END.getTime() - START.getTime()))),
        }),
      );
      const increment = ROUNDING_INCREMENTS[Math.floor(random() * 3)];
      const expected = floorToIncrement(
        components.reduce((sum, c) => sum + (parseStroops(c.amount as string) as bigint), BigInt(0)),
        increment,
      );

      const baseline = aggregateEarnings(components, rules(increment));
      expect(baseline.disclosedAmount).toBe(formatStroops(expected));

      for (let permutation = 0; permutation < 5; permutation += 1) {
        expect(aggregateEarnings(shuffled(components, random), rules(increment))).toEqual(baseline);
      }
    }
  });

  it("is unchanged by any number of repeated rows", () => {
    const random = prng(99);
    for (let run = 0; run < 50; run += 1) {
      const components = Array.from({ length: 2 + Math.floor(random() * 10) }, (_, i) =>
        component(`op-${i}`, randomAmount(random)),
      );
      const repeated = components.flatMap((c) =>
        Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({ ...c })),
      );
      expect(aggregateEarnings(shuffled(repeated, random), rules())).toEqual(
        aggregateEarnings(components, rules()),
      );
    }
  });
});
