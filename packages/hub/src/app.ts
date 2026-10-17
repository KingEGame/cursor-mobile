import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { HubContext } from "./config.js";
import { ApiError, errorBody } from "./errors.js";
import { createApiRouter } from "./routes/api.js";
import { createPairPageRouter } from "./pair-page.js";

export function createApp(ctx: HubContext): Express {
  const app = express();
  app.disable("x-powered-by");
  // Agents chat routes may carry phone photos (base64); everything else keeps 256kb.
  app.use("/v1/agents", express.json({ limit: "12mb" }));
  app.use(express.json({ limit: "256kb" }));

  // One line per failed request and per write, so "the phone could not send" is visible in
  // `journalctl --user -u cursor-mobile-hub` with the exact Hub error code.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    let code = "";
    const json = res.json.bind(res);
    res.json = ((body: unknown) => {
      code = (body as { error?: { code?: string } } | null)?.error?.code ?? "";
      return json(body);
    }) as typeof res.json;
    res.on("finish", () => {
      const write = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
      if (res.statusCode < 400 && !write) return;
      const ua = String(req.headers["user-agent"] ?? "").slice(0, 40);
      console.log(
        `[hub] ${req.method} ${req.originalUrl.split("?")[0]} -> ${res.statusCode}${code ? ` ${code}` : ""} ${Date.now() - started}ms from ${req.ip} ${ua}`,
      );
    });
    next();
  });

  const api = createApiRouter(ctx);
  // TOR-03 versioned surface
  app.use("/v1", api);
  // PC-only pairing page with the QR for the phone camera (loopback-only).
  app.use(createPairPageRouter(ctx));
  // Unversioned aliases (AGENT-CONTEXT shorthand)
  app.use(api);

  app.use((_req, _res, next) => {
    next(new ApiError(404, "NOT_FOUND", "Route not found"));
  });

  app.use(
    (
      err: unknown,
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      if (err instanceof ApiError) {
        res.status(err.status).json(errorBody(err));
        return;
      }
      // express.json limit (256kb) — clear limit error for AC-030-04 large message
      const anyErr = err as { type?: string; status?: number; message?: string };
      if (
        anyErr?.type === "entity.too.large" ||
        anyErr?.status === 413 ||
        (typeof anyErr?.message === "string" &&
          /request entity too large/i.test(anyErr.message))
      ) {
        res.status(413).json({
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message:
              "Request body exceeds Hub JSON limit (256kb) — shorten the message",
          },
        });
        return;
      }
      console.error("[hub] unhandled error", err);
      res.status(500).json({
        error: {
          code: "INTERNAL",
          message: "Internal server error",
        },
      });
    },
  );

  return app;
}
