import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";

const MIGRATION_NAME = /^(\d{14})_[a-z0-9_]+$/;
const LEGACY_DUPLICATE_TIMESTAMPS = new Set([
  "20260824000000",
  "20260829000000",
  "20260901000000",
  "20260925000000",
  "20260926100000",
  "20260927000000",
  "20261016000000",
  "20261202000000",
  "20261216000000",
]);
// Existing production history cannot be edited without invalidating Prisma's
// recorded checksum. Its memo TEXT-to-JSONB conversion predates this gate and
// is documented in the migration guide; all new unsafe SQL must carry markers.
const LEGACY_UNSAFE_MIGRATIONS = new Set([
  "20260825100000_store_payment_memo_context",
  "20260927000000_add_organization_to_supported_assets",
  "20260927100000_versioned_webhook_payloads",
]);

export interface MigrationSafetyIssue {
  code: "timestamp" | "checksum" | "ordering" | "unsafe_sql";
  migration: string;
  detail: string;
}

export function migrationSafetyIssues(directory = resolve("prisma", "migrations")): MigrationSafetyIssue[] {
  const migrations = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const issues: MigrationSafetyIssue[] = [];
  const timestamps = new Map<string, string[]>();
  const checksums = new Map<string, string[]>();

  for (const name of migrations) {
    const match = MIGRATION_NAME.exec(name);
    if (!match) {
      issues.push({ code: "ordering", migration: name, detail: "name must start with a 14-digit UTC timestamp and underscore" });
      continue;
    }
    const timestamp = match[1];
    timestamps.set(timestamp, [...(timestamps.get(timestamp) ?? []), name]);
    const sqlPath = join(directory, name, "migration.sql");
    let sql: string;
    try {
      sql = readFileSync(sqlPath, "utf8");
    } catch {
      issues.push({ code: "ordering", migration: name, detail: "migration.sql is missing" });
      continue;
    }
    const checksum = createHash("sha256").update(sql).digest("hex");
    checksums.set(checksum, [...(checksums.get(checksum) ?? []), name]);
    if (isUnsafeSql(sql) && !hasDestructiveApproval(sql) && !LEGACY_UNSAFE_MIGRATIONS.has(name)) {
      issues.push({ code: "unsafe_sql", migration: name, detail: "destructive or incompatible SQL needs migration-safety approval, compatibility, and rollback notes" });
    }
  }

  for (const [timestamp, names] of timestamps) {
    if (names.length > 1 && !LEGACY_DUPLICATE_TIMESTAMPS.has(timestamp)) {
      issues.push({ code: "timestamp", migration: names.join(", "), detail: `duplicate timestamp ${timestamp}` });
    }
  }
  for (const [checksum, names] of checksums) {
    if (names.length > 1) {
      issues.push({ code: "checksum", migration: names.join(", "), detail: `duplicate SQL checksum ${checksum}` });
    }
  }
  return issues;
}

function isUnsafeSql(sql: string): boolean {
  return /\bDROP\s+(TABLE|COLUMN|TYPE|SCHEMA)\b|\bALTER\s+(?:TABLE\s+\S+\s+)?ALTER\s+COLUMN\s+\S+\s+(?:TYPE|SET\s+NOT\s+NULL)\b/i.test(sql);
}

function hasDestructiveApproval(sql: string): boolean {
  return /migration-safety:\s*destructive-approved/i.test(sql) &&
    /migration-safety:\s*compatibility=/i.test(sql) &&
    /migration-safety:\s*rollback=/i.test(sql);
}

if (require.main === module) {
  const issues = migrationSafetyIssues();
  for (const issue of issues) console.error(`${issue.code}: ${issue.migration}: ${issue.detail}`);
  if (issues.length) process.exit(1);
  console.log("Migration safety gate passed.");
}
