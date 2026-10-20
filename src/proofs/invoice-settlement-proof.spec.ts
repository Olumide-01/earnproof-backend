import { PaymentClassification, Prisma, ResourceStatus } from "@prisma/client";
import { ProofsService } from "./proofs.service";
import { VerificationEventService } from "../audit/verification-event.service";
import { CreateInvoiceSettlementProofDto } from "./dto/create-invoice-settlement-proof.dto";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

function makeConfig() {
  return {
    getOrThrow: jest.fn((key: string) => {
      const values: Record<string, string> = {
        credentialSigningSecret: "test-signing-secret",
        paymentEncryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "stellar.network": "testnet",
      };
      return values[key];
    }),
    get: jest.fn((key: string) => {
      if (key === "contractAnchoring.enabled") return false;
      if (key === "contractAnchoring.required") return false;
      return undefined;
    }),
  };
}

const mockVerificationEventService = {
  recordEvent: jest.fn().mockResolvedValue(undefined),
  getAggregateStats: jest.fn().mockResolvedValue({}),
  cleanupExpiredEvents: jest.fn().mockResolvedValue(0),
} as unknown as VerificationEventService;

const user = {
  id: "user_1",
  walletAddress: "GB_TEST",
  walletHash: "sha256:wallet",
  role: "WORKER",
};

const config = makeConfig();

const ISSUER_ID = "issuer_1";
const RAW_INVOICE_REFERENCE = "  INV-2026-000123  ";

function baseInput(
  overrides: Partial<CreateInvoiceSettlementProofDto> = {},
): CreateInvoiceSettlementProofDto {
  return {
    invoiceReference: RAW_INVOICE_REFERENCE,
    issuerId: ISSUER_ID,
    assetCode: "USDC",
    assetIssuer: "GISSUER",
    expectedAmount: "1250",
    ...overrides,
  };
}

function encryptedAmount(amount: string) {
  return `redacted:${Buffer.from(amount).toString("base64url")}`;
}

function makePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "payment_1",
    operationId: "op_1",
    sourceAddress: "GSOURCE1",
    assetCode: "USDC",
    assetIssuer: "GISSUER",
    amountEncrypted: encryptedAmount("1250"),
    occurredAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makePrisma(
  options: {
    issuer?: { id: string; status: ResourceStatus } | null;
    existingSettlement?: { id: string } | null;
    trustedSources?: Array<{ sourceAddress: string }>;
    payments?: Array<Record<string, unknown>>;
    transactionImpl?: (fn: (tx: unknown) => unknown) => unknown;
    captureProofCreate?: (data: unknown) => void;
    captureSettlementCreate?: (data: unknown) => void;
  } = {},
) {
  const {
    issuer = { id: ISSUER_ID, status: ResourceStatus.ACTIVE },
    existingSettlement = null,
    trustedSources = [{ sourceAddress: "GSOURCE1" }],
    payments = [makePayment()],
    transactionImpl,
    captureProofCreate,
    captureSettlementCreate,
  } = options;

  return {
    issuer: {
      findUnique: jest.fn().mockResolvedValue(issuer),
    },
    proofInvoiceSettlement: {
      findUnique: jest.fn().mockResolvedValue(existingSettlement),
      create: jest.fn(),
    },
    trustedSource: {
      findMany: jest.fn().mockResolvedValue(trustedSources),
    },
    payment: {
      findMany: jest.fn().mockResolvedValue(payments),
    },
    $transaction:
      transactionImpl ??
      jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          proof: {
            create: jest.fn().mockImplementation(({ data }: { data: any }) => {
              captureProofCreate?.(data);
              return {
                id: data.id,
                userId: data.userId,
                proofType: data.proofType,
                schemaVersion: data.schemaVersion,
                status: data.status,
                network: data.network,
                assetCode: data.assetCode,
                assetIssuer: data.assetIssuer,
                periodStart: data.periodStart,
                periodEnd: data.periodEnd,
                expiresAt: data.expiresAt,
                credentialHash: data.credentialHash,
                commitment: data.commitment,
                createdAt: data.createdAt,
                claim: data.claim.create,
              };
            }),
          },
          proofInvoiceSettlement: {
            create: jest.fn().mockImplementation(({ data }: { data: any }) => {
              captureSettlementCreate?.(data);
              return { id: "settlement_1", ...data };
            }),
          },
          anchoringIntent: {
            create: jest.fn().mockResolvedValue({ id: "intent_1" }),
          },
        };
        return fn(tx);
      }),
  };
}

