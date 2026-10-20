import {
  passphraseMatchesNetwork,
  STELLAR_CONTRACT_ADDRESS_PATTERN,
  STELLAR_NETWORK_NAMES,
  STELLAR_SECRET_SEED_PATTERN,
} from "./stellar-network";

describe("stellar network identities", () => {
  it("pairs each network only with its own passphrase", () => {
    for (const network of STELLAR_NETWORK_NAMES) {
      for (const other of STELLAR_NETWORK_NAMES) {
        const passphrase = {
          testnet: "Test SDF Network ; September 2015",
          mainnet: "Public Global Stellar Network ; September 2015",
          futurenet: "Test SDF Future Network ; October 2022",
        }[other];
        expect(passphraseMatchesNetwork(network, passphrase)).toBe(
          network === other,
        );
      }
    }
  });

  it("recognises contract addresses but not account keys", () => {
    expect(STELLAR_CONTRACT_ADDRESS_PATTERN.test(`C${"A".repeat(55)}`)).toBe(
      true,
    );
    expect(STELLAR_CONTRACT_ADDRESS_PATTERN.test(`G${"A".repeat(55)}`)).toBe(
      false,
    );
    expect(STELLAR_CONTRACT_ADDRESS_PATTERN.test(`C${"A".repeat(54)}`)).toBe(
      false,
    );
  });

  it("finds a secret seed embedded in surrounding text", () => {
    expect(STELLAR_SECRET_SEED_PATTERN.test(`key=S${"B".repeat(55)};`)).toBe(
      true,
    );
    expect(STELLAR_SECRET_SEED_PATTERN.test(`S${"B".repeat(54)}`)).toBe(false);
  });
});
