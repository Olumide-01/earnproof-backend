export interface ConsistencyResourceRef {
  resourceType: string;
  resourceId: string;
  version: number;
}

export interface ConsistencyTokenPayload {
  tenantId: string;
  network?: string;
  projectionId?: string;
  resources: ConsistencyResourceRef[];
  issuedAt: number;
  expiresAt: number;
  keyId: string;
}

export type ConsistencyFailureReason =
  | "expired"
  | "tampered"
  | "unknown_key"
  | "tenant_mismatch"
  | "network_mismatch"
  | "projection_mismatch"
  | "resource_not_found"
  | "replica_lag"
  | "out_of_order";

export interface ConsistencyValidationResult {
  valid: boolean;
  consistent: boolean;
  reason?: ConsistencyFailureReason;
  requiredVersion?: number;
  observedVersion?: number;
  lag?: number;
  payload?: ConsistencyTokenPayload;
}

export interface IssueTokenOptions {
  tenantId: string;
  resources: ConsistencyResourceRef[];
  network?: string;
  projectionId?: string;
  ttlMs?: number;
}
