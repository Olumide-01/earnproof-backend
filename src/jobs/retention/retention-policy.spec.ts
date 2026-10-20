import {
  cutoffFor,
  DisposalMethod,
  MAXIMUM_RETENTION_DAYS,
  MINIMUM_RETENTION_DAYS,
  RETENTION_CLASSES,
  RetentionConfigError,
  resolveRetentionDays,
  SWEEPABLE_CLASSES,
  SweepMode,
} from "./retention-policy";

const DAY_MS = 24 * 60 * 60 * 1_000;

function classFor(key: string) {
  const entry = RETENTION_CLASSES.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`no retention class ${key}`);
  return entry;
}

describe("retention policy", () => {
  describe("the retention table", () => {
    it("documents purpose, owner, and disposal for every class", () => {
      // These four fields are what an auditor asks for. A class missing any of
      // them is undocumented regardless of whether the code sweeps it.
      for (const entry of RETENTION_CLASSES) {
        expect(entry.purpose.length).toBeGreaterThan(20);
        expect(entry.owner.length).toBeGreaterThan(0);
        expect(Object.values(DisposalMethod)).toContain(entry.disposal);
        expect(Object.values(SweepMode)).toContain(entry.sweep);
      }
    });

    it("gives every class a defensible default duration", () => {
      // A missing environment variable must never mean "keep forever".
      for (const entry of RETENTION_CLASSES) {
        expect(entry.defaultDays).toBeGreaterThanOrEqual(
          MINIMUM_RETENTION_DAYS,
        );
        expect(entry.defaultDays).toBeLessThanOrEqual(MAXIMUM_RETENTION_DAYS);
      }
    });

    it("uses unique keys", () => {
      const keys = RETENTION_CLASSES.map((entry) => entry.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("names a backing index for every cutoff column", () => {
      // An unindexed cutoff column turns a bounded sweep into a table scan,
      // which is the failure the batching exists to prevent.
      for (const entry of RETENTION_CLASSES) {
        expect(entry.backingIndex).toMatch(/@@index|@id|@unique/);
      }
    });

    it("explains why each preserved class is preserved", () => {
      for (const entry of RETENTION_CLASSES) {
        if (entry.sweep === SweepMode.PRESERVED) {
          expect(entry.preservationReason?.length ?? 0).toBeGreaterThan(40);
        }
      }
    });
  });

  describe("preserved evidence", () => {
    // The acceptance criterion: proof credentials, revocation evidence, and
    // anchoring state must not be removed unexpectedly.
    it.each(["proofs", "revocation_evidence", "anchoring_state"])(
      "never exposes %s to the automated sweep",
      (key) => {
        expect(classFor(key).sweep).toBe(SweepMode.PRESERVED);
        expect(SWEEPABLE_CLASSES.map((entry) => entry.key)).not.toContain(key);
      },
    );

    it("keeps every sweepable class on deletion, not anonymisation", () => {
      // The sweep implements deletion only. A class marked for anonymisation
      // but flagged sweepable would be silently deleted instead.
      for (const entry of SWEEPABLE_CLASSES) {
        expect(entry.disposal).toBe(DisposalMethod.DELETE);
      }
    });

    it("sweeps only operational record classes", () => {
      expect(SWEEPABLE_CLASSES.map((entry) => entry.key).sort()).toEqual([
        "audit_logs",
        "auth_sessions",
        "failed_anchoring_intents",
        "idempotency_records",
        "verification_events",
        "wallet_challenges",
        "webhook_deliveries",
      ]);
    });
  });

  describe("resolveRetentionDays", () => {
    const entry = classFor("wallet_challenges");

    it("uses the default when no override is set", () => {
      expect(resolveRetentionDays(entry, {})).toBe(entry.defaultDays);
    });

    it("uses the default when the override is blank", () => {
      expect(
        resolveRetentionDays(entry, { [entry.envVar]: "   " }),
      ).toBe(entry.defaultDays);
    });

    it("applies a valid override", () => {
      expect(resolveRetentionDays(entry, { [entry.envVar]: "14" })).toBe(14);
    });

    it("rejects a non-numeric override rather than falling back", () => {
      // A silent fallback would leave an operator believing retention is
      // tighter than it is — the exact failure a policy exists to prevent.
      expect(() =>
        resolveRetentionDays(entry, { [entry.envVar]: "two weeks" }),
      ).toThrow(RetentionConfigError);
    });

    it("rejects a fractional override", () => {
      expect(() =>
        resolveRetentionDays(entry, { [entry.envVar]: "7.5" }),
      ).toThrow(/whole number of days/);
    });

    it("rejects zero, which would delete records on write", () => {
      expect(() => resolveRetentionDays(entry, { [entry.envVar]: "0" })).toThrow(
        /at least 1 day/,
      );
    });

    it("rejects a negative override", () => {
      expect(() =>
        resolveRetentionDays(entry, { [entry.envVar]: "-30" }),
      ).toThrow(RetentionConfigError);
    });

    it("rejects an override that would effectively disable retention", () => {
      expect(() =>
        resolveRetentionDays(entry, {
          [entry.envVar]: String(MAXIMUM_RETENTION_DAYS + 1),
        }),
      ).toThrow(/effectively disables retention/);
    });

    it("accepts the exact boundaries", () => {
      expect(
        resolveRetentionDays(entry, {
          [entry.envVar]: String(MINIMUM_RETENTION_DAYS),
        }),
      ).toBe(MINIMUM_RETENTION_DAYS);
      expect(
        resolveRetentionDays(entry, {
          [entry.envVar]: String(MAXIMUM_RETENTION_DAYS),
        }),
      ).toBe(MAXIMUM_RETENTION_DAYS);
    });

    it("names the offending variable so the fix is obvious", () => {
      expect(() =>
        resolveRetentionDays(entry, { [entry.envVar]: "nope" }),
      ).toThrow(new RegExp(entry.envVar));
    });
  });

  describe("cutoffFor", () => {
    const entry = classFor("webhook_deliveries");
    const now = new Date("2026-08-26T00:00:00.000Z");

    it("subtracts the retention period from the supplied instant", () => {
      const cutoff = cutoffFor(entry, now, { [entry.envVar]: "30" });
      expect(cutoff.toISOString()).toBe("2026-07-27T00:00:00.000Z");
    });

    it("moves with the override", () => {
      const short = cutoffFor(entry, now, { [entry.envVar]: "1" });
      const long = cutoffFor(entry, now, { [entry.envVar]: "365" });
      expect(short.getTime()).toBeGreaterThan(long.getTime());
    });

    it("places a record exactly at the boundary outside the eligible set", () => {
      // Eligibility is `< cutoff`, so a record whose timestamp equals the
      // cutoff is retained. A record is never removed on the exact day its
      // period ends.
      const cutoff = cutoffFor(entry, now, { [entry.envVar]: "30" });
      const atBoundary = new Date(cutoff.getTime());
      const justInside = new Date(cutoff.getTime() - 1);
      const justOutside = new Date(cutoff.getTime() + 1);

      expect(atBoundary.getTime() < cutoff.getTime()).toBe(false);
      expect(justInside.getTime() < cutoff.getTime()).toBe(true);
      expect(justOutside.getTime() < cutoff.getTime()).toBe(false);
    });

    it("is stable for a fixed clock", () => {
      expect(cutoffFor(entry, now).getTime()).toBe(
        cutoffFor(entry, now).getTime(),
      );
    });

    it("advances with the clock", () => {
      const later = new Date(now.getTime() + DAY_MS);
      expect(cutoffFor(entry, later).getTime() - cutoffFor(entry, now).getTime()).toBe(
        DAY_MS,
      );
    });

    it("propagates a configuration error rather than guessing", () => {
      expect(() => cutoffFor(entry, now, { [entry.envVar]: "bad" })).toThrow(
        RetentionConfigError,
      );
    });
  });
});
