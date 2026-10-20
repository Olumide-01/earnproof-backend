-- Payment address encryption at rest (issue #175), expand phase.
--
-- Additive and backward compatible: new ciphertext and lookup-token columns,
-- and the plaintext columns become nullable so the address backfill can clear
-- them once each row's ciphertext is verified. No data is rewritten here; run
-- `npm run payments:backfill-addresses` after deploying (see
-- docs/payment-address-encryption.md). Dropping the plaintext columns is a
-- later, separate contract migration.

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "sourceAddressEncrypted" TEXT;
ALTER TABLE "Payment" ADD COLUMN "destinationAddressEncrypted" TEXT;
ALTER TABLE "Payment" ADD COLUMN "sourceAddressLookup" TEXT;
ALTER TABLE "Payment" ALTER COLUMN "sourceAddress" DROP NOT NULL;
ALTER TABLE "Payment" ALTER COLUMN "destinationAddress" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Payment_sourceAddressLookup_idx" ON "Payment"("sourceAddressLookup");
