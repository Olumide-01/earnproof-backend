import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { SignedCursorKeyringService, cursorKeyId, versionFromCursorKeyId } from "./signed-cursor-keyring.service";

const TEST_SECRETS = {
  0: "secret-v0-abcdefghij0123456789",
  1: "secret-v1-abcdefghij0123456789",
  2: "secret-v2-abcdefghij0123456789",
};

describe("SignedCursorKeyringService", () => {
  describe("cursorKeyId", () => {
    it("should format key IDs correctly", () => {
      expect(cursorKeyId(0)).toBe("cursor-v0");
      expect(cursorKeyId(1)).toBe("cursor-v1");
      expect(cursorKeyId(42)).toBe("cursor-v42");
    });
  });

  describe("versionFromCursorKeyId", () => {
    it("should extract version from key ID", () => {
      expect(versionFromCursorKeyId("cursor-v0")).toBe(0);
      expect(versionFromCursorKeyId("cursor-v1")).toBe(1);
      expect(versionFromCursorKeyId("cursor-v42")).toBe(42);
    });

    it("should return null for invalid key IDs", () => {
      expect(versionFromCursorKeyId("invalid")).toBeNull();
      expect(versionFromCursorKeyId("credential-v0")).toBeNull();
      expect(versionFromCursorKeyId("cursor-abc")).toBeNull();
      expect(versionFromCursorKeyId("")).toBeNull();
    });
  });

  describe("initialization", () => {
    it("should load versioned secrets from config", async () => {
      const mockConfig = {
        get: (key: string) => {
          const config: Record<string, any> = {
            cursorSigningKeyVersions: TEST_SECRETS,
            cursorSigningKeyVersion: 1,
          };
          return config[key];
        },
        getOrThrow: (key: string) => {
          const val = mockConfig.get(key);
          if (val === undefined) throw new Error(`Not found: ${key}`);
          return val;
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SignedCursorKeyringService,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const service = module.get<SignedCursorKeyringService>(SignedCursorKeyringService);

      expect(service.loadedVersions).toEqual([0, 1, 2]);
      expect(service.activeWriteVersion).toBe(1);
      expect(service.activeKeyId).toBe("cursor-v1");
    });

    it("should use legacy CURSOR_SIGNING_SECRET as version 0 if no versioned secrets", async () => {
      const mockConfig = {
        get: (key: string) => {
          const config: Record<string, any> = {
            cursorSigningSecret: "legacy-secret",
            cursorSigningKeyVersion: 0,
          };
          return config[key];
        },
        getOrThrow: (key: string) => {
          const val = mockConfig.get(key);
          if (val === undefined) throw new Error(`Not found: ${key}`);
          return val;
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SignedCursorKeyringService,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const service = module.get<SignedCursorKeyringService>(SignedCursorKeyringService);

      expect(service.loadedVersions).toEqual([0]);
      expect(service.secretFor(0)).toBe("legacy-secret");
    });

    it("should default to version 0 if no version configured", async () => {
      const mockConfig = {
        get: (key: string) => {
          const config: Record<string, any> = {
            cursorSigningKeyVersions: TEST_SECRETS,
          };
          return config[key];
        },
        getOrThrow: (key: string) => {
          const val = mockConfig.get(key);
          if (val === undefined) throw new Error(`Not found: ${key}`);
          return val;
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SignedCursorKeyringService,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const service = module.get<SignedCursorKeyringService>(SignedCursorKeyringService);

      expect(service.activeWriteVersion).toBe(0);
    });

    it("should load keys until first gap", async () => {
      const mockConfig = {
        get: (key: string) => {
          const config: Record<string, any> = {
            cursorSigningKeyVersions: {
              0: TEST_SECRETS[0],
              1: TEST_SECRETS[1],
              // Gap at 2
              3: "secret-v3",
            },
            cursorSigningKeyVersion: 0,
          };
          return config[key];
        },
        getOrThrow: (key: string) => {
          const val = mockConfig.get(key);
          if (val === undefined) throw new Error(`Not found: ${key}`);
          return val;
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SignedCursorKeyringService,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const service = module.get<SignedCursorKeyringService>(SignedCursorKeyringService);

      // Should load only up to first gap
      expect(service.loadedVersions).toEqual([0, 1]);
    });
  });

  describe("activeSecret", () => {
    it("should return the active secret", async () => {
      const mockConfig = {
        get: (key: string) => {
          const config: Record<string, any> = {
            cursorSigningKeyVersions: TEST_SECRETS,
            cursorSigningKeyVersion: 1,
          };
          return config[key];
        },
        getOrThrow: (key: string) => {
          const val = mockConfig.get(key);
          if (val === undefined) throw new Error(`Not found: ${key}`);
          return val;
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SignedCursorKeyringService,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const service = module.get<SignedCursorKeyringService>(SignedCursorKeyringService);

      expect(service.activeSecret).toBe(TEST_SECRETS[1]);
    });

    it("should throw if active version is not configured", async () => {
      const mockConfig = {
        get: (key: string) => {
          const config: Record<string, any> = {
            cursorSigningKeyVersions: { 0: TEST_SECRETS[0] },
            cursorSigningKeyVersion: 5, // Not configured
          };
          return config[key];
        },
        getOrThrow: (key: string) => {
          const val = mockConfig.get(key);
          if (val === undefined) throw new Error(`Not found: ${key}`);
          return val;
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SignedCursorKeyringService,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const service = module.get<SignedCursorKeyringService>(SignedCursorKeyringService);

      expect(() => service.activeSecret).toThrowError(
        "Active cursor signing key version 5 is not configured",
      );
    });
  });

  describe("secretFor", () => {
    let service: SignedCursorKeyringService;

    beforeEach(async () => {
      const mockConfig = {
        get: (key: string) => {
          const config: Record<string, any> = {
            cursorSigningKeyVersions: TEST_SECRETS,
            cursorSigningKeyVersion: 1,
          };
          return config[key];
        },
        getOrThrow: (key: string) => {
          const val = mockConfig.get(key);
          if (val === undefined) throw new Error(`Not found: ${key}`);
          return val;
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SignedCursorKeyringService,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      service = module.get<SignedCursorKeyringService>(SignedCursorKeyringService);
    });

    it("should return secret for loaded version", () => {
      expect(service.secretFor(0)).toBe(TEST_SECRETS[0]);
      expect(service.secretFor(1)).toBe(TEST_SECRETS[1]);
      expect(service.secretFor(2)).toBe(TEST_SECRETS[2]);
    });

    it("should return undefined for unloaded version", () => {
      expect(service.secretFor(99)).toBeUndefined();
    });
  });

  describe("isUsableForVerification", () => {
    it("should allow verification with all loaded versions", async () => {
      const mockConfig = {
        get: (key: string) => {
          const config: Record<string, any> = {
            cursorSigningKeyVersions: TEST_SECRETS,
            cursorSigningKeyVersion: 1,
          };
          return config[key];
        },
        getOrThrow: (key: string) => {
          const val = mockConfig.get(key);
          if (val === undefined) throw new Error(`Not found: ${key}`);
          return val;
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SignedCursorKeyringService,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const service = module.get<SignedCursorKeyringService>(SignedCursorKeyringService);

      expect(service.isUsableForVerification(0)).toBe(true);
      expect(service.isUsableForVerification(1)).toBe(true);
      expect(service.isUsableForVerification(2)).toBe(true);
    });

    it("should deny verification with unloaded version", async () => {
      const mockConfig = {
        get: (key: string) => {
          const config: Record<string, any> = {
            cursorSigningKeyVersions: TEST_SECRETS,
            cursorSigningKeyVersion: 1,
          };
          return config[key];
        },
        getOrThrow: (key: string) => {
          const val = mockConfig.get(key);
          if (val === undefined) throw new Error(`Not found: ${key}`);
          return val;
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SignedCursorKeyringService,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const service = module.get<SignedCursorKeyringService>(SignedCursorKeyringService);

      expect(service.isUsableForVerification(99)).toBe(false);
    });

    it("should respect VERIFY_UNTIL deadline for non-active versions", async () => {
      const futureDeadline = new Date(Date.now() + 3600 * 1000).toISOString(); // 1 hour from now
      const pastDeadline = new Date(Date.now() - 3600 * 1000).toISOString(); // 1 hour ago

      const mockConfig = {
        get: (key: string) => {
          const config: Record<string, any> = {
            cursorSigningKeyVersions: {
              0: TEST_SECRETS[0],
              1: TEST_SECRETS[1],
              2: TEST_SECRETS[2],
            },
            cursorSigningKeyVersion: 1,
            cursorSigningKeyVerifyUntil: {
              0: futureDeadline,
              2: pastDeadline,
            },
          };
          return config[key];
        },
        getOrThrow: (key: string) => {
          const val = mockConfig.get(key);
          if (val === undefined) throw new Error(`Not found: ${key}`);
          return val;
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SignedCursorKeyringService,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const service = module.get<SignedCursorKeyringService>(SignedCursorKeyringService);

      // Version 1 (active) should be usable regardless of deadline
      expect(service.isUsableForVerification(1)).toBe(true);

      // Version 0 has future deadline, should be usable
      expect(service.isUsableForVerification(0)).toBe(true);

      // Version 2 has past deadline, should not be usable
      expect(service.isUsableForVerification(2)).toBe(false);
    });

    it("should always allow active version regardless of deadline", async () => {
      const pastDeadline = new Date(Date.now() - 3600 * 1000).toISOString();

      const mockConfig = {
        get: (key: string) => {
          const config: Record<string, any> = {
            cursorSigningKeyVersions: TEST_SECRETS,
            cursorSigningKeyVersion: 1,
            cursorSigningKeyVerifyUntil: {
              1: pastDeadline, // Even with past deadline
            },
          };
          return config[key];
        },
        getOrThrow: (key: string) => {
          const val = mockConfig.get(key);
          if (val === undefined) throw new Error(`Not found: ${key}`);
          return val;
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SignedCursorKeyringService,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const service = module.get<SignedCursorKeyringService>(SignedCursorKeyringService);

      // Active version should still be usable even with past deadline
      expect(service.isUsableForVerification(1)).toBe(true);
    });
  });

  describe("loadedVersions", () => {
    it("should return sorted versions", async () => {
      const mockConfig = {
        get: (key: string) => {
          const config: Record<string, any> = {
            cursorSigningKeyVersions: {
              2: TEST_SECRETS[2],
              0: TEST_SECRETS[0],
              1: TEST_SECRETS[1],
            },
            cursorSigningKeyVersion: 0,
          };
          return config[key];
        },
        getOrThrow: (key: string) => {
          const val = mockConfig.get(key);
          if (val === undefined) throw new Error(`Not found: ${key}`);
          return val;
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SignedCursorKeyringService,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const service = module.get<SignedCursorKeyringService>(SignedCursorKeyringService);

      expect(service.loadedVersions).toEqual([0, 1, 2]);
    });
  });
});
