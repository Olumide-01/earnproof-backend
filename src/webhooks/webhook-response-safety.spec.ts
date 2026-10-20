import { createHash } from "crypto";
import {
  processWebhookResponse,
  formatSafeWebhookResponse,
  SafeWebhookResponse,
  MAX_RESPONSE_BODY_BYTES,
} from "./webhook-response-safety";

describe("SafeWebhookResponse", () => {
  // -------------------------------------------------------------------------
  // Positive tests: valid responses
  // -------------------------------------------------------------------------
  describe("positive tests: valid responses", () => {
    it("processes a simple text response", () => {
      const response = "OK";
      const result = processWebhookResponse(response);

      expect(result.truncatedBody).toBe("OK");
      expect(result.wasTruncated).toBe(false);
      expect(result.hadEncodingIssue).toBe(false);
      expect(result.contentHash).toBe(
        createHash("sha256").update("OK", "utf8").digest("hex"),
      );
    });

    it("processes a JSON response", () => {
      const json = JSON.stringify({ status: "success", data: "value" });
      const result = processWebhookResponse(json);

      expect(result.truncatedBody).toBe(json);
      expect(result.wasTruncated).toBe(false);
      expect(result.hadEncodingIssue).toBe(false);
    });

    it("processes an empty response", () => {
      const response = "";
      const result = processWebhookResponse(response);

      expect(result.truncatedBody).toBe("");
      expect(result.wasTruncated).toBe(false);
      expect(result.hadEncodingIssue).toBe(false);
    });

    it("processes a response with newlines and special characters", () => {
      const response = "Line 1\nLine 2\nSpecial: <>&\"'";
      const result = processWebhookResponse(response);

      expect(result.truncatedBody).toBe(response);
      expect(result.wasTruncated).toBe(false);
      expect(result.hadEncodingIssue).toBe(false);
    });

    it("processes UTF-8 with multibyte characters", () => {
      const response = "Hello 世界 🌍";
      const result = processWebhookResponse(response);

      expect(result.truncatedBody).toBe(response);
      expect(result.wasTruncated).toBe(false);
      expect(result.hadEncodingIssue).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Negative tests: invalid/problematic responses
  // -------------------------------------------------------------------------
  describe("negative tests: invalid/problematic responses", () => {
    it("handles binary data as a Buffer", () => {
      // Buffer with some invalid UTF-8 sequences
      const buffer = Buffer.from([0xFF, 0xFE, 0x48, 0x65, 0x6C, 0x6C, 0x6F]);
      const result = processWebhookResponse(buffer);

      // Should not throw, and hadEncodingIssue should be true
      expect(result.hadEncodingIssue).toBe(true);
      expect(result.truncatedBody).toBeDefined();
      expect(typeof result.truncatedBody).toBe("string");
    });

    it("handles empty Buffer", () => {
      const buffer = Buffer.from([]);
      const result = processWebhookResponse(buffer);

      expect(result.truncatedBody).toBe("");
      expect(result.wasTruncated).toBe(false);
      expect(result.hadEncodingIssue).toBe(false);
    });

    it("detects encoding issues with invalid UTF-8 sequences", () => {
      // Valid UTF-8 header followed by invalid byte sequence
      const buffer = Buffer.from([0xC3, 0xFF, 0xFF]);
      const result = processWebhookResponse(buffer);

      expect(result.hadEncodingIssue).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Boundary tests: truncation limits
  // -------------------------------------------------------------------------
  describe("boundary tests: truncation limits", () => {
    it("does not truncate response at exactly MAX_RESPONSE_BODY_BYTES", () => {
      const response = "x".repeat(MAX_RESPONSE_BODY_BYTES);
      const result = processWebhookResponse(response);

      expect(result.truncatedBody).toBe(response);
      expect(result.wasTruncated).toBe(false);
      expect(result.truncatedBody.length).toBe(MAX_RESPONSE_BODY_BYTES);
    });

    it("truncates response just over MAX_RESPONSE_BODY_BYTES", () => {
      const response = "x".repeat(MAX_RESPONSE_BODY_BYTES + 1);
      const result = processWebhookResponse(response);

      expect(result.truncatedBody.length).toBe(MAX_RESPONSE_BODY_BYTES);
      expect(result.wasTruncated).toBe(true);
      expect(result.truncatedBody).toBe("x".repeat(MAX_RESPONSE_BODY_BYTES));
    });

    it("truncates large response and sets wasTruncated flag", () => {
      const response = "x".repeat(MAX_RESPONSE_BODY_BYTES + 100);
      const result = processWebhookResponse(response);

      expect(result.truncatedBody.length).toBe(MAX_RESPONSE_BODY_BYTES);
      expect(result.wasTruncated).toBe(true);
    });

    it("computes content hash on full response before truncation", () => {
      const response = "x".repeat(MAX_RESPONSE_BODY_BYTES + 100);
      const result = processWebhookResponse(response);

      // Hash should be computed on the full redacted response
      const fullHash = createHash("sha256")
        .update(response, "utf8")
        .digest("hex");
      expect(result.contentHash).toBe(fullHash);
      // But the body should be truncated
      expect(result.truncatedBody.length).toBe(MAX_RESPONSE_BODY_BYTES);
    });

    it("truncates at exactly 2x MAX_RESPONSE_BODY_BYTES", () => {
      const response = "y".repeat(MAX_RESPONSE_BODY_BYTES * 2);
      const result = processWebhookResponse(response);

      expect(result.truncatedBody.length).toBe(MAX_RESPONSE_BODY_BYTES);
      expect(result.wasTruncated).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Redaction tests: sensitive data patterns
  // -------------------------------------------------------------------------
  describe("redaction tests: sensitive data patterns", () => {
    it("redacts authorization headers", () => {
      const response = "Authorization: Bearer secret-token-123";
      const result = processWebhookResponse(response);

      expect(result.truncatedBody).toContain("[REDACTED]");
      expect(result.truncatedBody).not.toContain("secret-token-123");
    });

    it("redacts api_key patterns", () => {
      const response = 'api_key="secret-api-key-value"';
      const result = processWebhookResponse(response);

      expect(result.truncatedBody).toContain("[REDACTED]");
      expect(result.truncatedBody).not.toContain("secret-api-key-value");
    });

    it("redacts api-key patterns (with dash)", () => {
      const response = "api-key=super-secret-key";
      const result = processWebhookResponse(response);

      expect(result.truncatedBody).toContain("[REDACTED]");
      expect(result.truncatedBody).not.toContain("super-secret-key");
    });

    it("redacts password patterns", () => {
      const response = 'password: "my-secret-password"';
      const result = processWebhookResponse(response);

      expect(result.truncatedBody).toContain("[REDACTED]");
      expect(result.truncatedBody).not.toContain("my-secret-password");
    });

    it("redacts token patterns", () => {
      const response = "token=abc123xyz789";
      const result = processWebhookResponse(response);

      expect(result.truncatedBody).toContain("[REDACTED]");
      expect(result.truncatedBody).not.toContain("abc123xyz789");
    });

    it("redacts secret patterns", () => {
      const response = 'secret:"my-secret-value"';
      const result = processWebhookResponse(response);

      expect(result.truncatedBody).toContain("[REDACTED]");
      expect(result.truncatedBody).not.toContain("my-secret-value");
    });

    it("redacts multiple patterns in a single response", () => {
      const response =
        'api_key="key123" and Authorization: Bearer token456 and password="pass789"';
      const result = processWebhookResponse(response);

      expect(result.truncatedBody).not.toContain("key123");
      expect(result.truncatedBody).not.toContain("pass789");
      expect(result.truncatedBody).toContain("[REDACTED]");
    });

    it("redacts bearer tokens with base64 characters", () => {
      const response =
        "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
      const result = processWebhookResponse(response);

      expect(result.truncatedBody).toContain("[REDACTED]");
      expect(result.truncatedBody).not.toContain(
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      );
    });

    it("preserves non-sensitive content while redacting secrets", () => {
      const response =
        "Status: 200 OK\napi_key=secret123\nContent: important data";
      const result = processWebhookResponse(response);

      expect(result.truncatedBody).toContain("Status: 200 OK");
      expect(result.truncatedBody).toContain("Content: important data");
      expect(result.truncatedBody).not.toContain("secret123");
    });

    it("redacts case-insensitively", () => {
      const response =
        "TOKEN=secret1 Token=secret2 token=secret3 TOKEN:secret4";
      const result = processWebhookResponse(response);

      expect(result.truncatedBody).not.toContain("secret1");
      expect(result.truncatedBody).not.toContain("secret2");
      expect(result.truncatedBody).not.toContain("secret3");
      expect(result.truncatedBody).not.toContain("secret4");
      expect(result.truncatedBody).toContain("[REDACTED]");
    });
  });

  // -------------------------------------------------------------------------
  // Encoding tests: various character encodings
  // -------------------------------------------------------------------------
  describe("encoding tests: character encodings", () => {
    it("preserves UTF-8 emoji in response", () => {
      const response = "Result: Success 🎉🚀";
      const result = processWebhookResponse(response);

      expect(result.truncatedBody).toBe(response);
      expect(result.hadEncodingIssue).toBe(false);
    });

    it("handles Latin-1 characters", () => {
      const response = "Café naïve";
      const result = processWebhookResponse(response);

      expect(result.truncatedBody).toBe(response);
      expect(result.hadEncodingIssue).toBe(false);
    });

    it("handles Cyrillic characters", () => {
      const response = "Привет мир";
      const result = processWebhookResponse(response);

      expect(result.truncatedBody).toBe(response);
      expect(result.hadEncodingIssue).toBe(false);
    });

    it("handles Chinese characters", () => {
      const response = "你好世界";
      const result = processWebhookResponse(response);

      expect(result.truncatedBody).toBe(response);
      expect(result.hadEncodingIssue).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Regression tests: complex scenarios
  // -------------------------------------------------------------------------
  describe("regression tests: complex scenarios", () => {
    it("handles response with both truncation and redaction", () => {
      const sensitiveContent = 'api_key="secret123"';
      const response = `${sensitiveContent} ${" ".repeat(MAX_RESPONSE_BODY_BYTES)}`;
      const result = processWebhookResponse(response);

      expect(result.wasTruncated).toBe(true);
      expect(result.truncatedBody).not.toContain("secret123");
      expect(result.truncatedBody).toContain("[REDACTED]");
    });

    it("handles response with both encoding issues and redaction", () => {
      // Create a buffer with invalid UTF-8 and then add a secret pattern
      const invalidUtf8 = Buffer.from([0xFF, 0xFE]);
      const validUtf8 = Buffer.from('api_key="secret"');
      const combined = Buffer.concat([invalidUtf8, validUtf8]);

      const result = processWebhookResponse(combined);

      expect(result.hadEncodingIssue).toBe(true);
      expect(result.truncatedBody).not.toContain("secret");
    });

    it("handles HTML response with embedded secrets", () => {
      const response = `
        <html>
          <body>
            <p>Token: xyz123</p>
            <script>const token = "secret_abc123_xyz";</script>
          </body>
        </html>
      `;
      const result = processWebhookResponse(response);

      expect(result.truncatedBody).not.toContain("secret_abc123_xyz");
      expect(result.truncatedBody).toContain("<html>");
    });

    it("preserves different types of content", () => {
      const responses = [
        "plain text",
        '{"json": "object"}',
        "<xml>tag</xml>",
        "123.456",
      ];

      for (const response of responses) {
        const result = processWebhookResponse(response);
        expect(result.hadEncodingIssue).toBe(false);
        expect(result.contentHash).toBeDefined();
      }
    });

    it("content hash is stable across multiple calls", () => {
      const response = "consistent-response-body";
      const result1 = processWebhookResponse(response);
      const result2 = processWebhookResponse(response);

      expect(result1.contentHash).toBe(result2.contentHash);
    });

    it("different responses produce different hashes", () => {
      const response1 = "response-one";
      const response2 = "response-two";
      const result1 = processWebhookResponse(response1);
      const result2 = processWebhookResponse(response2);

      expect(result1.contentHash).not.toBe(result2.contentHash);
    });

    it("redacted response has different hash than non-redacted", () => {
      const withoutSecret = "api_key=[REDACTED]";
      const withSecret = 'api_key="secret123"';

      const result1 = processWebhookResponse(withoutSecret);
      const result2 = processWebhookResponse(withSecret);

      // After redaction, result2 should have redacted content
      expect(result2.truncatedBody).toContain("[REDACTED]");
      expect(result2.truncatedBody).not.toContain("secret123");
    });
  });

  // -------------------------------------------------------------------------
  // Formatting tests
  // -------------------------------------------------------------------------
  describe("formatting tests", () => {
    it("formats a non-truncated response", () => {
      const response: SafeWebhookResponse = {
        truncatedBody: "OK",
        contentHash: "abc123",
        wasTruncated: false,
        hadEncodingIssue: false,
      };

      const formatted = formatSafeWebhookResponse(response);
      expect(formatted).toBe("OK");
    });

    it("formats a truncated response with flag", () => {
      const response: SafeWebhookResponse = {
        truncatedBody: "long response...",
        contentHash: "abc123",
        wasTruncated: true,
        hadEncodingIssue: false,
      };

      const formatted = formatSafeWebhookResponse(response);
      expect(formatted).toContain("long response...");
      expect(formatted).toContain("…[truncated]");
    });

    it("formats a response with encoding issue", () => {
      const response: SafeWebhookResponse = {
        truncatedBody: "corrupted data",
        contentHash: "abc123",
        wasTruncated: false,
        hadEncodingIssue: true,
      };

      const formatted = formatSafeWebhookResponse(response);
      expect(formatted).toContain("corrupted data");
      expect(formatted).toContain("[encoding issue detected]");
    });

    it("formats a response with both truncation and encoding issue", () => {
      const response: SafeWebhookResponse = {
        truncatedBody: "corrupted truncated...",
        contentHash: "abc123",
        wasTruncated: true,
        hadEncodingIssue: true,
      };

      const formatted = formatSafeWebhookResponse(response);
      expect(formatted).toContain("corrupted truncated...");
      expect(formatted).toContain("…[truncated]");
      expect(formatted).toContain("[encoding issue detected]");
    });
  });
});
