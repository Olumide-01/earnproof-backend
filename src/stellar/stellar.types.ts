export type HorizonPaymentRecord = {
  id: string;
  paging_token?: string;
  type: string;
  transaction_hash: string;
  created_at: string;
  from?: string;
  to?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  amount?: string;
};

export type HorizonCollection<TRecord> = {
  _embedded?: {
    records?: TRecord[];
  };
};

export type HorizonTransactionRecord = {
  hash?: string;
  memo_type?: string;
  memo?: string | Uint8Array;
};

/** Why a memo present on-chain was not kept. */
export type MemoOmission = "unsupported" | "malformed" | "oversized";

export type NormalizedMemo =
  | { type: "none" }
  | { type: "text"; value: string; truncated: boolean }
  | { type: "id"; value: string }
  | { type: "hash"; value: string }
  | { type: "return_hash"; value: string };

export type HorizonLedgerSummary = {
  sequence: number;
  /** Lowercase hex. */
  hash: string;
};

export type HorizonOperationSummary = {
  id: string;
  pagingToken: string;
  transactionHash: string;
};

export type NormalizedPayment = {
  operationId: string;
  /** Horizon paging token (the operation's TOID). Encodes the ledger sequence. */
  pagingToken?: string;
  /**
   * Operation index within the transaction, recovered from the operation id
   * (TOID). `null` when the id is not a well-formed TOID and the index cannot be
   * derived deterministically.
   */
  operationIndex: number | null;
  stellarTransactionHash: string;
  sourceAddress: string;
  destinationAddress: string;
  assetCode: string;
  assetIssuer: string | null;
  amount: string;
  occurredAt: Date;
};
