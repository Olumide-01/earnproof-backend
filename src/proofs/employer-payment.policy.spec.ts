import { ResourceStatus } from "@prisma/client";
import {
  EmployerSourceRecord,
  MAX_EMPLOYER_PAYMENT_PERIOD_DAYS,
  isWithinEmployerPaymentPeriod,
  orderEmployerPaymentCandidates,
  resolveEmployerSource,
  selectEmployerPayment,
  validateEmployerPaymentPeriod,
} from "./employer-payment.policy";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("employer-payment policy", () => {
  describe("validateEmployerPaymentPeriod", () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    const start = new Date("2026-08-01T00:00:00.000Z");

    it("accepts a period that ends exactly now", () => {
      expect(validateEmployerPaymentPeriod(start, now, now)).toBeNull();
    });

    it("rejects a period that ends one millisecond in the future", () => {
      expect(
        validateEmployerPaymentPeriod(start, new Date(now.getTime() + 1), now),
      ).toBe("ends_in_future");
    });

    it.each([
      ["empty", start, start],
      ["inverted", now, start],
    ])("rejects an %s period", (_label, from, to) => {
      expect(validateEmployerPaymentPeriod(from, to, now)).toBe(
        "empty_or_inverted",
      );
    });

    it("accepts exactly the maximum length and rejects one millisecond more", () => {
      const end = now;
      const maxStart = new Date(
        end.getTime() - MAX_EMPLOYER_PAYMENT_PERIOD_DAYS * DAY_MS,
      );
      expect(validateEmployerPaymentPeriod(maxStart, end, now)).toBeNull();
      expect(
        validateEmployerPaymentPeriod(
          new Date(maxStart.getTime() - 1),
          end,
          now,
        ),
      ).toBe("too_long");
    });

    it("rejects invalid dates", () => {
      expect(
        validateEmployerPaymentPeriod(new Date("nope"), now, now),
      ).toBe("invalid_date");
    });
  });

  describe("isWithinEmployerPaymentPeriod", () => {
    const start = new Date("2026-08-01T00:00:00.000Z");
    const end = new Date("2026-09-01T00:00:00.000Z");

    it("includes the start instant and excludes the end instant", () => {
      expect(isWithinEmployerPaymentPeriod(start, start, end)).toBe(true);
      expect(
        isWithinEmployerPaymentPeriod(new Date(end.getTime() - 1), start, end),
      ).toBe(true);
      expect(isWithinEmployerPaymentPeriod(end, start, end)).toBe(false);
      expect(
        isWithinEmployerPaymentPeriod(new Date(start.getTime() - 1), start, end),
      ).toBe(false);
    });
  });

  describe("resolveEmployerSource", () => {
    const source = (
      overrides: Partial<EmployerSourceRecord> = {},
      issuer: Partial<NonNullable<EmployerSourceRecord["issuer"]>> = {},
      organizationStatus: ResourceStatus = ResourceStatus.ACTIVE,
    ): EmployerSourceRecord => ({
      id: "ts_1",
      sourceAddress: "GPAYER",
      status: ResourceStatus.ACTIVE,
      issuerId: "issuer_1",
      issuer: {
        id: "issuer_1",
        status: ResourceStatus.ACTIVE,
        stellarAddress: "GISSUER",
        organization: { status: organizationStatus },
        ...issuer,
      },
      ...overrides,
    });

    it("resolves an active source linked to an active issuer", () => {
      expect(resolveEmployerSource(source(), null)).toEqual({
        ok: true,
        issuerId: "issuer_1",
        sourceAddress: "GPAYER",
        isIssuerAccount: false,
      });
    });

    it("flags the issuer's own registered account", () => {
      expect(
        resolveEmployerSource(
          source({ sourceAddress: "GISSUER" }),
          "issuer_1",
        ),
      ).toMatchObject({ ok: true, isIssuerAccount: true });
    });

    it.each([
      ["revoked source", source({ status: ResourceStatus.REVOKED }), "source_inactive"],
      ["deleted source", source({ status: ResourceStatus.DELETED }), "source_inactive"],
      ["unlinked source", source({ issuerId: null, issuer: null }), "source_unlinked"],
      ["pending issuer", source({}, { status: ResourceStatus.PENDING }), "issuer_inactive"],
      ["revoked issuer", source({}, { status: ResourceStatus.REVOKED }), "issuer_inactive"],
      ["suspended issuer", source({}, { status: ResourceStatus.SUSPENDED }), "issuer_inactive"],
      ["suspended organization", source({}, {}, ResourceStatus.SUSPENDED), "organization_inactive"],
    ] as const)("refuses a %s", (_label, record, reason) => {
      expect(resolveEmployerSource(record, null)).toEqual({ ok: false, reason });
    });

    it("refuses an address registered to a different issuer as ambiguous", () => {
      expect(resolveEmployerSource(source(), "issuer_2")).toEqual({
        ok: false,
        reason: "ambiguous_issuer",
      });
    });
  });

  describe("deterministic selection", () => {
    const candidates = [
      { id: "p1", operationId: "300", occurredAt: new Date("2026-08-10T00:00:00Z") },
      { id: "p2", operationId: "200", occurredAt: new Date("2026-08-20T00:00:00Z") },
      { id: "p3", operationId: "100", occurredAt: new Date("2026-08-20T00:00:00Z") },
      { id: "p4", operationId: "400", occurredAt: new Date("2026-08-05T00:00:00Z") },
    ];
    const reference = (candidate: { operationId: string }) =>
      `ref:${candidate.operationId}`;

    it("orders newest first with the operation id as tie-breaker", () => {
      expect(
        orderEmployerPaymentCandidates(candidates).map((c) => c.id),
      ).toEqual(["p3", "p2", "p1", "p4"]);
    });

    it("selects the same payment for every input permutation", () => {
      const permutations = [
        candidates,
        [...candidates].reverse(),
        [candidates[2], candidates[0], candidates[3], candidates[1]],
      ];
      const selected = permutations.map(
        (rows) =>
          selectEmployerPayment(rows, false, new Set(["ref:200", "ref:300"]), reference)
            ?.payment.id,
      );
      expect(new Set(selected)).toEqual(new Set(["p2"]));
    });

    it("selects the newest payment for an issuer-owned account", () => {
      expect(
        selectEmployerPayment(candidates, true, new Set(), reference),
      ).toEqual({ payment: candidates[2], corroboration: "issuer_account" });
    });

    it("returns null when nothing is corroborated", () => {
      expect(
        selectEmployerPayment(candidates, false, new Set(["ref:999"]), reference),
      ).toBeNull();
    });

    it("does not mutate the input", () => {
      const copy = [...candidates];
      orderEmployerPaymentCandidates(candidates);
      expect(candidates).toEqual(copy);
    });
  });
});
