import { PaymentClassification } from "@prisma/client";
import {
  ELIGIBILITY_POLICY_VERSION,
  EligibilityFactors,
  REASON_CODES,
  ReasonCode,
  evaluateEligibility,
  knownReasonCodes,
  proofUsage,
} from "./eligibility-policy";

const BASE: EligibilityFactors = {
  assetSupported: true,
  classification: PaymentClassification.INCOME,
  sourceTrusted: false,
  sourceIssuerVerified: false,
};

describe("evaluateEligibility", () => {
  it("records the policy version on every decision", () => {
    expect(evaluateEligibility(BASE).policyVersion).toBe(ELIGIBILITY_POLICY_VERSION);
  });

  it.each([
    ["ASSET_SUPPORTED", {}, true],
    ["ASSET_NOT_SUPPORTED", { assetSupported: false }, false],
  ] as const)("emits %s and decides eligibility from the asset", (code, change, eligible) => {
    const decision = evaluateEligibility({ ...BASE, ...change });
    expect(decision.reasonCodes[0]).toBe(code);
    expect(decision.eligible).toBe(eligible);
  });

  it.each([
    ["CLASSIFICATION_INCOME", PaymentClassification.INCOME],
    ["CLASSIFICATION_EXCLUDED", PaymentClassification.EXCLUDED],
    ["CLASSIFICATION_NOT_INCOME", PaymentClassification.UNKNOWN],
    ["CLASSIFICATION_NOT_INCOME", PaymentClassification.REIMBURSEMENT],
    ["CLASSIFICATION_NOT_INCOME", PaymentClassification.PERSONAL_TRANSFER],
  ] as const)("emits %s for %s without changing eligibility", (code, classification) => {
    const decision = evaluateEligibility({ ...BASE, classification });
    expect(decision.reasonCodes[1]).toBe(code);
    expect(decision.eligible).toBe(true);
  });

  it("emits SOURCE_NOT_TRUSTED for an untrusted sender", () => {
    expect(evaluateEligibility(BASE).reasonCodes).toEqual([
      "ASSET_SUPPORTED",
      "CLASSIFICATION_INCOME",
      "SOURCE_NOT_TRUSTED",
    ]);
  });

  it("emits SOURCE_TRUSTED, and SOURCE_ISSUER_VERIFIED only with an active issuer", () => {
    expect(evaluateEligibility({ ...BASE, sourceTrusted: true }).reasonCodes).toEqual([
      "ASSET_SUPPORTED",
      "CLASSIFICATION_INCOME",
      "SOURCE_TRUSTED",
    ]);
    expect(
      evaluateEligibility({ ...BASE, sourceTrusted: true, sourceIssuerVerified: true }).reasonCodes,
    ).toEqual(["ASSET_SUPPORTED", "CLASSIFICATION_INCOME", "SOURCE_TRUSTED", "SOURCE_ISSUER_VERIFIED"]);
  });

  it("ignores an issuer verification for a sender that is not trusted", () => {
    const decision = evaluateEligibility({ ...BASE, sourceIssuerVerified: true });
    expect(decision.factors.sourceIssuerVerified).toBe(false);
    expect(decision.reasonCodes).not.toContain("SOURCE_ISSUER_VERIFIED");
  });

  it("produces every reason code across the factor space", () => {
    const seen = new Set<ReasonCode>();
    for (const assetSupported of [true, false]) {
      for (const classification of Object.values(PaymentClassification)) {
        for (const sourceTrusted of [true, false]) {
          for (const sourceIssuerVerified of [true, false]) {
            evaluateEligibility({ assetSupported, classification, sourceTrusted, sourceIssuerVerified })
              .reasonCodes.forEach((code) => seen.add(code));
          }
        }
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(REASON_CODES).sort());
  });

  it("is deterministic, and its hash changes with every factor", () => {
    expect(evaluateEligibility(BASE)).toEqual(evaluateEligibility({ ...BASE }));

    const hashes = new Set(
      [
        BASE,
        { ...BASE, assetSupported: false },
        { ...BASE, classification: PaymentClassification.EXCLUDED },
        { ...BASE, sourceTrusted: true },
        { ...BASE, sourceTrusted: true, sourceIssuerVerified: true },
      ].map((factors) => evaluateEligibility(factors).inputsHash),
    );
    expect(hashes.size).toBe(5);
  });

  it("stores only derived booleans and the classification, never payment data", () => {
    const decision = evaluateEligibility(BASE);
    expect(Object.keys(decision.factors).sort()).toEqual([
      "assetSupported",
      "classification",
      "sourceIssuerVerified",
      "sourceTrusted",
    ]);
  });
});

describe("proofUsage", () => {
  it.each([
    [true, PaymentClassification.INCOME, { paymentReceipt: true, incomeProofs: true }],
    [true, PaymentClassification.UNKNOWN, { paymentReceipt: true, incomeProofs: false }],
    [true, PaymentClassification.EXCLUDED, { paymentReceipt: false, incomeProofs: false }],
    [false, PaymentClassification.INCOME, { paymentReceipt: false, incomeProofs: false }],
  ] as const)("eligible=%s, %s", (eligible, classification, usage) => {
    expect(proofUsage(eligible, classification)).toEqual(usage);
  });
});

describe("knownReasonCodes", () => {
  it("drops codes from a newer or retired policy this build does not know", () => {
    expect(knownReasonCodes(["ASSET_SUPPORTED", "FUTURE_CODE"])).toEqual(["ASSET_SUPPORTED"]);
  });
});
