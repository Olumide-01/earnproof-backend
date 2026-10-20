# Proof Dispute Decision Notifications

## Overview

Proof dispute decision notifications deliver privacy-safe, deduplicated notifications to proof owners, dispute submitters, and reviewers when disputes change state or reach a decision.

This system ensures all stakeholders stay informed throughout the dispute lifecycle while preserving privacy and authorization boundaries.

## Architecture

### Event-Driven Delivery

Notifications are delivered via the domain event outbox pattern:

1. **Dispute State Change**: User action (submit, assign, resolve, withdraw) triggers a domain event
2. **Transactional Outbox**: Event is persisted atomically with the dispute mutation
3. **Async Worker**: Domain event outbox worker polls and delivers events
4. **Event Handler**: `DisputeDecisionNotificationHandler` creates `SecurityNotification` records
5. **Inbox**: Notifications persist in organization's security notification inbox

### Privacy Guarantees

Notifications **never** include:
- Raw proof claims or data
- Proof balances or amounts
- Credential hashes or verification keys
- Issuer secrets or private material
- Raw evidence commitments

Notifications **only** include:
- Dispute ID and dispute category (ACCURACY, FRAUD, TECHNICAL, COMPLIANCE, OTHER)
- Decision outcome and reasoning (for resolved disputes)
- Withdrawal reason (for withdrawn disputes)
- Participant identifiers (proof owner, dispute submitter, reviewer)
- Event timestamps

### Authorization Model

Notifications are created with tenant and participant scoping:

| Participant | Visibility | Use Case |
|-------------|-----------|----------|
| Proof Owner | User-specific | Principal stakeholder needs outcome |
| Dispute Submitter | User-specific | Initiator needs resolution confirmation |
| Assigned Reviewer | User-specific | Audit trail for reviewer action context |
| Organization | Org-wide (null userId) | Compliance and observability |

The notification handler verifies participants exist and have authorization before creating notifications.

## Event Types

### DISPUTE_FILED

Emitted when a new dispute is submitted.

**Payload:**
```typescript
{
  disputeId: string;
  proofId: string;
  category: DisputeCategory;
  decisionType: "FILED";
  status: DisputeStatus.OPEN;
  participants: {
    proofOwnerId: string;
    disputeSubmitterId: string;
  };
}
```

**Notifications Created:**
- Proof owner: "Dispute filed on your proof"
- Dispute submitter: "Your dispute has been submitted"

**Severity:** WARNING

---

### DISPUTE_ASSIGNED

Emitted when an admin assigns a dispute to a reviewer.

**Payload:**
```typescript
{
  disputeId: string;
  proofId: string;
  category: DisputeCategory;
  decisionType: "ASSIGNED";
  status: DisputeStatus.ASSIGNED;
  participants: {
    proofOwnerId: string;
    disputeSubmitterId: string;
    assignedReviewerId: string;
  };
}
```

**Notifications Created:**
- Proof owner: "Your dispute has been assigned for review"
- Dispute submitter: "Your dispute has been assigned for review"
- Assigned reviewer: "Dispute assigned to you for review"

**Severity:** INFO

---

### DISPUTE_WITHDRAWN

Emitted when the dispute submitter withdraws an open dispute.

**Payload:**
```typescript
{
  disputeId: string;
  proofId: string;
  category: DisputeCategory;
  decisionType: "WITHDRAWN";
  status: DisputeStatus.WITHDRAWN;
  withdrawnBy: string;
  withdrawnAt: string; // ISO timestamp
  participants: {
    proofOwnerId: string;
    disputeSubmitterId: string;
  };
}
```

**Notifications Created:**
- Proof owner: "Dispute withdrawn"
- Dispute submitter: "Your dispute has been withdrawn"

**Severity:** INFO

---

### DISPUTE_RESOLVED

Emitted when a reviewer or admin resolves a dispute with a decision.

**Payload:**
```typescript
{
  disputeId: string;
  proofId: string;
  category: DisputeCategory;
  decisionType: "RESOLVED";
  status: DisputeStatus.RESOLVED;
  resolutionOutcome: string; // e.g., "UPHELD", "REJECTED", "INCONCLUSIVE"
  resolutionReason: string; // Max 2000 chars
  resolvedBy: string; // User ID
  resolvedAt: string; // ISO timestamp
  participants: {
    proofOwnerId: string;
    disputeSubmitterId: string;
    assignedReviewerId?: string;
  };
}
```

**Notifications Created:**
- Proof owner: "Dispute resolved: {OUTCOME}"
- Dispute submitter: "Your dispute has been resolved: {OUTCOME}"
- Assigned reviewer: "Dispute review completed: {OUTCOME}"
- Organization: Audit trail notification

