import type { CdpTarget } from "./types.js";

export interface CdpVersionInfo {
  Browser?: string;
  "Protocol-Version"?: string;
  "webSocketDebuggerUrl"?: string;
}

async function fetchJson<T>(
  url: string,
  timeoutMs: number,
): Promise<{ ok: true; data: T } | { ok: false; error: string; aborted: boolean }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, error: `CDP HTTP ${res.status}`, aborted: false };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : "CDP request failed";
    const aborted = message.toLowerCase().includes("abort");
    return {
      ok: false,
      error: aborted ? "CDP unreachable (timeout)" : message,
      aborted,
    };
  }
}

/** GET {cdpUrl}/json/version */
export async function fetchCdpVersion(
  cdpUrl: string,
  timeoutMs = 2000,
): Promise<
  | { ok: true; data: CdpVersionInfo }
  | { ok: false; error: string; aborted: boolean }
> {
  return fetchJson<CdpVersionInfo>(`${cdpUrl}/json/version`, timeoutMs);
}

/** GET {cdpUrl}/json/list — Chrome DevTools target discovery. */
export async function fetchCdpTargetList(
  cdpUrl: string,
  timeoutMs = 2000,
): Promise<
  | { ok: true; data: CdpTarget[] }
  | { ok: false; error: string; aborted: boolean }
> {
  const result = await fetchJson<unknown>(`${cdpUrl}/json/list`, timeoutMs);
  if (!result.ok) return result;
  if (!Array.isArray(result.data)) {
    return { ok: false, error: "CDP /json/list returned non-array", aborted: false };
  }
  const targets: CdpTarget[] = result.data.map((raw, index) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const id =
      typeof row.id === "string" && row.id.length > 0
        ? row.id
        : `target_${index}`;
    return {
      id,
      title: typeof row.title === "string" ? row.title : "",
      type: typeof row.type === "string" ? row.type : "unknown",
      url: typeof row.url === "string" ? row.url : "",
      webSocketDebuggerUrl:
        typeof row.webSocketDebuggerUrl === "string"
          ? row.webSocketDebuggerUrl
          : undefined,
    };
  });
  return { ok: true, data: targets };
}

/**
 * Prefer page-like targets that look like IDE windows.
 * Graceful: if none match filters, still return page targets.
 */
export function selectWindowTargets(targets: CdpTarget[]): CdpTarget[] {
  const pages = targets.filter(
    (t) =>
      t.type === "page" ||
      t.type === "webview" ||
      Boolean(t.webSocketDebuggerUrl),
  );
  if (pages.length === 0) return targets;

  const ideLike = pages.filter((t) => {
    const hay = `${t.title} ${t.url}`.toLowerCase();
    return (
      hay.includes("cursor") ||
      hay.includes("vscode") ||
      hay.includes("workbench") ||
      t.url.startsWith("vscode-file://") ||
      t.url.startsWith("vscode-webview://")
    );
  });
  return ideLike.length > 0 ? ideLike : pages;
}
