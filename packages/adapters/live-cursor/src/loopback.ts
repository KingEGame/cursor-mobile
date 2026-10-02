/**
 * CDP must remain on loopback — phone never dials CDP (product lock).
 */

export function assertLoopbackCdpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid CDP_URL: ${url}`);
  }
  const host = parsed.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(
      `CDP_URL must be loopback only (got host "${host}"). Phone must never dial CDP.`,
    );
  }
}

export function normalizeCdpUrl(url: string): string {
  assertLoopbackCdpUrl(url);
  return url.replace(/\/$/, "");
}
