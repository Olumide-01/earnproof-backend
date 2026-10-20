import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../database/prisma.service";
import { WebhookClientCertificateService } from "./webhook-client-certificate.service";

const ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

function makeConfig() {
  return { getOrThrow: jest.fn().mockReturnValue(ENCRYPTION_KEY) };
}

// Synthetic, throwaway self-signed certificate generated purely as a test
// fixture (`openssl req -x509 -newkey rsa:2048 -nodes -days 3650`).
// No corresponding private key is committed; it is not used for any live
// connection and grants access to nothing.
const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDIzCCAgugAwIBAgIURrKLJPqbxDJ0B919TZm/gxriTxMwDQYJKoZIhvcNAQEL
BQAwITEfMB0GA1UEAwwWZWFybnByb29mLXRlc3QtZml4dHVyZTAeFw0yNjEwMTYw
NTUzNDhaFw0zNjEwMTMwNTUzNDhaMCExHzAdBgNVBAMMFmVhcm5wcm9vZi10ZXN0
LWZpeHR1cmUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC3+aEY/qox
o9E4VCKqHC7GsTQyXYhIof4chVvfrFpqGoBKcuCcvT/QEWnyhXIQDP1/CD6XZaM1
k+nmL5LPd4viQ+WHALb7rM2neIahDSFC9ubbeWmSHCaMOmeSRrleVyAwU62s3ZJs
Lan6jKPMWsCNJzgwqp8tX4dLeNYILJ/p+L5iqiCZdIPAaIluEtXzWmXQm+J3WAtH
16nL9YEMhK38zvyDxuLtzCISGSUhw1a5j77bNgxFe9PirpGCu0STaBbtBHqByiSI
ctXcdvf1YmQrCky1OQqukVU0GtsQbIOXtTLm2gnJgXHYHE7Iz6/YcUaYbNDgoLcR
4c4vJIjYV/ivAgMBAAGjUzBRMB0GA1UdDgQWBBRf7AlCKt37BGnMJQdr7WVRqYhw
XzAfBgNVHSMEGDAWgBRf7AlCKt37BGnMJQdr7WVRqYhwXzAPBgNVHRMBAf8EBTAD
AQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAcbIW18pVHXkeqH0zy7mkacF3+w3XNTlAV
2xUq/EKdDHpeLyaDezOTMfgkOt60UFPkaOQYwDoCmN1xrDqcTY0YMQzUT8X0NkqD
oLKhWaAsXGj+XydsKMXCKpJZZ/I2ey2e4s1ifyqk2pARfNESt40pPRoTCtqYr6vH
tG07WGdAmYZHlQTP2+oXzVLHWofmCrt3pU71S2KNP+Mpy9RWyFoKFy7mjibmobw3
t9/1thERYTUDSNZdOzMJgO5Qdy11qrTPyNXHi/raxfLSoA1M+7b2x9cbQJUJowJw
H5B1hh8pWN+99eX2DkcrmINujMVZqlG9PZpPzSfUW9FbCUPdzmFu
-----END CERTIFICATE-----`;

// Comfortably inside TEST_CERT_PEM's own validity window
// (Oct 16 05:53:48 2026 GMT – Oct 13 05:53:48 2036 GMT), well past test-run time.
const VALID_WINDOW = {
  notBefore: new Date("2026-10-16T12:00:00Z").toISOString(),
  notAfter: new Date("2036-10-13T00:00:00Z").toISOString(),
};

describe("WebhookClientCertificateService", () => {
  let service: WebhookClientCertificateService;
  let prisma: {
    webhook: { findUnique: jest.Mock };
    webhookClientCertificate: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookClientCertificateService,
        {
          provide: PrismaService,
          useValue: {
            webhook: { findUnique: jest.fn() },
            webhookClientCertificate: {
              create: jest.fn(),
              findUnique: jest.fn(),
              findFirst: jest.fn(),
              update: jest.fn(),
              updateMany: jest.fn(),
            },
            $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
          },
        },
        { provide: ConfigService, useValue: makeConfig() },
      ],
    }).compile();

    service = module.get(WebhookClientCertificateService);
    prisma = module.get(PrismaService) as unknown as typeof prisma;
  });

  describe("add — validation", () => {
    it("rejects a malformed certificate", async () => {
      prisma.webhook.findUnique.mockResolvedValue({ organizationId: "org-1" });

      await expect(
        service.add("org-1", "hook-1", {
          certificatePem: "not a certificate",
          privateKeyPem: "irrelevant",
          ...VALID_WINDOW,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects notBefore >= notAfter even for an otherwise-valid certificate", async () => {
      prisma.webhook.findUnique.mockResolvedValue({ organizationId: "org-1" });

      await expect(
        service.add("org-1", "hook-1", {
          certificatePem: TEST_CERT_PEM,
          privateKeyPem: "irrelevant",
          notBefore: new Date("2030-01-01T00:00:00Z").toISOString(),
          notAfter: new Date("2029-01-01T00:00:00Z").toISOString(),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects a webhook that does not belong to the organisation", async () => {
      prisma.webhook.findUnique.mockResolvedValue({ organizationId: "other-org" });

      await expect(
        service.add("org-1", "hook-1", {
          certificatePem: TEST_CERT_PEM,
          privateKeyPem: "irrelevant",
          ...VALID_WINDOW,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws NotFoundException for an unknown webhook", async () => {
      prisma.webhook.findUnique.mockResolvedValue(null);

      await expect(
        service.add("org-1", "missing", {
          certificatePem: TEST_CERT_PEM,
          privateKeyPem: "irrelevant",
          ...VALID_WINDOW,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("rejects a certificate whose validity window has already ended", async () => {
      prisma.webhook.findUnique.mockResolvedValue({ organizationId: "org-1" });

      await expect(
        service.add("org-1", "hook-1", {
          certificatePem: TEST_CERT_PEM,
          privateKeyPem: "irrelevant",
          notBefore: new Date("2020-01-01T00:00:00Z").toISOString(),
          notAfter: new Date("2020-06-01T00:00:00Z").toISOString(),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("never stores the private key in plaintext, and registers as PENDING", async () => {
      prisma.webhook.findUnique.mockResolvedValue({ organizationId: "org-1" });
      prisma.webhookClientCertificate.create.mockImplementation((args) =>
        Promise.resolve({ id: "cert-1", ...args.data }),
      );

      const rawKey = "-----BEGIN PRIVATE KEY-----\nSENTINEL-secret-material\n-----END PRIVATE KEY-----";
      const result = await service.add("org-1", "hook-1", {
        certificatePem: TEST_CERT_PEM,
        privateKeyPem: rawKey,
        ...VALID_WINDOW,
      });

      expect(JSON.stringify(result)).not.toContain("SENTINEL-secret-material");
      expect((result as { status: string }).status).toBe("PENDING");
      const stored = prisma.webhookClientCertificate.create.mock.calls[0][0].data
        .privateKeyEncrypted as string;
      expect(stored).not.toContain("SENTINEL-secret-material");
    });
  });

  describe("activate", () => {
    it("rejects activating a certificate that is not PENDING/ROTATING", async () => {
      prisma.webhook.findUnique.mockResolvedValue({ organizationId: "org-1" });
      prisma.webhookClientCertificate.findUnique.mockResolvedValue({
        id: "cert-1",
        webhookId: "hook-1",
        status: "ACTIVE",
        notAfter: new Date(Date.now() + 86_400_000),
      });

      await expect(service.activate("org-1", "hook-1", "cert-1")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("rejects activating an expired certificate", async () => {
      prisma.webhook.findUnique.mockResolvedValue({ organizationId: "org-1" });
      prisma.webhookClientCertificate.findUnique.mockResolvedValue({
        id: "cert-1",
        webhookId: "hook-1",
        status: "PENDING",
        notAfter: new Date(Date.now() - 1000),
      });

      await expect(service.activate("org-1", "hook-1", "cert-1")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("demotes the previously ACTIVE certificate to ROTATING on rotation", async () => {
      prisma.webhook.findUnique.mockResolvedValue({ organizationId: "org-1" });
      prisma.webhookClientCertificate.findUnique.mockResolvedValue({
        id: "cert-2",
        webhookId: "hook-1",
        status: "PENDING",
        notAfter: new Date(Date.now() + 86_400_000),
      });
      prisma.webhookClientCertificate.updateMany.mockResolvedValue({ count: 1 });
      prisma.webhookClientCertificate.update.mockResolvedValue({
        id: "cert-2",
        status: "ACTIVE",
        privateKeyEncrypted: "enc:...",
      });

      await service.activate("org-1", "hook-1", "cert-2");

      expect(prisma.webhookClientCertificate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { webhookId: "hook-1", status: "ACTIVE" },
          data: { status: "ROTATING" },
        }),
      );
    });
  });

  describe("selectActiveCertificate", () => {
    it("returns null when there is no ACTIVE, unexpired certificate", async () => {
      prisma.webhookClientCertificate.findFirst.mockResolvedValue(null);

      await expect(service.selectActiveCertificate("hook-1")).resolves.toBeNull();
    });

    it("decrypts the key pair for a currently ACTIVE certificate", async () => {
      prisma.webhookClientCertificate.create.mockImplementation((args) =>
        Promise.resolve({ id: "cert-1", ...args.data }),
      );
      prisma.webhook.findUnique.mockResolvedValue({ organizationId: "org-1" });

      const created = await service.add("org-1", "hook-1", {
        certificatePem: TEST_CERT_PEM,
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\nMY-KEY-MATERIAL\n-----END PRIVATE KEY-----",
        ...VALID_WINDOW,
      });

      prisma.webhookClientCertificate.findFirst.mockResolvedValue({
        ...created,
        privateKeyEncrypted: prisma.webhookClientCertificate.create.mock.calls[0][0].data
          .privateKeyEncrypted,
      });

      const selected = await service.selectActiveCertificate("hook-1");
      expect(selected?.certificatePem).toBe(TEST_CERT_PEM);
      expect(selected?.privateKeyPem).toContain("MY-KEY-MATERIAL");
    });
  });

  describe("expireStale", () => {
    it("reports how many certificates it expired", async () => {
      prisma.webhookClientCertificate.updateMany.mockResolvedValue({ count: 2 });
      await expect(service.expireStale()).resolves.toBe(2);
    });
  });
});