**Severity:** HIGH (for UPHELD outcomes), WARNING (for others), INFO (for inconclusive)

---

### DISPUTE_EXPIRED

Emitted when a proof with an active dispute expires (stale-state cleanup).

**Payload:**
```typescript
{
  disputeId: string;
  proofId: string;
  category: DisputeCategory;
  decisionType: "EXPIRED";
  status: DisputeStatus.EXPIRED;
  participants: {
    proofOwnerId: string;
    disputeSubmitterId: string;
  };
}
```

**Notifications Created:**
- Proof owner: "Dispute closed: proof expired"
- Dispute submitter: "Dispute closed: proof expired"

**Severity:** WARNING

---

## Deduplication

Deduplication occurs at multiple levels:

### Event Level
The domain event outbox maintains a consumer record table tracking `(eventId, consumerName)` pairs. This prevents duplicate handler execution even if the event is processed multiple times.

### Notification Level
Each `SecurityNotification` record is created separately. No built-in deduplication at the notification level. However:
- Events are only emitted once per dispute state change
- Handlers are idempotent (safe to replay)
- Consumer records prevent duplicate handler invocations

### Failure Recovery
If notification creation fails:
1. Handler throws error
2. Domain event outbox marks event for retry
3. Event lease expires, worker tries again
4. Handler executes again (idempotent via consumer dedup)
5. SecurityNotification created successfully on retry

## Stale-State Handling

The `DisputeDecisionNotificationHandler` includes stale-state detection:

```typescript
// Verify dispute still exists
const dispute = await this.prisma.proofDispute.findFirst({...});
if (!dispute) {
  // Dispute may have been deleted - log and continue
  return;
}

// Verify proof exists
const proof = await this.prisma.proof.findUnique({...});
if (!proof) {
  // Proof may have been deleted - log and continue
  return;
}
```

**Behavior:**
- If dispute is not found: Handler logs warning and returns successfully (no retry)
- If proof is not found: Handler logs warning and returns successfully (no retry)
- If organization is not found: Notification creation fails, triggers retry

This prevents infinite retry loops for deleted resources while ensuring organization state is never inconsistent.

## Testing

### Unit Tests

Test the notification handler:

```typescript
describe("DisputeDecisionNotificationHandler", () => {
  describe("handle", () => {
    it("should create notifications for proof owner and dispute submitter", async () => {
      // Setup: create dispute, proof, organization
      const event = createDomainEvent(DisputeResolvedPayload);
      
      await handler.handle(event);
      
      // Assert: verify notifications created for each participant
      expect(securityNotificationService.createNotification).toHaveBeenCalledTimes(3);
    });

    it("should handle stale dispute (not found)", async () => {
      // Setup: event for non-existent dispute
      const event = createDomainEvent(DisputeResolvedPayload);
      prismaService.proofDispute.findFirst.mockResolvedValue(null);
      
      await handler.handle(event); // Should not throw
      
      // Assert: no notifications created, no retry
      expect(securityNotificationService.createNotification).not.toHaveBeenCalled();
    });

    it("should handle authorization errors", async () => {
      // Setup: notification creation fails with ForbiddenException
      securityNotificationService.createNotification.mockRejectedValue(
        new ForbiddenException("Access denied")
      );
      
      await expect(handler.handle(event)).rejects.toThrow(ForbiddenException);
      // Handler should re-throw to trigger retry
    });

    it("should deduplicate consumer records", async () => {
      // Setup: handler called twice with same event
      const event = createDomainEvent(DisputeResolvedPayload);
      
      // First invocation
      await handler.handle(event);
      let notificationCount = securityNotificationService.createNotification.mock.calls.length;
      
      // Second invocation (replay)
      await handler.handle(event);
      let notificationCountAfterReplay = securityNotificationService.createNotification.mock.calls.length;
      
      // Assert: no additional notifications created (deduped via consumer record)
      expect(notificationCountAfterReplay).toBe(notificationCount);
    });
  });
});
```

### Integration Tests

Test end-to-end dispute → notification flow:

