import { PrismaClient } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { PaymentEncryptionKeyringService } from "../../src/common/crypto/payment-encryption-keyring.service";
import { configuration } from "../../src/config/configuration";
import { PaymentAddressBackfill } from "../../src/payments/payment-address-backfill";

/**
 * Encrypts payment addresses at rest, or re-protects them after a key
 * rotation, in bounded resumable batches.
 *
 *   npm run payments:backfill-addresses -- [--batch-size=200] [--max-batches=50] [--after=<paymentId>] [--verify-only]
 *
 * Output is JSON counts only: no address, ciphertext, token or key is ever
 * printed. Exit code 0 means verification found nothing left to do; 2 means
 * work remains (re-run, resuming from the printed cursor); 1 means an error.
 */

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<number> {
  const config = configuration();
  const configService = new ConfigService(config);
  const keyring = new PaymentEncryptionKeyringService(configService);
  if (!keyring.loadedVersions.includes(keyring.writeVersion)) {
    console.error(JSON.stringify({ error: "active payment encryption key version is not configured" }));
    return 1;
  }

  const prisma = new PrismaClient();
  try {
    const backfill = new PaymentAddressBackfill(prisma, keyring.addressCipher());

    const run = process.argv.includes("--verify-only")
      ? undefined
      : await backfill.run({
          batchSize: positiveInt(flag("batch-size"), 200),
          maxBatches: positiveInt(flag("max-batches"), 50),
          afterId: flag("after"),
        });
    const verification = await backfill.verify();

    console.log(
      JSON.stringify({ keyVersion: keyring.writeVersion, run, verification }, null, 2),
    );

    const complete =
      verification.plaintextRemaining === 0 &&
      verification.missingCiphertext === 0 &&
      verification.staleKeyVersion === 0;
    return complete ? 0 : 2;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    // The error name only: messages from the driver can quote row values.
    console.error(JSON.stringify({ error: error instanceof Error ? error.name : "UnknownError" }));
    process.exit(1);
  });
