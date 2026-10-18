/**
 * Finding this PC's Tailscale address without the `tailscale` CLI.
 *
 * Tailscale always assigns IPv4 addresses from 100.64.0.0/10 to its interface, on every OS.
 * Reading the network interfaces works on Windows (where the CLI is usually not on PATH),
 * macOS and Linux, needs no child process, and is instant, so it is safe to call whenever a
 * pairing QR or health answer is built.
 */

import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** 100.64.0.0 – 100.127.255.255 (carrier-grade NAT range Tailscale uses). */
export function isTailscaleIp(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 100 && b >= 64 && b <= 127;
}

/** First Tailscale IPv4 on this machine, preferring an interface that is named like Tailscale. */
export function detectTailscaleIp(ifaces: Interfaces = networkInterfaces()): string | null {
  let fallback: string | null = null;
  for (const [name, list] of Object.entries(ifaces)) {
    for (const info of list ?? []) {
      if (info.family !== "IPv4" || info.internal || !isTailscaleIp(info.address)) continue;
      if (/tailscale|^utun\d*$/i.test(name)) return info.address;
      fallback ??= info.address;
    }
  }
  return fallback;
}
