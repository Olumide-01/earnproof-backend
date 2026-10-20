import {
  AddressDecryptionError,
  AddressField,
  AddressKeys,
  decryptAddress,
  encryptAddress,
  lookupToken,
  lookupTokens,
  protectionVersion,
} from "./protected-address";

/** What a payment row holds for one address during the migration window. */
export interface StoredAddress {
  encrypted: string | null;
  /** Legacy plaintext; null once migrated. */
  plaintext: string | null;
}

/** The columns a write sets for a payment's addresses. */
export interface ProtectedAddressColumns {
  sourceAddressEncrypted: string;
  destinationAddressEncrypted: string;
  sourceAddressLookup: string;
  sourceAddress: null;
  destinationAddress: null;
}

/**
 * Payment-address protection bound to the active key version.
 *
 * Obtained from {@link PaymentEncryptionKeyringService.addressCipher}, so it
 * shares the payment-encryption keyring and rotates with it.
 */
export class PaymentAddressCipher {
  constructor(
    private readonly keys: AddressKeys,
    readonly writeVersion: number,
  ) {}

  /** Columns for a new or rewritten payment: ciphertext and token, no plaintext. */
  protect(sourceAddress: string, destinationAddress: string): ProtectedAddressColumns {
    return {
      sourceAddressEncrypted: encryptAddress(sourceAddress, "source", this.keys, this.writeVersion),
      destinationAddressEncrypted: encryptAddress(
        destinationAddress,
        "destination",
        this.keys,
        this.writeVersion,
      ),
      sourceAddressLookup: lookupToken(sourceAddress, this.keys, this.writeVersion),
      sourceAddress: null,
      destinationAddress: null,
    };
  }

  /** Tokens to match `sourceAddressLookup` against, one per loaded key version. */
  sourceLookupTokens(sourceAddress: string): string[] {
    return lookupTokens(sourceAddress, this.keys);
  }

  /**
   * The address, preferring ciphertext and falling back to legacy plaintext.
   * Throws {@link AddressDecryptionError} when neither yields a value.
   */
  reveal(stored: StoredAddress, field: AddressField): string {
    if (stored.encrypted) return decryptAddress(stored.encrypted, field, this.keys);
    if (stored.plaintext) return stored.plaintext;
    throw new AddressDecryptionError("malformed");
  }

  /** Like {@link reveal}, but `null` instead of throwing, for display paths. */
  tryReveal(stored: StoredAddress, field: AddressField): string | null {
    try {
      return this.reveal(stored, field);
    } catch {
      return null;
    }
  }

  /** True when a value was protected under a key version other than the active one. */
  isStale(value: string | null): boolean {
    return protectionVersion(value) !== this.writeVersion;
  }
}
