import {
  assetKind,
  canonicalAssetId,
  isSameCanonicalAsset,
  normalizeIssuer,
} from "./asset-identifier";

describe("asset-identifier", () => {
  describe("canonicalAssetId", () => {
    it("builds a native canonical id when there is no issuer", () => {
      expect(
        canonicalAssetId({ network: "testnet", code: "XLM", issuer: null }),
      ).toBe("testnet:native:XLM");
    });

    it("builds an issued canonical id when an issuer is present", () => {
      expect(
        canonicalAssetId({
          network: "testnet",
          code: "USDC",
          issuer: "GISSUER1",
        }),
      ).toBe("testnet:issued:USDC:GISSUER1");
    });

    it("folds the network to lower-case but preserves asset code case", () => {
      expect(
        canonicalAssetId({ network: "PUBLIC", code: "usdc", issuer: null }),
      ).toBe("public:native:usdc");
    });

    it("treats undefined issuer the same as null issuer", () => {
      expect(canonicalAssetId({ network: "testnet", code: "XLM" })).toBe(
        canonicalAssetId({ network: "testnet", code: "XLM", issuer: null }),
      );
    });

    it("treats an empty-string issuer as no issuer", () => {
      expect(
        canonicalAssetId({ network: "testnet", code: "XLM", issuer: "" }),
      ).toBe("testnet:native:XLM");
    });

    it("treats a whitespace-only issuer as no issuer", () => {
      expect(
        canonicalAssetId({ network: "testnet", code: "XLM", issuer: "   " }),
      ).toBe("testnet:native:XLM");
    });

    it("never collides an issued asset whose code is literally 'native' with the true native asset", () => {
      const trueNative = canonicalAssetId({
        network: "testnet",
        code: "XLM",
        issuer: null,
      });
      const issuedCalledNative = canonicalAssetId({
        network: "testnet",
        code: "native",
        issuer: "GISSUER1",
      });

      expect(trueNative).not.toBe(issuedCalledNative);
    });

    it("does not collide a native asset with an issued asset that has the same code", () => {
      const native = canonicalAssetId({
        network: "testnet",
        code: "USDC",
        issuer: null,
      });
      const issued = canonicalAssetId({
        network: "testnet",
        code: "USDC",
        issuer: "GISSUER1",
      });

      expect(native).not.toBe(issued);
    });

    it("scopes identical code/issuer pairs to distinct ids per network", () => {
      const testnetAsset = canonicalAssetId({
        network: "testnet",
        code: "XLM",
        issuer: null,
      });
      const publicAsset = canonicalAssetId({
        network: "public",
        code: "XLM",
        issuer: null,
      });

      expect(testnetAsset).not.toBe(publicAsset);
    });

    it("is case-sensitive for asset codes, matching Stellar protocol semantics", () => {
      const upper = canonicalAssetId({
        network: "testnet",
        code: "USDC",
        issuer: null,
      });
      const lower = canonicalAssetId({
        network: "testnet",
        code: "usdc",
        issuer: null,
      });

      expect(upper).not.toBe(lower);
    });
  });

  describe("assetKind", () => {
    it("is native when there is no issuer", () => {
      expect(assetKind(null)).toBe("native");
      expect(assetKind(undefined)).toBe("native");
      expect(assetKind("")).toBe("native");
    });

    it("is issued when an issuer is present", () => {
      expect(assetKind("GISSUER1")).toBe("issued");
    });
  });

  describe("normalizeIssuer", () => {
    it("returns null for null, undefined, empty, or whitespace-only issuers", () => {
      expect(normalizeIssuer(null)).toBeNull();
      expect(normalizeIssuer(undefined)).toBeNull();
      expect(normalizeIssuer("")).toBeNull();
      expect(normalizeIssuer("   ")).toBeNull();
    });

    it("trims a real issuer value", () => {
      expect(normalizeIssuer("  GISSUER1  ")).toBe("GISSUER1");
    });
  });

  describe("isSameCanonicalAsset", () => {
    it("is true for equivalent inputs", () => {
      expect(
        isSameCanonicalAsset(
          { network: "TESTNET", code: "XLM", issuer: undefined },
          { network: "testnet", code: "XLM", issuer: null },
        ),
      ).toBe(true);
    });

    it("is false when the network differs", () => {
      expect(
        isSameCanonicalAsset(
          { network: "testnet", code: "XLM", issuer: null },
          { network: "public", code: "XLM", issuer: null },
        ),
      ).toBe(false);
    });

    it("is false when only issuer presence differs", () => {
      expect(
        isSameCanonicalAsset(
          { network: "testnet", code: "USDC", issuer: null },
          { network: "testnet", code: "USDC", issuer: "GISSUER1" },
        ),
      ).toBe(false);
    });
  });
});
