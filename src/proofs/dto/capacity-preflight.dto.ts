import { IsEnum, IsOptional, IsString } from "class-validator";
import { ProofType } from "@prisma/client";

export class ProofCapacityPreflightDto {
  @IsEnum(ProofType)
  proofType: ProofType;

  @IsOptional()
  @IsString()
  assetCode?: string;

  @IsOptional()
  @IsString()
  organizationId?: string;
}

export interface ContractCapacityInfo {
  status: "HEALTHY" | "DEGRADED" | "PAUSED" | "UNKNOWN";
  freshnessMs: number;
  observedLedger?: string | null;
  scopes: string[];
}

export interface ProofQuotaCapacityInfo {
  source: "organization" | "default";
  window: "daily";
  usage: number;
  limit: number;
  remaining: number;
  resetsAt: string;
}

export interface ProofCapacityPreflightResponseDto {
  allowed: boolean;
  capacityRemaining: number;
  quota: ProofQuotaCapacityInfo;
  contractCapacity: ContractCapacityInfo;
  denialReasons: string[];
  advisoryOnly: true;
  evaluatedAt: string;
}
