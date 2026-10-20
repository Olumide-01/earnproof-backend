import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { MigrationLeaseService } from "./migration-lease.service";

@Global()
@Module({
  providers: [PrismaService, MigrationLeaseService],
  exports: [PrismaService, MigrationLeaseService],
})
export class DatabaseModule {}
