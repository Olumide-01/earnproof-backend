import { ResourceStatus } from "@prisma/client";
import { IssuerRegistryService, parseIssuerAddress } from "./issuer-registry.service";

describe("IssuerRegistryService", () => {
  const input = {
    issuerId: "issuer_1",
    stellarAddress: "GBFXVVSIVZHCSLMZ23N7QDOSFKMCXFQZ7S3KBXCGYZTZZBDSJ2SPCZYZ",
    metadataHash: "a".repeat(64),
    status: ResourceStatus.ACTIVE,
    contractSyncedStatus: null,
  };

  it("reports PENDING before an issuer is approved", async () => {
    const service = new IssuerRegistryService({
      get: jest.fn(),
    } as never);

    await expect(
      service.sync({ ...input, status: ResourceStatus.PENDING }),
    ).resolves.toEqual({
      state: "pending",
      reason: "Issuer must be ACTIVE before contract registration",
    });
  });

  it("reports DISABLED when the registry is not fully configured", async () => {
    const service = new IssuerRegistryService({
      get: jest.fn(),
    } as never);

    await expect(service.sync(input)).resolves.toEqual({
      state: "disabled",
      reason: "Issuer registry synchronization is not configured",
    });
  });
});

describe("IssuerRegistryService address rotation", () => {
  const issuerAddress = "GBFXVVSIVZHCSLMZ23N7QDOSFKMCXFQZ7S3KBXCGYZTZZBDSJ2SPCZYZ";
  const newAddress = "GCFXVVSIVZHCSLMZ23N7QDOSFKMCXFQZ7S3KBXCGYZTZZBDSJ2SPCZYA";

  class ScriptedRegistry extends IssuerRegistryService {
    calls: string[][] = [];
    constructor(private readonly respond: (args: string[]) => string) {
      super({
        get: (key: string) =>
          ({
            "issuerRegistry.enabled": true,
            "issuerRegistry.source": "registry-admin",
            "issuerRegistry.contractId": "CCONTRACT",
            "stellar.network": "testnet",
          })[key],
      } as never);
    }
    protected async execute(args: string[]): Promise<string> {
      this.calls.push(args);
      return this.respond(args);
    }
  }

  it("reads the address the contract holds, without signing", async () => {
    const registry = new ScriptedRegistry(() =>
      JSON.stringify({ issuer_address: issuerAddress, status: "Active" }),
    );

    await expect(registry.readIssuerAddress("issuer_1")).resolves.toEqual({
      state: "found",
      issuerAddress,
    });
    expect(registry.calls[0]).toEqual([
      "contract",
      "invoke",
      "--network",
      "testnet",
      "--id",
      "CCONTRACT",
      "--",
      "get_issuer",
      "--issuer_id_hash",
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(registry.calls[0]).not.toContain("--source");
  });

  it("submits rotate_issuer_address signed by the registry source", async () => {
    const registry = new ScriptedRegistry(() => `simulating...\n${"e".repeat(64)}\n`);

    await expect(registry.rotateIssuerAddress("issuer_1", newAddress)).resolves.toEqual({
      state: "submitted",
      transactionHash: "e".repeat(64),
    });
    expect(registry.calls[0]).toEqual(
      expect.arrayContaining([
        "--source",
        "registry-admin",
        "rotate_issuer_address",
        "--new_address",
        newAddress,
      ]),
    );
  });

  it("reports a failed CLI call instead of throwing, with a redacted message", async () => {
    const registry = new ScriptedRegistry(() => {
      throw new Error("Error(Contract, #7): address already registered");
    });

    const read = await registry.readIssuerAddress("issuer_1");
    const rotate = await registry.rotateIssuerAddress("issuer_1", newAddress);

    expect(read.state).toBe("failed");
    expect(rotate.state).toBe("failed");
  });

  it("treats output without an issuer address as a failed read", async () => {
    const registry = new ScriptedRegistry(() => "null");

    await expect(registry.readIssuerAddress("issuer_1")).resolves.toMatchObject({
      state: "failed",
    });
  });

  it("is disabled until the contract, source and flag are all configured", async () => {
    const registry = new IssuerRegistryService({ get: jest.fn() } as never);

    expect(registry.isConfigured).toBe(false);
    await expect(registry.readIssuerAddress("issuer_1")).resolves.toMatchObject({
      state: "disabled",
    });
    await expect(registry.rotateIssuerAddress("issuer_1", newAddress)).resolves.toMatchObject({
      state: "disabled",
    });
  });

  it.each([
    [JSON.stringify({ issuer_address: issuerAddress }), issuerAddress],
    [`{ issuer_address: "${issuerAddress}", status: Active }`, issuerAddress],
    ["{}", undefined],
    ["", undefined],
  ])("parses %p", (stdout, expected) => {
    expect(parseIssuerAddress(stdout)).toBe(expected);
  });
});
