export const SESSION_DEVICE_LABEL_MAX_LENGTH = 80;

export type SessionDeviceHeaders = Partial<
  Record<"user-agent" | "sec-ch-ua-platform" | "sec-ch-ua-mobile", string | string[] | undefined>
>;

/**
 * Convert a small, explicitly allowlisted header subset into a coarse label.
 * No source header is returned, logged, or persisted.
 */
export function deriveDeviceLabel(
  headers: SessionDeviceHeaders | undefined,
): string {
  const userAgent = boundedHeader(headers?.["user-agent"]);
  const platformHeader = boundedHeader(headers?.["sec-ch-ua-platform"]);
  const mobileHeader = boundedHeader(headers?.["sec-ch-ua-mobile"]);

  const browser = identifyBrowser(userAgent);
  const platform = identifyPlatform(platformHeader, userAgent);
  const formFactor = mobileHeader === "?1" || /mobile/i.test(userAgent)
    ? "Mobile"
    : "Desktop";

  return escapeLabel([browser, platform, formFactor].filter(Boolean).join(" / ") || "Unknown device");
}

/** Escape labels before persistence and cap them to the public contract. */
export function escapeLabel(value: string): string {
  return value
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .slice(0, SESSION_DEVICE_LABEL_MAX_LENGTH);
}

function boundedHeader(value: string | string[] | undefined): string {
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === "string" && single.length <= 512 ? single : "";
}

function identifyBrowser(userAgent: string): string {
  if (/edg\//i.test(userAgent)) return "Edge";
  if (/firefox\//i.test(userAgent)) return "Firefox";
  if (/chrome\//i.test(userAgent) || /crios\//i.test(userAgent)) return "Chrome";
  if (/safari\//i.test(userAgent) && !/chrome|crios/i.test(userAgent)) return "Safari";
  if (/electron\//i.test(userAgent)) return "Electron";
  return "Browser";
}

function identifyPlatform(platformHeader: string, userAgent: string): string {
  const value = `${platformHeader} ${userAgent}`;
  if (/android/i.test(value)) return "Android";
  if (/iphone|ipad|ios/i.test(value)) return "iOS";
  if (/macintosh|mac os|macos/i.test(value)) return "macOS";
  if (/windows/i.test(value)) return "Windows";
  if (/linux/i.test(value)) return "Linux";
  return "Unknown platform";
}
