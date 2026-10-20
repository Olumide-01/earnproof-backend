import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PaymentAddressCipher } from "./payment-address-cipher";
import { deriveAddressKeys } from "./protected-address";
import {
  ProtectedAmountKeyring,
  decryptProtectedAmount,
  encryptProtectedAmount,
} from "./protected-amount";

const MAX_KEY_VERSIONS = 100;

/**
 * Loads and exposes the payment-encryption keyring for staged key rotation.
 *
 * Mirrors the versioned-salt pattern used by VerificationEventService:
 *
 * - `PAYMENT_ENCRYPTION_KEY_V0`, `PAYMENT_ENCRYPTION_KEY_V1`, ... are loaded
 *   sequentially until the first gap.
 * - For backward compatibility, the legacy single-key env var
 *   `PAYMENT_ENCRYPTION_KEY` is treated as an implicit version 0 when
 *   `PAYMENT_ENCRYPTION_KEY_V0` is not set.
 * - `PAYMENT_ENCRYPTION_KEY_VERSION` selects which version new writes use
 *   (the "active" key). Older versions remain loaded for read (dual-read)
 *   as long as they are still configured — removing a version's env var
 *   retires it and any data still encrypted under it becomes undecryptable
 *   (an UnknownKeyVersionError), which is the intended "retired" boundary.
 *
 * Never logs key material: only versions/counts are logged.
 */
@Injectable()
export class PaymentEncryptionKeyringService {
  private readonly logger = new Logger(PaymentEncryptionKeyringService.name);
  private readonly keyring: ProtectedAmountKeyring;
  private readonly activeWriteVersion: number;

  constructor(configService: ConfigService) {
    // Tolerate lightweight test doubles that only implement getOrThrow():
    // fall back to it (via a swallowed throw) when get() is unavailable so
    // legacy call sites' existing mocks keep working unmodified.
    const safeGet = <T>(key: string): T | undefined => {
      if (typeof configService.get === "function") {
        return configService.get<T>(key);
      }
      try {
        return configService.getOrThrow<T>(key);
      } catch {
        return undefined;
      }
    };

    const keys = new Map<number, string>();

    const legacyKey = safeGet<string>("paymentEncryptionKey");
    const v0FromVersioned = safeGet<string>("paymentEncryptionKeyVersions.0");
    if (v0FromVersioned) {
      keys.set(0, v0FromVersioned);
    } else if (legacyKey) {
      // Backward compatibility: unversioned PAYMENT_ENCRYPTION_KEY is
      // implicit version 0.
      keys.set(0, legacyKey);
    }

    for (let i = 1; i < MAX_KEY_VERSIONS; i++) {
      const key = safeGet<string>(`paymentEncryptionKeyVersions.${i}`);
      if (key) {
        keys.set(i, key);
      } else {
        break;
      }
    }

    this.keyring = keys;

    const configuredVersion = safeGet<number>("paymentEncryptionKeyVersion");
    this.activeWriteVersion =
      typeof configuredVersion === "number" && Number.isFinite(configuredVersion)
        ? configuredVersion
        : 0;

    if (this.keyring.size === 0) {
      this.logger.error(
        "No payment encryption keys configured (PAYMENT_ENCRYPTION_KEY / PAYMENT_ENCRYPTION_KEY_V*).",
      );
    }

    if (!this.keyring.has(this.activeWriteVersion)) {
      this.logger.error(
        `Configured active payment encryption key version ${this.activeWriteVersion} is not loaded. ` +
          `Loaded versions: [${[...this.keyring.keys()].sort((a, b) => a - b).join(", ")}]. ` +
          `Adjust PAYMENT_ENCRYPTION_KEY_VERSION or configure PAYMENT_ENCRYPTION_KEY_V${this.activeWriteVersion}.`,
      );
    }
  }

  /** The key version new ciphertext is written with. */
  get writeVersion(): number {
    return this.activeWriteVersion;
  }

  /** Versions currently loaded and available for decrypt (dual-read set). */
  get loadedVersions(): readonly number[] {
    return [...this.keyring.keys()].sort((a, b) => a - b);
  }

  encrypt(plaintext: string): string {
    return encryptProtectedAmount(
      plaintext,
      this.keyring,
      this.activeWriteVersion,
    );
  }

  decrypt(value: string): string {
    return decryptProtectedAmount(value, this.keyring);
  }

  private cachedAddressCipher?: PaymentAddressCipher;

  /**
   * Payment-address protection on the same keyring and active version.
   * Address keys are derived per purpose, never the amount key itself.
   */
  addressCipher(): PaymentAddressCipher {
    this.cachedAddressCipher ??= new PaymentAddressCipher(
      deriveAddressKeys(this.keyring),
      this.activeWriteVersion,
    );
    return this.cachedAddressCipher;
  }
}
