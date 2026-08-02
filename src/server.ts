import { app } from "./app.js";
import { logger } from "./logger.js";

const PORT = process.env.PORT || 3000;

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
