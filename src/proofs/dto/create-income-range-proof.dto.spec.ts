import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateIncomeRangeProofDto } from "./create-income-range-proof.dto";

function makeBody(overrides: Partial<CreateIncomeRangeProofDto> = {}) {
  return {
    selectedPaymentIds: ["payment_1"],
    lowerBound: "500.0000000",
    upperBound: "1500.0000000",
    assetCode: "USDC",
    periodStart: "2025-01-01T00:00:00.000Z",
    periodEnd: "2025-01-31T23:59:59.000Z",
    ...overrides,
  };
}

async function errorsFor(body: Record<string, unknown>) {
  const instance = plainToInstance(CreateIncomeRangeProofDto, body);
  return validate(instance);
}

describe("CreateIncomeRangeProofDto", () => {
  it("accepts a well-formed request", async () => {
    const errors = await errorsFor(makeBody());
    expect(errors).toHaveLength(0);
  });

  it("rejects an over-precise lowerBound (8 decimal places)", async () => {
    const errors = await errorsFor(makeBody({ lowerBound: "500.12345678" }));
    expect(errors.some((e) => e.property === "lowerBound")).toBe(true);
  });

  it("rejects an over-precise upperBound (8 decimal places)", async () => {
    const errors = await errorsFor(makeBody({ upperBound: "1500.12345678" }));
    expect(errors.some((e) => e.property === "upperBound")).toBe(true);
  });

  it("rejects a negative-looking lowerBound", async () => {
    const errors = await errorsFor(makeBody({ lowerBound: "-5.0" }));
    expect(errors.some((e) => e.property === "lowerBound")).toBe(true);
  });

  it("rejects a negative-looking upperBound", async () => {
    const errors = await errorsFor(makeBody({ upperBound: "-5.0" }));
    expect(errors.some((e) => e.property === "upperBound")).toBe(true);
  });

  it("rejects a malformed (non-numeric) bound", async () => {
    const errors = await errorsFor(makeBody({ lowerBound: "abc" }));
    expect(errors.some((e) => e.property === "lowerBound")).toBe(true);
  });

  it("rejects an empty selectedPaymentIds array", async () => {
    const errors = await errorsFor(makeBody({ selectedPaymentIds: [] }));
    expect(errors.some((e) => e.property === "selectedPaymentIds")).toBe(true);
  });

  it("requires periodStart/periodEnd to be ISO date strings", async () => {
    const errors = await errorsFor(makeBody({ periodStart: "not-a-date" }));
    expect(errors.some((e) => e.property === "periodStart")).toBe(true);
  });
});
