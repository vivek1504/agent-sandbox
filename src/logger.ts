import { pino } from "pino";
import type { Options } from "pino-http";
import type { LoggerOptions } from "pino";

const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL || "debug",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-api-key']",
      "password",
      "token",
      "*.password",
      "*.token",
      "*.secret",
    ],
    censor: "[REDACTED]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

export const logger = pino(baseOptions);

export const vmLogger = logger.child({ module: "vm" });
export const sessionLogger = logger.child({ module: "session" });

export const httpLoggerOptions: Options = {
  logger: logger.child({ module: "http" }),
  autoLogging: {
    ignore: (req) =>
      req.url === "/health" || req.url === "/ready" || req.url === "/metrics",
  },
  customLogLevel: (_req, res, err) => {
    if (res.statusCode >= 500 || err) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage: (req, res) => {
    return `${req.method} ${req.url} completed with ${res.statusCode}`;
  },
  customErrorMessage: (req, _res, err) => {
    return `${req.method} ${req.url} errored: ${err.message}`;
  },
  customReceivedMessage: (req) => {
    return `${req.method} ${req.url} received`;
  },
  serializers: {
    req(req) {
      return {
        method: req.method,
        url: req.url,
        remoteAddress: req.remoteAddress,
        contentType: req.headers?.["content-type"],
      };
    },
    res(res) {
      return {
        statusCode: res.statusCode,
      };
    },
  },
};
