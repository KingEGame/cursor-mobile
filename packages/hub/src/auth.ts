import type { RequestHandler } from "express";
import type { HubContext, PairedDevice } from "./config.js";
import { ApiError } from "./errors.js";

declare module "express-serve-static-core" {
  interface Request {
    pairedDevice?: PairedDevice;
  }
}

export function requirePaired(ctx: HubContext): RequestHandler {
  return (req, _res, next) => {
    if (!ctx.config.pairingRequired) {
      next();
      return;
    }
    const header = req.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      next(
        new ApiError(401, "UNAUTHORIZED", "Bearer device token required"),
      );
      return;
    }
    const token = header.slice("Bearer ".length).trim();
    const device = ctx.pairing.authenticate(token);
    if (!device) {
      next(new ApiError(401, "DEVICE_REVOKED", "Invalid or revoked device token"));
      return;
    }
    req.pairedDevice = device;
    next();
  };
}
