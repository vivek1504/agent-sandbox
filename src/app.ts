import express from "express";
import { pinoHttp } from "pino-http";
import crypto from "crypto";
import { httpLoggerOptions } from "./logger.js";
import { register, httpRequestDuration, httpRequestsTotal } from "./metrics.js";
import { execRouter } from "./routes/exec.js";
import { mcpRouter } from "./mcp/routes.js";
import { startSessionReaper } from "./session/session.js";

export const app = express();

app.use((req, _res, next) => {
  req.id = req.headers["x-request-id"] || crypto.randomUUID();
  next();
});
app.use(pinoHttp(httpLoggerOptions));

app.use((req, res, next) => {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationSec =
      Number(process.hrtime.bigint() - start) / 1_000_000_000;
    const route = req.route?.path || req.path || "unknown";
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    };
    httpRequestDuration.observe(labels, durationSec);
    httpRequestsTotal.inc(labels);
  });

  next();
});

app.use('/mcp', mcpRouter);
app.use(express.json());
app.use("/exec", execRouter)

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.get("/ready", (_req, res) => {
  const checks = {
    memoryOk: process.memoryUsage().heapUsed < 500 * 1024 * 1024,
  };
  const healthy = Object.values(checks).every(Boolean);
  res
    .status(healthy ? 200 : 503)
    .json({ status: healthy ? "ready" : "not_ready", checks });
});

startSessionReaper()
