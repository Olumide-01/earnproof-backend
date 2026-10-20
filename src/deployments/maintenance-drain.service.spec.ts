import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { MaintenancePhase } from "./dto/maintenance-drain.dto";
import { MaintenanceDrainService } from "./maintenance-drain.service";

describe("MaintenanceDrainService", () => {
  let service: MaintenanceDrainService;

  beforeEach(() => {
    service = new MaintenanceDrainService();
  });

  it("starts in NORMAL phase and allows mutations and reads", () => {
    const status = service.getStatus();
    expect(status.phase).toBe(MaintenancePhase.NORMAL);
    expect(status.mutationsAllowed).toBe(true);
    expect(status.readsAllowed).toBe(true);
  });

  it("transitions to DRAINING and then MAINTENANCE when in-flight mutations finish", () => {
    // 1 in-flight mutation
    service.trackMutationStart();
    expect(service.getStatus().inFlightMutations).toBe(1);

    // Initiate drain
    const drain = service.initiateDrain({
      reason: "zero-downtime rolling update",
      timeoutSeconds: 60,
    });
    expect(drain.phase).toBe(MaintenancePhase.DRAINING);
    expect(drain.mutationsAllowed).toBe(false);

    // New mutations are rejected
    expect(() => service.trackMutationStart()).toThrow(
      ServiceUnavailableException,
    );

    // Reads remain allowed
    expect(service.getStatus().readsAllowed).toBe(true);

    // Finish in-flight mutation
    service.trackMutationEnd();
    expect(service.getStatus().phase).toBe(MaintenancePhase.MAINTENANCE);
    expect(service.getStatus().inFlightMutations).toBe(0);
  });

  it("transitions directly to MAINTENANCE if zero in-flight mutations when drain begins", () => {
    const drain = service.initiateDrain({
      reason: "cold restart",
      timeoutSeconds: 30,
    });
    expect(drain.phase).toBe(MaintenancePhase.MAINTENANCE);
  });

  it("resumes NORMAL operations safely", () => {
    service.initiateDrain({ reason: "upgrade", timeoutSeconds: 30 });
    const resumed = service.resumeNormal();
    expect(resumed.phase).toBe(MaintenancePhase.NORMAL);
    expect(resumed.mutationsAllowed).toBe(true);
  });
});
