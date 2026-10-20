import { backoffDelayMs } from "./backoff";

describe("backoffDelayMs", () => {
  const base = { baseMs: 100, maxDelayMs: 2_000 };

  it("scales the cap exponentially with the attempt number", () => {
    // random() = 1 would be out of range, so the largest representable delay is
    // just under the cap; use random() ~= 1 to observe the cap growth.
    const nearOne = () => 0.999999;
    expect(backoffDelayMs(1, { ...base, random: nearOne })).toBe(99); // cap 100
    expect(backoffDelayMs(2, { ...base, random: nearOne })).toBe(199); // cap 200
    expect(backoffDelayMs(3, { ...base, random: nearOne })).toBe(399); // cap 400
  });

  it("clamps the exponential term to maxDelayMs", () => {
    const nearOne = () => 0.999999;
    // 100 * 2^10 = 102400, well past the 2000 cap.
    expect(backoffDelayMs(11, { ...base, random: nearOne })).toBe(1999);
  });

  it("applies full jitter: delay is a fraction of the current cap", () => {
    expect(backoffDelayMs(3, { ...base, random: () => 0 })).toBe(0);
    expect(backoffDelayMs(3, { ...base, random: () => 0.5 })).toBe(200); // half of 400
  });

  it("never returns a negative delay for a zero or negative attempt", () => {
    expect(backoffDelayMs(0, { ...base, random: () => 0.5 })).toBe(50); // cap 100
    expect(backoffDelayMs(-5, { ...base, random: () => 0.5 })).toBe(50);
  });

  it("does not overflow for very large attempt numbers", () => {
    const delay = backoffDelayMs(1_000, { ...base, random: () => 0.5 });
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBe(1_000); // half of the 2000 cap
  });
});
