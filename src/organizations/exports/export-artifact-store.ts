import { Injectable, Logger } from "@nestjs/common";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, join, resolve, sep } from "path";
import { tmpdir } from "os";

/**
 * Where an encrypted export archive lives between generation and download.
 *
 * The interface is deliberately tiny — write, read, remove — so the temporary
 * artifact can be exercised in tests with an in-memory store and the service
 * never learns whether it is talking to a disk, an object store, or a fake. The
 * one rule every implementation must keep is the one the filesystem version
 * enforces below: a job's artifact path is derived from its id and confined to a
 * single base directory, so a job can never be tricked into reading or deleting
 * a file outside it.
 */
export interface ExportArtifactStore {
  /** Persists an archive for `jobId` and returns its opaque location. */
  write(jobId: string, content: Buffer): Promise<string>;
  /** Reads back an archive by the location `write` returned. */
  read(location: string): Promise<Buffer>;
  /** Removes an artifact. Idempotent: removing a missing artifact is not an error. */
  remove(location: string): Promise<void>;
}

/** DI token for {@link ExportArtifactStore}, since an interface has no runtime token. */
export const EXPORT_ARTIFACT_STORE = Symbol("EXPORT_ARTIFACT_STORE");

@Injectable()
export class FsExportArtifactStore implements ExportArtifactStore {
  private readonly logger = new Logger(FsExportArtifactStore.name);
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    // Default under the OS temp dir. A single confined base is what makes the
    // path-traversal guard in `locationFor` meaningful.
    this.baseDir = resolve(baseDir ?? join(tmpdir(), "earnproof-exports"));
  }

  async write(jobId: string, content: Buffer): Promise<string> {
    const location = this.locationFor(jobId);
    await mkdir(dirname(location), { recursive: true });
    // 0o600: readable only by the owning process user. The archive is tenant
    // data at rest; a world-readable temp file would undo the encryption's point
    // for anyone already on the host.
    await writeFile(location, content, { mode: 0o600 });
    return location;
  }

  async read(location: string): Promise<Buffer> {
    return readFile(this.assertWithinBase(location));
  }

  async remove(location: string): Promise<void> {
    try {
      await rm(this.assertWithinBase(location), { force: true });
    } catch (error) {
      // Cleanup failures must never propagate: a job that cannot delete its
      // temp file has still finished, and the expiry sweep will retry removal.
      this.logger.warn(
        `Failed to remove export artifact: ${
          error instanceof Error ? error.name : "unknown error"
        }`,
      );
    }
  }

  /** Derives a per-job path, with the job id sanitised to a bare token. */
  private locationFor(jobId: string): string {
    // The id is a cuid, but sanitise defensively: only a stored job id ever
    // reaches here, yet a filename built from an identifier is exactly where a
    // traversal sequence would do damage if that assumption ever broke.
    const safe = jobId.replace(/[^a-zA-Z0-9_-]/g, "");
    if (safe.length === 0) {
      throw new Error("Refusing to build an artifact path from an empty id");
    }
    return join(this.baseDir, `${safe}.enc`);
  }

  /** Confirms a path resolves inside the base directory before touching it. */
  private assertWithinBase(location: string): string {
    const resolved = resolve(location);
    if (resolved !== this.baseDir && !resolved.startsWith(this.baseDir + sep)) {
      throw new Error("Export artifact path escapes the configured base directory");
    }
    return resolved;
  }
}
