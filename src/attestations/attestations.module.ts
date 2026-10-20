import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { AttestationsService } from "./attestations.service";
import { AttestationsController } from "./attestations.controller";

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [AttestationsController],
  providers: [AttestationsService],
  exports: [AttestationsService],
})
export class AttestationsModule {}
