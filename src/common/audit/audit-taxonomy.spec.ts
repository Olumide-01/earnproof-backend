import { AuthEventType, VerificationOutcome } from "@prisma/client";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import {
  AUDIT_EVENTS,
  DENIED_VERIFICATION_OUTCOMES,
  REQUIRED_AUDIT_DOMAINS,
  auditEvent,
  normalizeAuditActorType,
  resolveAuditEventType,
  resolveAuthAuditEventType,
  verificationOutcomeToAuditOutcome,
} from "./audit-taxonomy";

/**
 * Taxonomy integrity.
 *
 * The matrix test proves the services persist what the taxonomy declares. These
 * tests prove the taxonomy itself stays honest: no duplicate identities, no
 * domain silently dropped, no schema enum value that nothing accounts for, and
 * no event that exists in code but not in the operator-facing document.
 */

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const AUDIT_DOC = join(REPO_ROOT, "docs", "audit-events.md");

describe("audit taxonomy", () => {
  it("names every event with a stable, machine-readable type", () => {
    for (const event of AUDIT_EVENTS) {
      expect(event.type).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it("declares each stable type once", () => {
    const types = AUDIT_EVENTS.map((event) => event.type);

    expect(types).toHaveLength(new Set(types).size);
  });

  it("gives each persisted shape a single meaning", () => {
    // Two events sharing an action/resourceType pair would make a persisted row
    // ambiguous, and `resolveAuditEventType` would silently pick the first.
    const fingerprints = AUDIT_EVENTS.map((event) =>
      event.match.store === "audit_log"
        ? `audit_log:${event.match.action}:${event.match.resourceType}`
        : event.match.store === "auth_audit_event"
          ? `auth_audit_event:${event.match.eventType}`
          : "verification_event_log",
    );

    expect(fingerprints).toHaveLength(new Set(fingerprints).size);
  });

  it("covers every required domain", () => {
    const covered = new Set(AUDIT_EVENTS.map((event) => event.domain));

    expect(REQUIRED_AUDIT_DOMAINS.filter((domain) => !covered.has(domain))).toEqual(
      [],
    );
  });

  it("declares an event for every authentication event type the schema allows", () => {
    // A new `AuthEventType` in schema.prisma is a new thing the service can
    // record. Without this check it would be recorded and never described.
    const undeclared = Object.values(AuthEventType).filter(
      (eventType) => resolveAuthAuditEventType(eventType) === undefined,
    );

    expect(undeclared).toEqual([]);
  });

  it("declares at least one outcome per event", () => {
    for (const event of AUDIT_EVENTS) {
      expect(event.outcomes.length).toBeGreaterThan(0);
    }
  });

  it("declares an explicit write-failure behaviour per event", () => {
    for (const event of AUDIT_EVENTS) {
      expect(["fail_open", "fail_closed"]).toContain(event.writeFailure);
    }
  });

  it("fails closed on every privileged mutation", () => {
    // Fail-open is a deliberate availability trade and is confined to the
    // unauthenticated paths: authentication attempts, credential presentation
    // and public verification. Anything an operator does must leave evidence or
    // fail.
    const failOpen = AUDIT_EVENTS.filter(
      (event) => event.writeFailure === "fail_open",
    ).map((event) => event.type);

    expect(failOpen.sort()).toEqual([
      "authentication.account_inactive",
      "authentication.challenge_created",
      "authentication.challenge_expired",
      "authentication.challenge_replayed",
      "authentication.challenge_verified",
      "authentication.signature_invalid",
      "authorization.api_key_authenticated",
      "authorization.rate_limited",
      "proof.verification_recorded",
    ]);
  });

  it("folds the two persisted spellings of the user actor together", () => {
    // Not cosmetic: `AuditLog` really holds both, so a consumer filtering on
    // one spelling loses the other half of the trail. Asserted here so the
    // compatibility shim cannot be deleted as redundant while the rows differ.
    const persisted = readFileSync(
      join(REPO_ROOT, "src", "issuers", "issuers.service.ts"),
      "utf8",
    );

    expect(persisted).toContain('actorType: "User"');
    expect(normalizeAuditActorType("User")).toBe("user");
    expect(normalizeAuditActorType("user")).toBe("user");
    expect(normalizeAuditActorType("api_key")).toBe("api_key");
  });

  it("resolves a persisted audit_log row to its stable type", () => {
    expect(
      resolveAuditEventType({ action: "api_key.revoked", resourceType: "api_key" }),
    ).toBe("api_key.revoked");
    expect(
      resolveAuditEventType({ action: "CREATE", resourceType: "Issuer" }),
    ).toBe("issuer.created");
    // Same action, different resource: the pair is the identity, not the action.
    expect(
      resolveAuditEventType({ action: "CREATE", resourceType: "Organization" }),
    ).toBe("operator.organization_created");
  });

  it("returns no type for an undeclared row", () => {
    expect(
      resolveAuditEventType({ action: "proof.exported", resourceType: "proof" }),
    ).toBeUndefined();
  });

  it("rejects a lookup of an unknown event type", () => {
    expect(() => auditEvent("api_key.exfiltrated")).toThrow(
      /Unknown audit event type/,
    );
  });

  it("treats every non-VALID verification outcome as a denial", () => {
    for (const outcome of Object.values(VerificationOutcome)) {
      expect(verificationOutcomeToAuditOutcome(outcome)).toBe(
        outcome === VerificationOutcome.VALID ? "success" : "denied",
      );
    }

    // Keeps the exported list in step with the enum, which alerting reads.
    expect([...DENIED_VERIFICATION_OUTCOMES].sort()).toEqual(
      Object.values(VerificationOutcome)
        .filter((outcome) => outcome !== VerificationOutcome.VALID)
        .sort(),
    );
  });
});

describe("audit taxonomy documentation", () => {
  const doc = readFileSync(AUDIT_DOC, "utf8");

  it("documents every declared event", () => {
    const undocumented = AUDIT_EVENTS.filter(
      (event) => !doc.includes(`\`${event.type}\``),
    ).map((event) => event.type);

    expect(undocumented).toEqual([]);
  });

  it("documents the write-failure behaviour of every event", () => {
    for (const event of AUDIT_EVENTS) {
      const row = doc
        .split("\n")
        .find((line) => line.includes(`\`${event.type}\``));

      expect(row).toBeDefined();
      expect(row).toContain(event.writeFailure);
    }
  });
});
