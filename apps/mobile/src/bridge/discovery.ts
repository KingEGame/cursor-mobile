/**
 * Find Hermes PCs on the phone's Wi-Fi: probe every host of the /24 for /v1/health on :8097.
 * Plain HTTP (no mDNS / UDP native modules); ~254 short requests, bounded concurrency.
 */
import * as Network from 'expo-network';
import { BridgeClient } from './client';
import { pool, subnetHosts } from './network';
import { DEFAULT_BRIDGE_PORT } from './types';

export interface FoundPc {
  url: string;
  name: string;
  hubId: string;
  devicesPaired: number;
}

export async function phoneLanIp(): Promise<string | null> {
  try {
    const state = await Network.getNetworkStateAsync();
    if (state.type !== Network.NetworkStateType.WIFI && state.type !== Network.NetworkStateType.ETHERNET) {
      return null;
    }
    const ip = await Network.getIpAddressAsync();
    return ip && ip !== '0.0.0.0' ? ip : null;
  } catch {
    return null;
  }
}

/** Resolves with every PC that answered; `onFound` fires as soon as each one does. */
export async function scanLan(opts: {
  port?: number;
  timeoutMs?: number;
  onFound?: (pc: FoundPc) => void;
} = {}): Promise<{ phoneIp: string | null; found: FoundPc[] }> {
  const phoneIp = await phoneLanIp();
  const hosts = subnetHosts(phoneIp);
  const port = opts.port ?? DEFAULT_BRIDGE_PORT;
  const seen = new Set<string>();
  const found = await pool(hosts, 48, async (host) => {
    const url = `http://${host}:${port}`;
    const h = await new BridgeClient({ baseUrl: url, timeoutMs: opts.timeoutMs ?? 1200 }).health();
    if (seen.has(h.hub.hubId)) return null; // same PC on two NICs
    seen.add(h.hub.hubId);
    const pc: FoundPc = { url, name: h.hub.displayName, hubId: h.hub.hubId, devicesPaired: h.pairing.devicesPaired };
    opts.onFound?.(pc);
    return pc;
  });
  return { phoneIp, found };
}
