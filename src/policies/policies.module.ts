import { Module } from "@nestjs/common";
import { PermissionDiffService } from "./permission-diff.service";

@Module({
  providers: [PermissionDiffService],
  exports: [PermissionDiffService],
})
export class PoliciesModule {}