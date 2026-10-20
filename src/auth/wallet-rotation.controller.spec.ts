import { ArgumentMetadata, HttpStatus, ValidationPipe } from "@nestjs/common";
import { GUARDS_METADATA, HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { AuthGuard } from "../common/guards/auth.guard";
import { AuthenticatedSession } from "./auth.types";
import {
  CompleteWalletRotationDto,
  InitiateWalletRotationDto,
} from "./dto/wallet-rotation.dto";
import { WalletRotationController } from "./wallet-rotation.controller";
import { WalletRotationService } from "./wallet-rotation.service";

const session: AuthenticatedSession = {
  sessionId: "sess_1",
  id: "user_1",
  walletAddress: "G".padEnd(56, "A"),
  walletHash: "sha256:abc",
  role: "WORKER",
};

const pipe = new ValidationPipe({
  forbidNonWhitelisted: true,
  transform: true,
  whitelist: true,
});

function validate<T>(metatype: new () => T, value: unknown): Promise<T> {
  const metadata: ArgumentMetadata = { type: "body", metatype, data: "" };
  return pipe.transform(value, metadata);
}

describe("WalletRotationController", () => {
  function makeController() {
    const service = {
      initiate: jest.fn().mockResolvedValue({ rotationId: "r1" }),
      complete: jest.fn().mockResolvedValue({ walletAddress: "GNEW", sessionsRevoked: 1 }),
    };
    return {
      service,
      controller: new WalletRotationController(service as unknown as WalletRotationService),
    };
  }

  it("initiates for the session's own account and forwards the request origin", async () => {
    const { controller, service } = makeController();

    await controller.initiate(session, { newWalletAddress: "GNEW" }, "https://app.example.com");

    expect(service.initiate).toHaveBeenCalledWith(session, "GNEW", "https://app.example.com");
  });

  it("completes for the session's own account and forwards the request origin", async () => {
    const { controller, service } = makeController();
    const body = { currentSignature: "a", newSignature: "b" };

    await controller.complete(session, "r1", body, undefined);

    expect(service.complete).toHaveBeenCalledWith(session, "r1", body, undefined);
  });

  it("requires a session on the whole controller", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, WalletRotationController)).toEqual([AuthGuard]);
  });

  it("answers completion with 200, not 201", () => {
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, WalletRotationController.prototype.complete),
    ).toBe(HttpStatus.OK);
  });

  describe("request validation", () => {
    it("accepts a 56-character replacement address and rejects other lengths", async () => {
      await expect(
        validate(InitiateWalletRotationDto, { newWalletAddress: "G".padEnd(56, "B") }),
      ).resolves.toBeDefined();
      await expect(
        validate(InitiateWalletRotationDto, { newWalletAddress: "G".padEnd(55, "B") }),
      ).rejects.toThrow();
      await expect(
        validate(InitiateWalletRotationDto, { newWalletAddress: "G".padEnd(57, "B") }),
      ).rejects.toThrow();
    });

    it("rejects extra fields on initiation", async () => {
      await expect(
        validate(InitiateWalletRotationDto, {
          newWalletAddress: "G".padEnd(56, "B"),
          userId: "user_2",
        }),
      ).rejects.toThrow();
    });

    it("requires both signatures and bounds their length", async () => {
      await expect(
        validate(CompleteWalletRotationDto, { currentSignature: "a", newSignature: "b" }),
      ).resolves.toBeDefined();
      await expect(
        validate(CompleteWalletRotationDto, { currentSignature: "a" }),
      ).rejects.toThrow();
      await expect(
        validate(CompleteWalletRotationDto, {
          currentSignature: "a".repeat(257),
          newSignature: "b",
        }),
      ).rejects.toThrow();
    });
  });
});
