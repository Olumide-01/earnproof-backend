import { Response } from "express";
import { CredentialVerificationKeyService } from "../common/crypto/credential-verification-key.service";
import { CredentialsController } from "./credentials.controller";

describe("CredentialsController key discovery", () => {
  it("returns cache headers and a 304 for a matching ETag", () => {
    const keyService = new CredentialVerificationKeyService({
      getOrThrow: () => "current-secret",
      get: () => undefined,
    } as never);
    const response = {
      setHeader: jest.fn(),
      status: jest.fn(),
    } as unknown as Response;
    const controller = new CredentialsController({} as never, keyService);

    const first = controller.getVerificationKeys(undefined, response);
    expect(first).toEqual(keyService.getPublicKeySet());
    expect(response.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "public, max-age=300, must-revalidate",
    );

    const second = controller.getVerificationKeys(keyService.getEtag(), response);
    expect(second).toBeUndefined();
    expect(response.status).toHaveBeenCalledWith(304);
  });
});
