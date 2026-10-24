import { ApiKeyRotationStatus, ApiKeyScope, ResourceStatus } from "@prisma/client";

export const DEFAULT_ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000; // 24 hours
export const MIN_ROTATION_OVERLAP_MS = 60 * 1000; // 1 minute
export const MAX_ROTATION_OVERLAP_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const ROTATION_REVOCATION_REASONS = {
  COMPROMISE: "COMPROMISE",
  NORMAL: "NORMAL",
  ROTATION_CUTOVER: "ROTATION_CUTOVER",
  ROTATION_ABORTED: "ROTATION_ABORTED",
} as const;

export type RotationRevocationReason =
  (typeof ROTATION_REVOCATION_REASONS)[keyof typeof ROTATION_REVOCATION_REASONS];

export interface ApiKeyRotationKeySummary {
  id: string;
  prefix: string;
  name: string;
  status: ResourceStatus;
  scopes: ApiKeyScope[];
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface ApiKeyRotationInspectResult {
  familyId: string;
  rotationId: string;
  status: ApiKeyRotationStatus;
  overlapExpiresAt: Date;
  isOverlapExpired: boolean;
  effectiveScopes: ApiKeyScope[];
  oldKey: ApiKeyRotationKeySummary;
  replacementKey: ApiKeyRotationKeySummary;
  oldKeyUsage: {
    totalRequests: number;
    lastUsedAt: Date | null;
  };
  cutoverAt: Date | null;
  cutoverReceipt: {
    id: string;
    receiptHash: string;
    cutoverAt: Date;
    cutoverType: string;
    oldKeyUsageCount: number;
  } | null;
}

export interface ApiKeyCutoverResult {
  rotation: {
    id: string;
    familyId: string;
    status: ApiKeyRotationStatus;
    cutoverAt: Date;
    cutoverById: string | null;
  };
  cutoverReceipt: {
    id: string;
    receiptHash: string;
    cutoverAt: Date;
    cutoverType: string;
    oldKeyUsageCount: number;
  };
  replacementKey: ApiKeyRotationKeySummary;
}

export interface CanonicalCutoverReceiptPayload {
  receiptType: "API_KEY_ROTATION_CUTOVER";
  version: "1";
  organizationId: string;
  familyId: string;
  oldKeyId: string;
  newKeyId: string;
  cutoverAt: string;
  cutoverType: string;
  initiatedById: string | null;
  oldKeyUsageCount: number;
  scopeIntersection: ApiKeyScope[];
}
