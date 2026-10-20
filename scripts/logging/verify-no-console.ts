#!/usr/bin/env node

/**
 * Verifies that no raw console.* calls remain in src/, excluding:
 * - Comments
 * - Example/documentation code in comments
 * - Bootstrap and CLI scripts (main.ts, CLI tools)
 * - Test files (*.spec.ts, test/*)
 *
 * Exit 0 if clean, exit 1 if console.* found.
 */

import { globSync } from "glob";
import { readFileSync } from "fs";
import { relative, resolve } from "path";

const rootDir = resolve(__dirname, "../../");
const srcDir = resolve(rootDir, "src");

// Files that are allowed to use console.* (bootstrap, CLI, etc.)
const ALLOWED_PATTERNS = [
  /\/main\.ts$/,
  /\/bootstrap\.ts$/,
  /scripts\//,
];

// Patterns to ignore (comments, examples)
const IGNORE_PATTERNS = [
  /^\s*\/\//,          // line comments
  /^\s*\/\*/,          // block comment start
  /^\s*\*/,            // continuation of block comment
  /console\.log\([^)]*console\.log/,  // inside comment
];

function isAllowedFile(filePath: string): boolean {
  const rel = relative(rootDir, filePath);
  return ALLOWED_PATTERNS.some((p) => p.test(rel));
}

function isCommentLine(line: string): boolean {
  return IGNORE_PATTERNS.some((p) => p.test(line));
}

function findConsoleLog(filePath: string): Array<{ line: number; text: string }> {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const matches: Array<{ line: number; text: string }> = [];

  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Track block comments
    if (line.includes("/*")) inBlockComment = true;
    if (line.includes("*/")) inBlockComment = false;

    // Skip comment lines
    if (inBlockComment || isCommentLine(line)) continue;

    // Match console.log, console.error, console.warn
    if (/console\.(log|error|warn)\s*\(/.test(line)) {
      matches.push({ line: lineNum, text: line.trim() });
    }
  }

  return matches;
}

function main(): number {
  const srcFiles = globSync("**/*.ts", {
    cwd: srcDir,
    ignore: ["**/*.spec.ts", "**/*.perf-spec.ts"],
  });

  let found = false;

  for (const file of srcFiles) {
    const fullPath = resolve(srcDir, file);

    // Skip allowed files
    if (isAllowedFile(fullPath)) continue;

    const matches = findConsoleLog(fullPath);
    if (matches.length === 0) continue;

    if (!found) {
      console.error(
        "\n❌ Found raw console.* calls in src/ (should use StructuredLogger):\n"
      );
      found = true;
    }

    console.error(`${file}:`);
    for (const match of matches) {
      console.error(`  ${match.line}: ${match.text}`);
    }
    console.error("");
  }

  if (found) {
    console.error(
      "Migrate these to StructuredLogger (import { StructuredLogger } from '../common/logger')"
    );
    console.error(
      "See docs/structured-logging.md for migration instructions."
    );
    return 1;
  }

  console.log("✓ No raw console.* calls found in src/");
  return 0;
}

process.exit(main());
