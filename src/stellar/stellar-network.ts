/**
 * Stellar network identities.
 *
 * A network is identified by its passphrase, not its name: the passphrase is
 * mixed into every transaction hash, so a contract address is only meaningful
 * together with the passphrase of the network it was deployed to. Keeping the
 * name → passphrase mapping in one place is what lets the deployment manifest
 * refuse a document that pairs a testnet name with a mainnet passphrase.
 */
export const STELLAR_NETWORK_PASSPHRASES = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
} as const;

export type StellarNetworkName = keyof typeof STELLAR_NETWORK_PASSPHRASES;

export const STELLAR_NETWORK_NAMES = Object.keys(
  STELLAR_NETWORK_PASSPHRASES,
) as [StellarNetworkName, ...StellarNetworkName[]];

/** Soroban contract address (strkey, "C" version byte). */
export const STELLAR_CONTRACT_ADDRESS_PATTERN = /^C[A-Z2-7]{55}$/;

/**
 * Stellar secret seed (strkey, "S" version byte).
 *
 * Used only to refuse values that look like signing keys wherever operator
 * input is echoed publicly — a seed pasted into the wrong field must never be
 * served.
 */
export const STELLAR_SECRET_SEED_PATTERN = /S[A-Z2-7]{55}/;

/** True when `passphrase` is the canonical passphrase for `network`. */
export function passphraseMatchesNetwork(
  network: StellarNetworkName,
  passphrase: string,
): boolean {
  return STELLAR_NETWORK_PASSPHRASES[network] === passphrase;
}
