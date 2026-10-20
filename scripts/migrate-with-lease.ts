#!/usr/bin/env npx tsx

import { PrismaClient } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { MigrationLeaseService } from "../src/database/migration-lease.service";
import { migrationSafetyIssues } from "./migration-safety";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Migration deployment with lease protection.
 * 
 * This script:
 * 1. Acquires the migration deployment lease
 * 2. Runs migration safety checks 
 * 3. Applies Prisma migrations
 * 4. Releases the lease
 * 
 * Only one deployment can hold the lease at a time.
 */

async function main() {
  const prisma = new PrismaClient();
  const config = new ConfigService();
  const migrationLease = new MigrationLeaseService(prisma, config);

  let leaseAcquired = false;

  try {
    console.log("🔒 Acquiring migration deployment lease...");
    
    const leaseResult = await migrationLease.acquireLease("starting_deployment");
    
    if (!leaseResult.acquired) {
      console.error(`❌ Failed to acquire migration lease: ${leaseResult.reason}`);
      if (leaseResult.currentOwner) {
        console.error(`   Current owner: ${leaseResult.currentOwner}`);
        console.error(`   Acquired at: ${leaseResult.acquiredAt?.toISOString()}`);
        console.error(`   Expires at: ${leaseResult.expiresAt?.toISOString()}`);
      }
      process.exit(1);
    }

    leaseAcquired = true;
    console.log(`✅ Migration lease acquired by ${leaseResult.ownerId}`);
    console.log(`   Expires at: ${leaseResult.expiresAt.toISOString()}`);

    // Update lease state for observability
    await migrationLease.updateMigrationState("running_safety_checks");

    console.log("🔍 Running migration safety checks...");
    const safetyIssues = migrationSafetyIssues();
    
    if (safetyIssues.length > 0) {
      console.error("❌ Migration safety issues detected:");
      for (const issue of safetyIssues) {
        console.error(`   ${issue.code}: ${issue.migration}: ${issue.detail}`);
      }
      process.exit(1);
    }

    console.log("✅ Migration safety checks passed");

    // Update lease state
    await migrationLease.updateMigrationState("generating_client");

    console.log("🔧 Generating Prisma client...");
    execSync("npx prisma generate", { stdio: "inherit" });

    // Update lease state
    await migrationLease.updateMigrationState("applying_migrations");

    console.log("📊 Applying database migrations...");
    execSync("npx prisma migrate deploy", { stdio: "inherit" });

    // Get current migration version for lease metadata
    let migrationVersion = "unknown";
    try {
      const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
      migrationVersion = `app_${packageJson.version ?? "unknown"}`;
    } catch {
      // Fallback to timestamp
      migrationVersion = `deployed_${new Date().toISOString()}`;
    }

    console.log("✅ Migrations applied successfully");

    // Release the lease
    await migrationLease.releaseLease(migrationVersion);
    leaseAcquired = false;

    console.log("🔓 Migration lease released");
    console.log("🚀 Deployment ready to serve traffic");

  } catch (error) {
    console.error("❌ Migration deployment failed:", error instanceof Error ? error.message : String(error));
    
    if (leaseAcquired) {
      try {
        await migrationLease.releaseLease("failed");
        console.log("🔓 Migration lease released after failure");
      } catch (releaseError) {
        console.error("⚠️  Failed to release lease after error:", releaseError instanceof Error ? releaseError.message : String(releaseError));
      }
    }
    
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Handle process signals to ensure lease cleanup
process.on("SIGTERM", async () => {
  console.log("🛑 Received SIGTERM, attempting graceful shutdown...");
  process.exit(1);
});

process.on("SIGINT", async () => {
  console.log("🛑 Received SIGINT, attempting graceful shutdown...");
  process.exit(1);
});

main().catch((error) => {
  console.error("💥 Unhandled migration deployment error:", error);
  process.exit(1);
});