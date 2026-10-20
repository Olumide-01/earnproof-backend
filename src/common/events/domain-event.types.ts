import { DomainEventStatus } from "@prisma/client";

export interface DomainEvent<TPayload = Record<string, unknown>> {
  id: string;
  organizationId: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  correlationId?: string | null;
  causationId?: string | null;
  payload: TPayload;
  status: DomainEventStatus;
  leaseOwner?: string | null;
  leaseExpiresAt?: Date | null;
  attempts: number;
  maxAttempts: number;
  lastError?: string | null;
  processedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateDomainEventInput<TPayload = Record<string, unknown>> {
  organizationId: string;
  eventType: string;
  eventVersion?: number;
  aggregateType: string;
  aggregateId: string;
  correlationId?: string;
  causationId?: string;
  payload: TPayload;
  maxAttempts?: number;
}

export interface DomainEventHandler<TPayload = any> {
  consumerName: string;
  handle(event: DomainEvent<TPayload>): Promise<void>;
}

export type ProcessOutcome =
  | { outcome: "processed"; eventId: string; consumerName: string }
  | { outcome: "duplicate_skipped"; eventId: string; consumerName: string }
  | { outcome: "failed_retryable"; eventId: string; attempts: number; error: string }
  | { outcome: "quarantined"; eventId: string; attempts: number; error: string };
