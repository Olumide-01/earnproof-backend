import { METRIC_NAMES } from "../common/observability/metrics.catalog";
import { RevocationPropagationController } from "./revocation-propagation.controller";

describe("RevocationPropagationController", () => {
  it("returns only the revocation propagation metric series", () => {
    const unrelated = { name: "http_requests_total", help: "", type: "counter" as const, series: [] };
    const checks = {
      name: METRIC_NAMES.revocationPropagationChecksTotal,
      help: "",
      type: "counter" as const,
      series: [{ labels: { channel: "webhook", propagation_state: "pending" }, value: 3 }],
    };
    const lag = {
      name: METRIC_NAMES.revocationPropagationLagSeconds,
      help: "",
      type: "histogram" as const,
      buckets: [60, 300],
      series: [],
    };
    const metrics = {
      snapshot: jest.fn().mockReturnValue([unrelated, checks, lag]),
    };

    const controller = new RevocationPropagationController(metrics as never);
    const result = controller.getHealth();

    expect(result.metrics).toEqual([checks, lag]);
    expect(result.metrics).not.toContainEqual(unrelated);
  });

  it("never includes a proof identifier or payload in the response shape", () => {
    const checks = {
      name: METRIC_NAMES.revocationPropagationChecksTotal,
      help: "",
      type: "counter" as const,
      series: [{ labels: { channel: "anchoring", propagation_state: "confirmed" }, value: 1 }],
    };
    const metrics = { snapshot: jest.fn().mockReturnValue([checks]) };

    const controller = new RevocationPropagationController(metrics as never);
    const result = controller.getHealth();

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/proof/i);
    expect(serialized).not.toContain("payload");
  });
});
