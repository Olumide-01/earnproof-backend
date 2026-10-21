import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { MigrationLeaseService } from "./migration-lease.service";
import { DistributedLeaseService } from "../jobs/distributed-lease.service";

@Global()
@Module({
  providers: [PrismaService, MigrationLeaseService, DistributedLeaseService],
  exports: [PrismaService, MigrationLeaseService, DistributedLeaseService],
})
export class DatabaseModule {}
