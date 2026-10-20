import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuthenticatedSession } from "./auth.types";
import { SessionService } from "./session.service";

describe("AuthController", () => {
  it("rotates the authenticated session and returns a bearer token", async () => {
    const authService = {} as AuthService;
    const expiresAt = new Date("2030-01-01T00:00:00.000Z");
    const sessionService = {
      rotate: jest.fn().mockResolvedValue({
        token: "new-session.token",
        sessionId: "new-session",
        expiresAt,
      }),
    } as unknown as SessionService;
    const controller = new AuthController(authService, sessionService, { issue: jest.fn().mockResolvedValue({ token: 'tok', expiresAt: new Date() }) } as never);
    const session: AuthenticatedSession = {
      sessionId: "old-session",
      id: "user-1",
      walletAddress: "G".padEnd(56, "A"),
      walletHash: "sha256:wallet",
      role: "WORKER",
    };

    await expect(controller.rotate(session)).resolves.toEqual({
      token: "new-session.token",
      tokenType: "Bearer",
      sessionId: "new-session",
      expiresAt,
    });
    expect(sessionService.rotate).toHaveBeenCalledWith("old-session", session, undefined, undefined);
  });
});
