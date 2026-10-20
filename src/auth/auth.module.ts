import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuthTokenService } from "./auth-token.service";
import { SessionService } from "./session.service";
import { AuthGuard } from "../common/guards/auth.guard";
import { CleanupJob } from "./cleanup.job";
import { AuthAuditService } from "./auth-audit.service";
import { AuthRateLimiterService } from "./auth-rate-limiter.service";
import { Clock, SystemClock } from "../common/time/clock";
import { WalletRotationController } from "./wallet-rotation.controller";
import { WalletRotationService } from "./wallet-rotation.service";
import { RecentAuthService } from "./recent-auth.service";
import { RecentAuthGuard } from "../common/guards/recent-auth.guard";
import { SessionRiskService } from "./session-risk.service";

@Module({
  controllers: [AuthController, WalletRotationController],
  providers: [
    AuthService,
    AuthTokenService,
    SessionService,
    AuthAuditService,
    AuthRateLimiterService,
    AuthGuard,
    CleanupJob,
    WalletRotationService,
    { provide: Clock, useClass: SystemClock },
    RecentAuthService,
    RecentAuthGuard,
    SessionRiskService,
  ],
  exports: [
    SessionService,
    AuthTokenService,
    AuthGuard,
    AuthAuditService,
    RecentAuthService,
    RecentAuthGuard,
    SessionRiskService,
  ],
})
export class AuthModule {}