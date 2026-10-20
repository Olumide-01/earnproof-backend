import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { PrismaService } from "../../database/prisma.service";
import { SessionService } from "../../auth/session.service";
import { AuthenticatedSession } from "../../auth/auth.types";
import { canAuthenticate } from "../../auth/account-status.policy";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly sessionService: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;

    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing bearer token");
    }

    const token = header.slice("Bearer ".length);

    // Validate the session — throws on malformed / expired / revoked tokens.
    const { sessionId, userId, walletHash } =
      await this.sessionService.validate(token);

    // Fetch the live user record so the guard can enforce account status.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        walletAddress: true,
        walletHash: true,
        role: true,
        status: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException("User not found");
    }

    if (!canAuthenticate(user.status)) {
      throw new UnauthorizedException("Account is not active");
    }

    // A session belongs to the wallet that signed in, not just the account.
    // After a wallet rotation, a session issued to the previous wallet is
    // refused even if it was created after the rotation revoked the others.
    // Legacy sessions (issued before this binding existed) carry no hash.
    if (walletHash && walletHash !== user.walletHash) {
      throw new UnauthorizedException("Session is no longer valid");
    }

    const authenticatedSession: AuthenticatedSession = {
      sessionId,
      id: user.id,
      walletAddress: user.walletAddress,
      walletHash: user.walletHash,
      role: user.role,
    };

    request.user = authenticatedSession;
    return true;
  }
}
