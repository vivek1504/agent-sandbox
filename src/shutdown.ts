import type { Server } from "http";
import { getAllSessions, destroySession } from "./session/session.js";
import { flushKeys } from "./auth/key-store.js";
import { logger } from "./logger.js";

let shutdownInProgress = false;

export function installShutdownHandler(httpServer: Server): void {
  const shutdown = async (signal: string) => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;

    logger.info({ signal }, "graceful shutdown initiated");

    httpServer.close();

    const timer = setTimeout(() => {
      logger.error("graceful shutdown timed out after 30s — forcing exit");
      process.exit(1);
    }, 30000);
    timer.unref();

    const sessions = getAllSessions();
    logger.info({ count: sessions.length }, "draining active sessions");

    const results = await Promise.allSettled(
      sessions.map((s) => destroySession(s.sessionId)),
    );

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      logger.error({ failedCount: failed.length }, "some sessions failed to drain during shutdown");
    }

    try {
      flushKeys();
    } catch (err) {
      logger.warn({ err }, "failed to flush API keys during shutdown");
    }

    logger.info("graceful shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