```typescript
describe("Dispute Notifications (Integration)", () => {
  it("should emit DISPUTE_RESOLVED event and create notifications", async () => {
    // Setup
    const org = await createOrganization();
    const user = await createUser(org);
    const proof = await createProof(user);
    const dispute = await createDispute(proof, user);
    
    // Action
    await disputesService.resolveDispute(user, org.id, dispute.id, {
      resolutionOutcome: "UPHELD",
      resolutionReason: "Proof data verified as accurate",
    });
    
    // Process events (normally done by worker)
    await domainEventOutboxWorker.processAllPending();
    
    // Assert: notifications created for all participants
    const notifications = await securityNotificationService.listNotifications(org.id, user.id);
    expect(notifications.data).toContainEqual(
      expect.objectContaining({
        type: SecurityNotificationType.DISPUTE_FILED,
        title: expect.stringContaining("UPHELD"),
      })
    );
  });

  it("should create org-wide audit notification", async () => {
    // Setup & Action (same as above)
    
    // Assert: org-wide notification created (userId = null)
    const orgNotifications = await prisma.securityNotification.findMany({
      where: {
        organizationId: org.id,
        userId: null,
      },
    });
    expect(orgNotifications).toContainEqual(
      expect.objectContaining({
        title: expect.stringContaining("[Audit]"),
      })
    );
  });

  it("should handle concurrent dispute resolutions", async () => {
    // Setup: create multiple disputes
    const disputes = await Promise.all([
      createDispute(proof1, user1),
      createDispute(proof2, user2),
      createDispute(proof3, user3),
    ]);
    
    // Action: resolve all concurrently
    await Promise.all(
      disputes.map((d) =>
        disputesService.resolveDispute(user, org.id, d.id, {...})
      )
    );
    
    // Process all events
    await domainEventOutboxWorker.processAllPending();
    
    // Assert: all notifications created without conflicts
    const allNotifications = await prisma.securityNotification.findMany({
      where: { organizationId: org.id },
    });
    expect(allNotifications.length).toBeGreaterThanOrEqual(disputes.length * 3);
  });
});
```

### Privacy Tests

Verify no sensitive data in notifications:

```typescript
describe("Dispute Notification Privacy", () => {
  it("should not include proof claims in notification", async () => {
    // Setup: proof with sensitive claims
    const proof = await createProof(user, {
      claims: { salary: 100000, employer: "ACME Corp" },
    });
    const dispute = await createDispute(proof, user);
    
    // Action
    await disputesService.resolveDispute(admin, org.id, dispute.id, {...});
    await domainEventOutboxWorker.processAllPending();
    
    // Assert: notification data does not contain claims
    const notification = await securityNotificationService.getNotification(
      org.id,
      notificationId,
      user.id
    );
    expect(JSON.stringify(notification.data)).not.toContain("salary");
    expect(JSON.stringify(notification.data)).not.toContain("employer");
  });

  it("should not include evidence commitment in notification", async () => {
    // Setup: dispute with evidence commitment
    const dispute = await createDispute(proof, user, {
      evidenceCommitment: "sha256:abc123...",
    });
    
    // Action & Assert
    await disputesService.resolveDispute(admin, org.id, dispute.id, {...});
    await domainEventOutboxWorker.processAllPending();
    
    const notification = await securityNotificationService.getNotification(...);
    expect(notification.data.evidenceCommitment).toBeUndefined();
  });

  it("should redact sensitive fields in notification data", async () => {
    // NotificationHandler should redact fields per SecurityNotificationService
    
    const notification = {...};
    expect(notification.data.secret).toBe("[REDACTED]");
    expect(notification.data.token).toBe("[REDACTED]");
    expect(notification.data.privateKey).toBe("[REDACTED]");
  });
});
```

## Operations

### Monitoring

Key metrics to monitor:

1. **Event Processing**
   - `domain_event_outbox_processed_total{event_type="DISPUTE_*"}`: Events processed
   - `domain_event_outbox_errors_total{event_type="DISPUTE_*"}`: Processing errors
   - `domain_event_outbox_retries_total`: Retry count

2. **Notification Delivery**
   - `security_notifications_created_total{type="DISPUTE_FILED"}`: Notifications created
   - `security_notifications_acknowledged_total`: Acknowledgments
   - `security_notification_handler_errors_total`: Handler errors

3. **Latency**
   - `domain_event_processing_duration_seconds`: Time from event to processing
   - `security_notification_creation_duration_seconds`: Notification creation time

### Troubleshooting

**Notifications not appearing:**
1. Check domain event outbox worker is running
2. Verify events are created in outbox (`SELECT * FROM domain_event_outbox WHERE event_type LIKE 'DISPUTE_%'`)
3. Check handler errors in logs
4. Verify organization exists and is active
5. Confirm user is member of organization

**Duplicate notifications:**
1. Check `domain_event_consumer_record` table for duplicate entries
2. Verify handler consumer name is consistent
3. Check for handler re-invocation (e.g., manual retries)

**Missing participants:**
1. Verify proof owner exists in organization
2. Verify dispute submitter exists in organization
3. Verify assigned reviewer (if applicable) exists in organization
4. Check handler logs for authorization errors

## References

- [Domain Event Outbox Pattern](./architecture.md#domain-event-outbox)
- [Security Notifications](./security-notifications.md)
- [Disputes API](../src/disputes/disputes.controller.ts)
