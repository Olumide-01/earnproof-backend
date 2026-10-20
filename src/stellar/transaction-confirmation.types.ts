import { TransactionConfirmationStatus } from "@prisma/client";

export interface RecordSubmissionInput {
  organizationId: string;
  network: string;
  transactionHash: string;
  operationType: string;
  operationRef?: string;
  metadata?: Record<string, unknown>;
}

export interface TransactionConfirmationDto {
  id: string;
  organizationId: string;
  network: string;
  transactionHash: string;
  operationType: string;
  operationRef?: string | null;
  status: TransactionConfirmationStatus;
  submittedAt: Date;
  ledgerSequence?: number | null;
  ledgerHash?: string | null;
  confirmedAt?: Date | null;
  replacedByHash?: string | null;
  failureReason?: string | null;
  errorCode?: string | null;
  retryCount: number;
  explorerUrl: string;
  createdAt: Date;
  updatedAt: Date;
}
