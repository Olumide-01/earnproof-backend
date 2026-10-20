import { hostname } from "os";

/**
 * A stable, non-identifying label for the worker running an execution.
 *
 * `host:pid` is enough to tell two replicas apart when diagnosing an overlap or
 * a crash, and carries nothing sensitive — a hostname and a process id are
 * operational facts, not secrets. Computed once, because neither changes over a
 * process's life.
 */
let cached: string | undefined;

export function workerIdentity(): string {
  if (cached === undefined) {
    cached = `${safeHostname()}:${process.pid}`;
  }
  return cached;
}

function safeHostname(): string {
  try {
    return hostname() || "unknown-host";
  } catch {
    return "unknown-host";
  }
}
