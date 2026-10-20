import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

const MAX_KEY_VERSIONS = 100;

/** A non-secret identifier for a cursor signing key version. */
export function cursorKeyId(version: number): string {
  return `cursor-v${version}`;
}

/** Recovers the numeric version from a cursorKeyId string, or null if malformed. */
export function versionFromCursorKeyId(id: string): number | null {
  const match = /^cursor-v(\d+)$/.exec(id);
  if (!match) return null;
  return Number(match[1]);
}

/**
 * Loads and exposes the cursor-signing keyring for staged key rotation.
 *
 * Mirrors CredentialSigningKeyringService pattern:
 *
 * - **active**: exactly one version (`CURSOR_SIGNING_KEY_VERSION`). Only
 *   this version signs new cursors. It also verifies.
 * - **verify-only**: every other loaded version. Verifies existing
 *   cursors but never signs new ones. Optionally bounded by a
 *   `CURSOR_SIGNING_SECRET_V{n}_VERIFY_UNTIL` deadline (ISO-8601).
 * - **retired**: removed entirely by deleting its `CURSOR_SIGNING_SECRET_V{n}`
 *   env var. A retired version is not loaded and cannot verify anything.
 *
 * `CURSOR_SIGNING_SECRET_V0`, `_V1`, ... are loaded sequentially until
 * the first gap. For backward compatibility, the legacy `CURSOR_SIGNING_SECRET`
 * is treated as an implicit version 0 when `CURSOR_SIGNING_SECRET_V0` is
 * not set.
 *
 * Never logs key material: only versions, key IDs, and expiry instants are
 * logged.
 */
@Injectable()
export class SignedCursorKeyringService {
  private readonly logger = new Logger(SignedCursorKeyringService.name);
  private readonly keyring: Map<number, string>;
  private readonly verifyUntil: Map<number, Date>;
  private readonly activeVersion: number;

  constructor(configService: ConfigService) {
    const safeGet = <T>(key: string): T | undefined => {
      if (typeof configService.get === "function") {
        const val = configService.get<T>(key);
        if (val !== undefined && val !== null && typeof val !== "boolean") {
          return val;
        }
      }
      try {
        const val = configService.getOrThrow<T>(key);
        if (val !== undefined && val !== null && typeof val !== "boolean") {
          return val;
        }
      } catch {
        return undefined;
      }
      return undefined;
    };

    const keys = new Map<number, string>();

    const legacySecret = safeGet<string>("cursorSigningSecret");
    const v0FromVersioned = safeGet<string>("cursorSigningKeyVersions.0");
    if (v0FromVersioned) {
      keys.set(0, v0FromVersioned);
    } else if (legacySecret) {
      keys.set(0, legacySecret);
    }

    for (let i = 1; i < MAX_KEY_VERSIONS; i++) {
      const secret = safeGet<string>(`cursorSigningKeyVersions.${i}`);
      if (secret) {
        keys.set(i, secret);
      } else {
        break;
      }
    }

    this.keyring = keys;

    const verifyUntil = new Map<number, Date>();
    for (const version of keys.keys()) {
      const raw = safeGet<string>(`cursorSigningKeyVerifyUntil.${version}`);
      if (!raw) continue;
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) {
        this.logger.error(
          `CURSOR_SIGNING_SECRET_V${version}_VERIFY_UNTIL is not a valid ISO-8601 ` +
            `timestamp; ignoring it (key version ${version} will not expire).`,
        );
        continue;
      }
      verifyUntil.set(version, parsed);
    }
    this.verifyUntil = verifyUntil;

    const configuredVersion = safeGet<number>("cursorSigningKeyVersion");
    this.activeVersion =
      typeof configuredVersion === "number" && Number.isFinite(configuredVersion)
        ? configuredVersion
        : 0;

    if (this.keyring.size === 0) {
      this.logger.error(
        "No cursor signing keys configured (CURSOR_SIGNING_SECRET / CURSOR_SIGNING_SECRET_V*).",
      );
    }

    if (!this.keyring.has(this.activeVersion)) {
      this.logger.error(
        `Configured active cursor signing key version ${this.activeVersion} is not loaded. ` +
          `Loaded versions: [${[...this.keyring.keys()].sort((a, b) => a - b).join(", ")}]. ` +
          `Adjust CURSOR_SIGNING_KEY_VERSION or configure CURSOR_SIGNING_SECRET_V${this.activeVersion}.`,
      );
    }
  }

  /** The version new cursors are signed with. */
  get activeWriteVersion(): number {
    return this.activeVersion;
  }

  /** The non-secret key ID embedded in a newly-signed cursor. */
  get activeKeyId(): string {
    return cursorKeyId(this.activeVersion);
  }

  /** Every version currently loaded, regardless of state. */
  get loadedVersions(): readonly number[] {
    return [...this.keyring.keys()].sort((a, b) => a - b);
  }

  /**
   * Whether `version` may currently be used to verify a cursor: it must
   * be loaded, and if it carries a VERIFY_UNTIL deadline, that deadline must
   * not have passed. The active version is always usable regardless of any
   * deadline (a deadline is only meaningful for a version being phased out).
   */
  isUsableForVerification(version: number): boolean {
    if (!this.keyring.has(version)) return false;
    if (version === this.activeVersion) return true;

    const deadline = this.verifyUntil.get(version);
    if (!deadline) return true;
    return Date.now() <= deadline.getTime();
  }

  /** The secret for `version`, or undefined if not loaded. Never logged. */
  secretFor(version: number): string | undefined {
    return this.keyring.get(version);
  }

  /** The secret used to sign new cursors. */
  get activeSecret(): string {
    const secret = this.keyring.get(this.activeVersion);
    if (!secret) {
      throw new Error(
        `Active cursor signing key version ${this.activeVersion} is not configured`,
      );
    }
    return secret;
  }
}
