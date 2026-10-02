import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { HubContext } from "./config.js";
import { ApiError, errorBody } from "./errors.js";
import { createApiRouter } from "./routes/api.js";

export function createApp(ctx: HubContext): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  const api = createApiRouter(ctx);
  // TOR-03 versioned surface
  app.use("/v1", api);
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
