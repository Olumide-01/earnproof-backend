-- Payment eligibility decision records (issue #174). Additive only.

-- CreateTable
CREATE TABLE "PaymentEligibilityDecision" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "factors" JSONB NOT NULL,
    "reasonCodes" TEXT[],
    "inputsHash" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "isActive" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentEligibilityDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentEligibilityDecision_paymentId_evaluatedAt_idx" ON "PaymentEligibilityDecision"("paymentId", "evaluatedAt");

-- CreateIndex
CREATE INDEX "PaymentEligibilityDecision_userId_isActive_idx" ON "PaymentEligibilityDecision"("userId", "isActive");

-- CreateIndex
CREATE INDEX "PaymentEligibilityDecision_policyVersion_isActive_idx" ON "PaymentEligibilityDecision"("policyVersion", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentEligibilityDecision_paymentId_isActive_key" ON "PaymentEligibilityDecision"("paymentId", "isActive");

-- AddForeignKey
ALTER TABLE "PaymentEligibilityDecision" ADD CONSTRAINT "PaymentEligibilityDecision_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- isActive is TRUE for the single active decision and NULL once superseded.
-- FALSE would collide in the (paymentId, isActive) unique index, so it is
-- refused outright. Prisma does not model CHECK constraints, so this does
-- not affect schema drift detection.
ALTER TABLE "PaymentEligibilityDecision" ADD CONSTRAINT "PaymentEligibilityDecision_isActive_true_or_null" CHECK ("isActive" IS NULL OR "isActive" = TRUE);
