import { app } from "./app.js";
import { logger } from "./logger.js";
import { ensureHostNetworkSetup } from "./vm/networking.js";
import { vmResourceConfig } from "./metrics.js";
import { loadResourceConfig } from "./vm/jailer.js";

const PORT = process.env.PORT || 3000;

try {
  ensureHostNetworkSetup();
} catch (err) {
  logger.warn({ err }, "host network setup check failed — VMs may not have internet access");
}

try {
  const config = loadResourceConfig();
  vmResourceConfig.set({ resource: "vcpu_count" }, config.vcpuCount);
  vmResourceConfig.set({ resource: "mem_size_mib" }, config.memSizeMib);
  vmResourceConfig.set({ resource: "cpu_quota_us" }, config.cpuQuotaUs);
  vmResourceConfig.set({ resource: "cpu_period_us" }, config.cpuPeriodUs);
  vmResourceConfig.set({ resource: "memory_limit_bytes" }, config.memoryLimitBytes);
  vmResourceConfig.set({ resource: "no_file_soft_limit" }, config.noFileSoftLimit);
  if (config.diskLimitBytes !== undefined) {
    vmResourceConfig.set({ resource: "disk_limit_bytes" }, config.diskLimitBytes);
  }
} catch (err) {
  logger.warn({ err }, "failed to set vm resource metrics");
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
