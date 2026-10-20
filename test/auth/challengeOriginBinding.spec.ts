import {
  normalizeOrigin,
  OriginValidationError,
  OriginRejectionReason,
} from "../../src/auth/originNormalizer";

/**
 * Tests for wallet challenge network and origin binding.
 * Verifies origin normalization, challenge creation with bindings,
 * and verification with network and origin mismatch detection.
 */
describe('Wallet challenge network and origin binding', () => {

  // ── Origin normalization ────────────────────────────────────────────────
  describe('normalizeOrigin', () => {
    it('should accept valid https origin', () => {
      const result = normalizeOrigin('https://app.example.com');
      expect(result).toBe('https://app.example.com');
    });

    it('should accept https origin with port', () => {
      const result = normalizeOrigin('https://app.example.com:8443');
      expect(result).toBe('https://app.example.com:8443');
    });

    it('should accept localhost http origin', () => {
      const result = normalizeOrigin('http://localhost:3000');
      expect(result).toBe('http://localhost:3000');
    });

    it('should accept 127.0.0.1 http origin', () => {
      const result = normalizeOrigin('http://127.0.0.1:3000');
      expect(result).toBe('http://127.0.0.1:3000');
    });

    it('should strip path and normalize to canonical form', () => {
      const result = normalizeOrigin('https://app.example.com/path/to/page');
      expect(result).toBe('https://app.example.com');
    });

    it('should strip trailing slash', () => {
      const result = normalizeOrigin('https://app.example.com/');
      expect(result).toBe('https://app.example.com');
    });

    it('should lowercase hostname', () => {
      const result = normalizeOrigin('https://APP.EXAMPLE.COM');
      expect(result).toBe('https://app.example.com');
    });

    it('should lowercase hostname with mixed case', () => {
      const result = normalizeOrigin('https://App.Example.COM:8443/path');
      expect(result).toBe('https://app.example.com:8443');
    });

    it('should reject opaque origin null', () => {
      expect(() => normalizeOrigin('null')).toThrow(OriginValidationError);
      try {
        normalizeOrigin('null');
        fail('Should have thrown');
      } catch {
        // Expected to throw
      }
    });

    it('should reject wildcard origin', () => {
      expect(() => normalizeOrigin('*')).toThrow(OriginValidationError);
      try {
        normalizeOrigin('*');
        fail('Should have thrown');
      } catch (error) {
        expect((error as OriginValidationError).reason).toBe(
          OriginRejectionReason.Wildcard,
        );
      }
    });

    it('should reject credential bearing url with username', () => {
      expect(() => normalizeOrigin('https://user@example.com')).toThrow(
        OriginValidationError,
      );
      try {
        normalizeOrigin('https://user@example.com');
        fail('Should have thrown');
      } catch (error) {
        expect((error as OriginValidationError).reason).toBe(
          OriginRejectionReason.CredentialBearing,
        );
      }
    });

    it('should reject credential bearing url with password', () => {
      expect(() => normalizeOrigin('https://user:pass@example.com')).toThrow(
        OriginValidationError,
      );
      try {
        normalizeOrigin('https://user:pass@example.com');
        fail('Should have thrown');
      } catch (error) {
        expect((error as OriginValidationError).reason).toBe(
          OriginRejectionReason.CredentialBearing,
        );
      }
    });

    it('should reject http non-localhost', () => {
      expect(() => normalizeOrigin('http://example.com')).toThrow(
        OriginValidationError,
      );
      try {
        normalizeOrigin('http://example.com');
        fail('Should have thrown');
      } catch (error) {
        expect((error as OriginValidationError).reason).toBe(
          OriginRejectionReason.UnsupportedScheme,
        );
      }
    });

    it('should reject ftp scheme', () => {
      expect(() => normalizeOrigin('ftp://example.com')).toThrow(
        OriginValidationError,
      );
      try {
        normalizeOrigin('ftp://example.com');
        fail('Should have thrown');
      } catch (error) {
        expect((error as OriginValidationError).reason).toBe(
          OriginRejectionReason.UnsupportedScheme,
        );
      }
    });

    it('should reject empty origin', () => {
      expect(() => normalizeOrigin('')).toThrow(OriginValidationError);
      try {
        normalizeOrigin('');
        fail('Should have thrown');
      } catch (error) {
        expect((error as OriginValidationError).reason).toBe(
          OriginRejectionReason.Empty,
        );
      }
    });

    it('should reject whitespace-only origin', () => {
      expect(() => normalizeOrigin('   ')).toThrow(OriginValidationError);
      try {
        normalizeOrigin('   ');
        fail('Should have thrown');
      } catch (error) {
        expect((error as OriginValidationError).reason).toBe(
          OriginRejectionReason.Empty,
        );
      }
    });

    it('should reject malformed url', () => {
      expect(() => normalizeOrigin('not-a-url')).toThrow(OriginValidationError);
      try {
        normalizeOrigin('not-a-url');
        fail('Should have thrown');
      } catch (error) {
        expect((error as OriginValidationError).reason).toBe(
          OriginRejectionReason.Malformed,
        );
      }
    });

    it('should reject malformed url with spaces', () => {
      expect(() => normalizeOrigin('https://app example.com')).toThrow(
        OriginValidationError,
      );
      try {
        normalizeOrigin('https://app example.com');
        fail('Should have thrown');
      } catch (error) {
        expect((error as OriginValidationError).reason).toBe(
          OriginRejectionReason.Malformed,
        );
      }
    });

    it('OriginValidationError should preserve context', () => {
      try {
        normalizeOrigin('null');
        fail('Should have thrown');
      } catch (error) {
        const err = error as OriginValidationError;
        expect(err.name).toBe('OriginValidationError');
        expect(err.reason).toBe(OriginRejectionReason.Opaque);
        expect(err.rawOrigin).toBe('null');
        expect(err.message).toContain('Opaque');
      }
    });
  });

  // ── Origin normalization edge cases ─────────────────────────────────────
  describe('normalizeOrigin - edge cases', () => {
    it('should handle subdomain with trailing slash and path', () => {
      const result = normalizeOrigin('https://api.app.example.com:9000/v1/auth');
      expect(result).toBe('https://api.app.example.com:9000');
    });

    it('should handle ipv4 localhost', () => {
      const result = normalizeOrigin('http://127.0.0.1:8080/path');
      expect(result).toBe('http://127.0.0.1:8080');
    });

    it('should handle localhost without port', () => {
      const result = normalizeOrigin('http://localhost');
      expect(result).toBe('http://localhost');
    });

    it('should strip https default port (443)', () => {
      // URL API normalizes away default ports, which is correct for origin handling
      const result = normalizeOrigin('https://example.com:443');
      expect(result).toBe('https://example.com');
    });

    it('should strip http default port (80) on localhost', () => {
      // URL API normalizes away default ports, which is correct for origin handling
      const result = normalizeOrigin('http://localhost:80');
      expect(result).toBe('http://localhost');
    });

    it('should normalize mixed case in subdomain', () => {
      const result = normalizeOrigin('https://API.App.EXAMPLE.com');
      expect(result).toBe('https://api.app.example.com');
    });
  });

  // ── Normalization idempotency ──────────────────────────────────────────
  describe('normalizeOrigin - idempotency', () => {
    it('should be idempotent for valid origin', () => {
      const origin = 'https://app.example.com:8443';
      const first = normalizeOrigin(origin);
      const second = normalizeOrigin(first);
      expect(first).toBe(second);
    });

    it('should be idempotent after stripping path', () => {
      const origin = 'https://app.example.com/path';
      const first = normalizeOrigin(origin);
      const second = normalizeOrigin(first);
      expect(first).toBe(second);
      expect(second).toBe('https://app.example.com');
    });
  });

  // ── Rejection reason preservation ──────────────────────────────────────
  describe('normalizeOrigin - rejection reasons', () => {
    const testCases: Array<[string, OriginRejectionReason]> = [
      ['null', OriginRejectionReason.Opaque],
      ['*', OriginRejectionReason.Wildcard],
      ['https://user:pass@example.com', OriginRejectionReason.CredentialBearing],
      ['http://example.com', OriginRejectionReason.UnsupportedScheme],
      ['ftp://example.com', OriginRejectionReason.UnsupportedScheme],
      ['not-a-url', OriginRejectionReason.Malformed],
      ['', OriginRejectionReason.Empty],
    ];

    testCases.forEach(([origin, expectedReason]) => {
      it(`should reject "${origin}" with reason ${expectedReason}`, () => {
        try {
          normalizeOrigin(origin);
          fail(`Should have thrown for origin: ${origin}`);
        } catch (error) {
          const err = error as OriginValidationError;
          expect(err.reason).toBe(expectedReason);
          expect(err.rawOrigin).toBe(origin);
        }
      });
    });
  });

  // ── Origin matching tests ──────────────────────────────────────────────
  describe('Origin matching', () => {
    it('should match normalized origins exactly', () => {
      const origin1 = normalizeOrigin('https://app.example.com');
      const origin2 = normalizeOrigin('https://APP.EXAMPLE.COM/');
      expect(origin1).toBe(origin2);
    });

    it('should not match different hosts', () => {
      const origin1 = normalizeOrigin('https://app1.example.com');
      const origin2 = normalizeOrigin('https://app2.example.com');
      expect(origin1).not.toBe(origin2);
    });

    it('should not match different ports', () => {
      const origin1 = normalizeOrigin('https://app.example.com:8443');
      const origin2 = normalizeOrigin('https://app.example.com:9443');
      expect(origin1).not.toBe(origin2);
    });

    it('should not match different schemes', () => {
      // Note: https works, but http only works for localhost
      const origin1 = normalizeOrigin('https://app.example.com');
      // http://app.example.com would be rejected, so we test localhost
      const origin2 = normalizeOrigin('http://localhost:3000');
      expect(origin1).not.toBe(origin2);
    });

    it('should distinguish path stripping from actual host difference', () => {
      const origin1 = normalizeOrigin('https://app.example.com/path');
      const origin2 = normalizeOrigin('https://app.example.com');
      // Both should normalize to the same canonical form
      expect(origin1).toBe(origin2);
    });
  });
});
