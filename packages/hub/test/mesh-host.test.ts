import { describe, expect, it } from "vitest";
import { loadConfig, baseUrlHint, buildQrPayload } from "../src/config.js";
import { detectTailscaleIp, isTailscaleIp } from "../src/mesh-host.js";

const iface = (address: string, internal = false) => ({ address, family: "IPv4" as const, internal, netmask: "", mac: "", cidr: null });

describe("Tailscale address detection (no CLI needed)", () => {
  it("recognizes the 100.64.0.0/10 range", () => {
    expect(isTailscaleIp("100.64.0.1")).toBe(true);
    expect(isTailscaleIp("100.127.255.254")).toBe(true);
    expect(isTailscaleIp("100.63.0.1")).toBe(false);
    expect(isTailscaleIp("100.128.0.1")).toBe(false);
    expect(isTailscaleIp("192.168.1.5")).toBe(false);
    expect(isTailscaleIp("not an ip")).toBe(false);
  });

  it("finds the Tailscale interface by address on Windows-style names", () => {
    const ifaces = {
      "Ethernet 2": [iface("192.168.1.20")],
      Tailscale: [iface("100.108.160.99")],
      "Loopback Pseudo-Interface 1": [iface("127.0.0.1", true)],
    };
    expect(detectTailscaleIp(ifaces)).toBe("100.108.160.99");
  });

  it("prefers a Tailscale-named interface over another 100.64/10 address", () => {
    const ifaces = { wwan0: [iface("100.72.0.9")], tailscale0: [iface("100.101.1.1")] };
    expect(detectTailscaleIp(ifaces)).toBe("100.101.1.1");
  });

  it("returns null when Tailscale is not running", () => {
    expect(detectTailscaleIp({ eth0: [iface("10.0.0.4")] })).toBeNull();
  });
});

describe("pairing address", () => {
  const config = loadConfig({ HUB_HOST: "0.0.0.0", HUB_PORT: "8787", CDP_URL: "http://127.0.0.1:9222", HUB_DATA_DIR: "none" });

  it("uses the detected Tailscale IP when no hostname is configured (the Windows desktop case)", () => {
    expect(baseUrlHint(config, () => "100.108.160.99")).toBe("http://100.108.160.99:8787");
    const qr = buildQrPayload(config, { code: "123456", pairId: "p1" } as never, () => "100.108.160.99");
    expect(qr).toContain("host=100.108.160.99");
    expect(qr).not.toContain("127.0.0.1");
  });

  it("prefers an explicit TAILSCALE_HOSTNAME", () => {
    const withHost = loadConfig({ HUB_HOST: "0.0.0.0", TAILSCALE_HOSTNAME: "pc.tail1.ts.net", CDP_URL: "http://127.0.0.1:9222", HUB_DATA_DIR: "none" });
    expect(baseUrlHint(withHost, () => "100.1.1.1")).toBe("http://pc.tail1.ts.net:8787");
  });

  it("falls back to loopback only when Tailscale is really absent", () => {
    expect(baseUrlHint(config, () => null)).toBe("http://127.0.0.1:8787");
  });
});
