import type { Request, RequestHandler } from "express";
import { ApiError } from "./errors.js";

/**
 * TOR-03: `POST /pair/start` is `local` auth — PC loopback / operator only.
 * Phone must never start pairing over Tailscale; it only completes with a code.
 *
 * Missing/empty remoteAddress is treated as in-process (supertest / same-process)
 * so unit tests keep working; real TCP clients always present an address.
 */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (addr == null || addr.trim() === "") {
    return true;
  }
  let normalized = addr.trim().toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    normalized = normalized.slice("::ffff:".length);
  }
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}

/** Best-effort client address for local-only routes (do not trust X-Forwarded-For). */
export function clientRemoteAddress(req: Request): string | undefined {
  const socketAddr = req.socket?.remoteAddress;
  if (socketAddr) return socketAddr;
  // Express may populate req.ip when trust proxy is configured; still prefer socket.
  if (typeof req.ip === "string" && req.ip.length > 0) return req.ip;
  return undefined;
}

export function isLocalClient(req: Request): boolean {
  return isLoopbackAddress(clientRemoteAddress(req));
}

/**
 * Reject non-loopback callers with 403 FORBIDDEN (TOR-03 local routes).
 */
export function requireLocal(): RequestHandler {
  return (req, _res, next) => {
    if (!isLocalClient(req)) {
      next(
        new ApiError(
          403,
          "FORBIDDEN",
          "pair/start is local-only (PC loopback / operator). Use pair/complete from the phone.",
        ),
      );
      return;
    }
    next();
  };
}

/**
 * Synthetic UAT approvals: localhost always, or HUB_ALLOW_SYNTHETIC_APPROVALS=1.
 */
export function requireLocalOrSyntheticFlag(
  allowSyntheticApprovals: boolean,
): RequestHandler {
  return (req, _res, next) => {
    if (isLocalClient(req) || allowSyntheticApprovals) {
      next();
      return;
    }
    next(
      new ApiError(
        403,
        "FORBIDDEN",
        "Synthetic approvals require PC loopback or HUB_ALLOW_SYNTHETIC_APPROVALS=1",
      ),
    );
  };
}