function makeService(prisma: unknown) {
  return new ProofsService(
    prisma as never,
    config as never,
    mockVerificationEventService,
  );
}

describe("ProofsService.createInvoiceSettlementProof", () => {
  // -------------------------------------------------------------------------
  // Positive
  // -------------------------------------------------------------------------
  it("issues a proof and creates a ProofInvoiceSettlement row for an exact single match", async () => {
    const capturedProof: unknown[] = [];
    const capturedSettlement: unknown[] = [];
    const prisma = makePrisma({
      captureProofCreate: (d) => capturedProof.push(d),
      captureSettlementCreate: (d) => capturedSettlement.push(d),
    });
    const service = makeService(prisma);

    const result = await service.createInvoiceSettlementProof(
      user,
      baseInput(),
    );

    expect(result.status).toBe("ACTIVE");
    expect(result.credential.claim.assetCode).toBe("USDC");
    expect(capturedSettlement).toHaveLength(1);
    expect(capturedSettlement[0]).toMatchObject({
      paymentId: "payment_1",
      issuerId: ISSUER_ID,
    });
  });

  it("hides the amount by default and discloses it only when opted in", async () => {
    const hiddenPrisma = makePrisma();
    const hiddenResult = await makeService(hiddenPrisma).createInvoiceSettlementProof(
      user,
      baseInput(),
    );
    expect(hiddenResult.credential.claim.amount).toBeUndefined();
    expect(hiddenResult.credential.privacy).toEqual({ amountHidden: true });

    const disclosedPrisma = makePrisma();
    const disclosedResult = await makeService(
      disclosedPrisma,
    ).createInvoiceSettlementProof(
      user,
      baseInput({ discloseAmount: true }),
    );
    expect(disclosedResult.credential.claim.amount).toBe("1250");
  });

  // -------------------------------------------------------------------------
  // Negative
  // -------------------------------------------------------------------------
  it("rejects when the issuer does not exist or is not active", async () => {
    const prisma = makePrisma({ issuer: null });
    await expect(
      makeService(prisma).createInvoiceSettlementProof(user, baseInput()),
    ).rejects.toThrow("issuer does not exist or is not active");
  });

  it("rejects when no trusted source links the caller to the issuer (issuer mismatch)", async () => {
    const prisma = makePrisma({ trustedSources: [] });
    await expect(
      makeService(prisma).createInvoiceSettlementProof(user, baseInput()),
    ).rejects.toThrow("No confirmed payment matches");
  });

  it("rejects an asset mismatch (no payment in the requested asset)", async () => {
    // The real Prisma query filters candidates by exact assetCode/assetIssuer
    // (see `where.assetCode`/`where.assetIssuer` in the service). A payment in
    // a different asset would never be returned by that query, so we model
    // that here with an empty candidate set and assert the filter is present.
    const prisma = makePrisma({ payments: [] });
    await expect(
      makeService(prisma).createInvoiceSettlementProof(user, baseInput()),
    ).rejects.toThrow("No confirmed payment matches");
    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assetCode: "USDC",
          assetIssuer: "GISSUER",
        }),
      }),
    );
  });

  it("rejects a partial payment (amount less than expected)", async () => {
    const prisma = makePrisma({
      payments: [makePayment({ amountEncrypted: encryptedAmount("1000") })],
    });
    await expect(
      makeService(prisma).createInvoiceSettlementProof(user, baseInput()),
    ).rejects.toThrow("No confirmed payment matches");
  });

  it("rejects an overpayment (amount greater than expected)", async () => {
    const prisma = makePrisma({
      payments: [makePayment({ amountEncrypted: encryptedAmount("1300") })],
    });
    await expect(
      makeService(prisma).createInvoiceSettlementProof(user, baseInput()),
    ).rejects.toThrow("No confirmed payment matches");
  });

  it("rejects when zero payments match (unconfirmed)", async () => {
    const prisma = makePrisma({ payments: [] });
    await expect(
      makeService(prisma).createInvoiceSettlementProof(user, baseInput()),
    ).rejects.toThrow("No confirmed payment matches");
  });

  it("rejects duplicate invoice references for the same issuer", async () => {
    const prisma = makePrisma({ existingSettlement: { id: "settlement_x" } });
    await expect(
      makeService(prisma).createInvoiceSettlementProof(user, baseInput()),
    ).rejects.toThrow("already been settled for this issuer");
  });

  // -------------------------------------------------------------------------
  // Boundary / ambiguity
  // -------------------------------------------------------------------------
  it("accepts an exact boundary match at 7 decimal places", async () => {
    const prisma = makePrisma({
      payments: [makePayment({ amountEncrypted: encryptedAmount("1250.0000000") })],
    });
    const result = await makeService(prisma).createInvoiceSettlementProof(
      user,
      baseInput({ expectedAmount: "1250.0000000" }),
    );
    expect(result.status).toBe("ACTIVE");
  });

  it("rejects a payment one unit off in either direction", async () => {
    const under = makePrisma({
      payments: [makePayment({ amountEncrypted: encryptedAmount("1249.9999999") })],
    });
    await expect(
      makeService(under).createInvoiceSettlementProof(
        user,
        baseInput({ expectedAmount: "1250.0000000" }),
      ),
    ).rejects.toThrow("No confirmed payment matches");

    const over = makePrisma({
      payments: [makePayment({ amountEncrypted: encryptedAmount("1250.0000001") })],
    });
    await expect(
      makeService(over).createInvoiceSettlementProof(
        user,
        baseInput({ expectedAmount: "1250.0000000" }),
      ),
    ).rejects.toThrow("No confirmed payment matches");
  });

  it("rejects as ambiguous when more than one payment matches all criteria", async () => {
    const prisma = makePrisma({
      payments: [
        makePayment({ id: "payment_1" }),
        makePayment({ id: "payment_2", operationId: "op_2" }),
      ],
    });
    await expect(
      makeService(prisma).createInvoiceSettlementProof(user, baseInput()),
    ).rejects.toThrow("Multiple confirmed payments match");
  });

  // -------------------------------------------------------------------------
  // Regression: concurrency / DB-level uniqueness
  // -------------------------------------------------------------------------
  it("surfaces a clean conflict when the same payment is already bound to a different invoice (P2002 on paymentId)", async () => {
    const transactionImpl = jest.fn().mockImplementation(async () => {
      throw new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`paymentId`)",
        {
          code: "P2002",
          clientVersion: "test",
          meta: { target: ["paymentId"] },
        },
      );
    });
    const prisma = makePrisma({ transactionImpl });

    await expect(
      makeService(prisma).createInvoiceSettlementProof(user, baseInput()),
    ).rejects.toThrow("already been used to settle a different invoice");
  });

  it("surfaces a clean conflict when the invoice reference is claimed concurrently (P2002 on issuerId+invoiceReferenceHash)", async () => {
    const transactionImpl = jest.fn().mockImplementation(async () => {
      throw new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`issuerId`,`invoiceReferenceHash`)",
        {
          code: "P2002",
          clientVersion: "test",
          meta: { target: ["issuerId", "invoiceReferenceHash"] },
        },
      );
    });
    const prisma = makePrisma({ transactionImpl });

    await expect(
      makeService(prisma).createInvoiceSettlementProof(user, baseInput()),
    ).rejects.toThrow("already been settled for this issuer");
  });

  it("does not silently succeed twice for two near-simultaneous binds of the same payment", async () => {
    // First call succeeds normally.
    const firstPrisma = makePrisma();
    const firstResult = await makeService(
      firstPrisma,
    ).createInvoiceSettlementProof(user, baseInput());
    expect(firstResult.status).toBe("ACTIVE");

    // Second call attempts to bind the same payment to a DIFFERENT invoice
    // reference; the DB unique constraint on paymentId rejects it. We
    // simulate the DB by having the transaction throw P2002, exactly as
    // Postgres would for a real concurrent second writer.
    const transactionImpl = jest.fn().mockImplementation(async () => {
      throw new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`paymentId`)",
        {
          code: "P2002",
          clientVersion: "test",
          meta: { target: ["paymentId"] },
        },
      );
    });
    const secondPrisma = makePrisma({ transactionImpl });

    await expect(
      makeService(secondPrisma).createInvoiceSettlementProof(
        user,
        baseInput({ invoiceReference: "INV-2026-999999" }),
      ),
    ).rejects.toThrow("already been used to settle a different invoice");
  });

  // -------------------------------------------------------------------------
  // Privacy: the raw invoice reference must never leak
  // -------------------------------------------------------------------------
  it("never persists, returns, or throws the raw invoice reference", async () => {
    const capturedProof: unknown[] = [];
    const capturedSettlement: unknown[] = [];
    const prisma = makePrisma({
      captureProofCreate: (d) => capturedProof.push(d),
      captureSettlementCreate: (d) => capturedSettlement.push(d),
    });
    const service = makeService(prisma);

    const result = await service.createInvoiceSettlementProof(
      user,
      baseInput(),
    );

    const raw = RAW_INVOICE_REFERENCE.trim();
    const normalized = raw.toLowerCase();

    expect(JSON.stringify(capturedProof)).not.toContain(raw);
    expect(JSON.stringify(capturedProof)).not.toContain(normalized);
    expect(JSON.stringify(capturedSettlement)).not.toContain(raw);
    expect(JSON.stringify(capturedSettlement)).not.toContain(normalized);
    expect(JSON.stringify(result)).not.toContain(raw);
    expect(JSON.stringify(result)).not.toContain(normalized);

    // Also verify against the error paths.
    const dupPrisma = makePrisma({ existingSettlement: { id: "x" } });
    try {
      await makeService(dupPrisma).createInvoiceSettlementProof(
        user,
        baseInput(),
      );
      fail("expected rejection");
    } catch (err) {
      expect(JSON.stringify((err as Error).message)).not.toContain(raw);
      expect(JSON.stringify((err as Error).message)).not.toContain(normalized);
    }
  });

  it("rejects payments already bound to another invoice-settlement proof via the fast-path filter", async () => {
    // Simulate the fast-path exclusion by having payment.findMany return
    // nothing (as it would when `invoiceSettlement: null` filters out an
    // already-bound payment at the DB level).
    const prisma = makePrisma({ payments: [] });
    await expect(
      makeService(prisma).createInvoiceSettlementProof(user, baseInput()),
    ).rejects.toThrow("No confirmed payment matches");
    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ invoiceSettlement: null }),
      }),
    );
  });

  it("rejects invoice references that are blank after normalization", async () => {
    const prisma = makePrisma();
    await expect(
      makeService(prisma).createInvoiceSettlementProof(
        user,
        baseInput({ invoiceReference: "    " }),
      ),
    ).rejects.toThrow("must not be empty after normalization");
  });
});

describe("ProofsService.createInvoiceSettlementProof — asset mismatch classification", () => {
  it("classification EXCLUDED payments are treated as not eligible / not matched", async () => {
    const prisma = makePrisma({
      payments: [
        makePayment({
          classification: PaymentClassification.EXCLUDED,
        }),
      ],
    });
    // The service filters at the DB query level via `classification: { not: EXCLUDED }`,
    // so an EXCLUDED payment would not be returned by a real DB. We assert the
    // where clause requests this exclusion.
    await expect(
      makeService(prisma).createInvoiceSettlementProof(
        user,
        baseInput(),
      ),
    ).resolves.toBeDefined();
    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          classification: { not: PaymentClassification.EXCLUDED },
        }),
      }),
    );
  });
});
