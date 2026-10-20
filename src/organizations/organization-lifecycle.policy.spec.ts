import { SweepMode } from "../jobs/retention/retention-policy";
import {
  ARCHIVED_ORGANIZATION_RETENTION,
  archiveRetentionElapsed,
  deletableAfter,
  lifecycleStateOf,
  OrganizationLifecycleState,
} from "./organization-lifecycle.policy";

const DAY = 24 * 60 * 60 * 1000;
const archivedAt = new Date("2026-01-01T00:00:00.000Z");

describe("organization lifecycle policy", () => {
  it.each([
    [{ archivedAt: null, deletedAt: null }, OrganizationLifecycleState.LIVE],
    [{ archivedAt, deletedAt: null }, OrganizationLifecycleState.ARCHIVED],
    [{ archivedAt, deletedAt: new Date() }, OrganizationLifecycleState.DELETED],
    // Deletion wins even if the archive marker were somehow absent.
    [{ archivedAt: null, deletedAt: new Date() }, OrganizationLifecycleState.DELETED],
  ])("derives %p as %s", (row, expected) => {
    expect(lifecycleStateOf(row)).toBe(expected);
  });

  it("is declared as a preserved retention class, never swept automatically", () => {
    expect(ARCHIVED_ORGANIZATION_RETENTION.sweep).toBe(SweepMode.PRESERVED);
    expect(ARCHIVED_ORGANIZATION_RETENTION.defaultDays).toBe(30);
  });

  it("allows deletion strictly after the minimum archive period", () => {
    const boundary = new Date(archivedAt.getTime() + 30 * DAY);

    expect(deletableAfter(archivedAt, {})).toEqual(boundary);
    expect(archiveRetentionElapsed(archivedAt, new Date(boundary.getTime() - 1), {})).toBe(false);
    expect(archiveRetentionElapsed(archivedAt, boundary, {})).toBe(false);
    expect(archiveRetentionElapsed(archivedAt, new Date(boundary.getTime() + 1), {})).toBe(true);
  });

  it("honours the configured period", () => {
    const env = { RETENTION_ORGANIZATION_ARCHIVE_DAYS: "90" };

    expect(deletableAfter(archivedAt, env)).toEqual(new Date(archivedAt.getTime() + 90 * DAY));
  });

  it("refuses an override that would allow deletion immediately", () => {
    expect(() => deletableAfter(archivedAt, { RETENTION_ORGANIZATION_ARCHIVE_DAYS: "0" })).toThrow(
      /at least 1 day/,
    );
  });
});
