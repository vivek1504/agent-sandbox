import { app } from "./app.js";
import { logger } from "./logger.js";
import { ensureHostNetworkSetup } from "./vm/networking.js";

const PORT = process.env.PORT || 3000;

try {
  ensureHostNetworkSetup();
} catch (err) {
  logger.warn({ err }, "host network setup check failed — VMs may not have internet access");
}

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception — shutting down");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandled rejection");
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, `server listening on http://localhost:${PORT}`);
});
