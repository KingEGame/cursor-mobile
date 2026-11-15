/**
 * Pure address logic: which PC address to use right now, and which hosts to probe on this Wi-Fi.
 * Unit-tested; no React Native imports.
 */
import { normalizeBaseUrl } from './client';

export type AddressKind = 'lan' | 'tailscale' | 'name';

export function hostOf(url: string): string {
  const m = /^https?:\/\/(\[[^\]]+\]|[^/:]+)/i.exec(url.trim());
  return m ? m[1]!.toLowerCase() : '';
}

function ipv4(host: string): number[] | null {
  const p = host.split('.');
  if (p.length !== 4) return null;
  const n = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? n : null;
}

export function addressKind(url: string): AddressKind {
  const ip = ipv4(hostOf(url));
  if (!ip) return 'name';
  const [a, b] = ip as [number, number, number, number];
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale'; // CGNAT range Tailscale uses
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'lan';
  return 'name';
}

/** LAN first (fastest, works with VPN off), then the Tailscale IP, then MagicDNS names. */
export function rankAddresses(urls: Array<string | null | undefined>): string[] {
  const order: Record<AddressKind, number> = { lan: 0, tailscale: 1, name: 2 };
  const uniq = [...new Set(urls.filter((u): u is string => !!u).map(normalizeBaseUrl).filter(Boolean))];
  return uniq.sort((x, y) => order[addressKind(x)] - order[addressKind(y)]);
}

export function mergeAddresses(...lists: Array<Array<string | null | undefined> | null | undefined>): string[] {
  return rankAddresses(lists.flatMap((l) => l ?? []));
}

/** Probe results (url → reachable) → the best reachable address, honouring rank. */
export function pickBest(ranked: string[], reachable: Set<string>): string | null {
  return ranked.find((u) => reachable.has(u)) ?? null;
}

/** All other hosts of a private /24 (the phone's own Wi-Fi), or [] for non-LAN addresses. */
export function subnetHosts(phoneIp: string | null | undefined): string[] {
  const ip = ipv4((phoneIp ?? '').trim());
  if (!ip || addressKind(`http://${phoneIp}`) !== 'lan') return [];
  const [a, b, c, d] = ip as [number, number, number, number];
  const out: string[] = [];
  for (let i = 1; i <= 254; i++) if (i !== d) out.push(`${a}.${b}.${c}.${i}`);
  return out;
}

/** Run `fn` over items with bounded concurrency; results in completion order. */
export async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R | null>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++]!;
      const r = await fn(item).catch(() => null);
      if (r != null) out.push(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
