-- Binds exactly one confirmed Stellar payment to exactly one invoice-settlement
-- proof.
--
-- Two hard uniqueness constraints do the actual concurrency-safety work:
--   - "ProofInvoiceSettlement_paymentId_key" ensures the same settled payment
--     can never be used to satisfy two different (conflicting) invoice proofs.
--   - "ProofInvoiceSettlement_issuerId_invoiceReferenceHash_key" ensures the
--     same invoice reference, under a given issuer, can never be "settled"
--     twice by two different payments.
-- Both are enforced by Postgres, so concurrent issuance attempts that race on
-- the same payment or the same invoice reference will have exactly one writer
-- succeed; the loser surfaces a clean conflict instead of corrupting state.
--
-- "invoiceReferenceHash" is a SHA-256 commitment over the normalized invoice
-- reference. The raw invoice reference is never written to this table (or any
-- other table, log line, or public claim).
CREATE TABLE "ProofInvoiceSettlement" (
  "id"                   TEXT NOT NULL,
  "proofId"              TEXT NOT NULL,
  "paymentId"            TEXT NOT NULL,
  "issuerId"             TEXT NOT NULL,
  "invoiceReferenceHash" TEXT NOT NULL,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProofInvoiceSettlement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProofInvoiceSettlement_proofId_key" ON "ProofInvoiceSettlement"("proofId");

CREATE UNIQUE INDEX "ProofInvoiceSettlement_paymentId_key" ON "ProofInvoiceSettlement"("paymentId");

CREATE UNIQUE INDEX "ProofInvoiceSettlement_issuerId_invoiceReferenceHash_key" ON "ProofInvoiceSettlement"("issuerId", "invoiceReferenceHash");

ALTER TABLE "ProofInvoiceSettlement" ADD CONSTRAINT "ProofInvoiceSettlement_proofId_fkey" FOREIGN KEY ("proofId") REFERENCES "Proof"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProofInvoiceSettlement" ADD CONSTRAINT "ProofInvoiceSettlement_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProofInvoiceSettlement" ADD CONSTRAINT "ProofInvoiceSettlement_issuerId_fkey" FOREIGN KEY ("issuerId") REFERENCES "Issuer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
