import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { vmLogger } from "../logger.js";
import { loadManifest, clearManifest } from "../session/manifest.js";
import { JAIL_BASE_DIR } from "./jailer.js";
import { cleanupStaleNetworkResources } from "./networking.js";

export function sweepOrphanedResources(): void {
  vmLogger.info("starting orphan resource sweep");

  killOrphanedProcesses("firecracker");
  killOrphanedProcesses("jailer");

  sweepJailDirectories();

  cleanupStaleNetworkResources();

  sweepCgroupDirectories();

  try {
    const staleEntries = loadManifest();
    if (staleEntries.length > 0) {
      vmLogger.info(
        { count: staleEntries.length, sessions: staleEntries.map((e) => e.sessionId) },
        "clearing stale manifest entries from previous run",
      );
      clearManifest();
    }
  } catch (err) {
    vmLogger.warn({ err }, "failed to read or clear stale manifest during sweep");
  }

  vmLogger.info("orphan resource sweep complete");
}

export function killOrphanedProcesses(name: string): void {
  try {
    const pids = execSync(`pgrep -x ${name}`, { encoding: "utf-8" })
      .trim()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const currentPid = process.pid;

    for (const pidStr of pids) {
      const pid = Number(pidStr);
      if (pid === currentPid || isNaN(pid)) continue;

      try {
        process.kill(pid, "SIGKILL");
        vmLogger.info({ pid, process: name }, "killed orphaned process");
      } catch (err: any) {
        if (err?.code === "ESRCH") {
          vmLogger.debug({ pid, process: name }, "could not kill process (may have already exited)");
        } else {
          vmLogger.warn({ pid, process: name, err }, "failed to kill orphaned process");
        }
      }
    }
  } catch {
    // pgrep returns non-zero status code when no process matches — expected
  }
}

export function sweepJailDirectories(): void {
  const jailParent = path.join(JAIL_BASE_DIR, "firecracker");
  if (!fs.existsSync(jailParent)) return;

  try {
    const dirs = fs.readdirSync(jailParent);
    if (dirs.length === 0) return;

    vmLogger.info(
      { count: dirs.length, jails: dirs },
      "removing orphaned jail directories",
    );

    for (const dir of dirs) {
      const fullPath = path.join(jailParent, dir);
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
        vmLogger.debug({ path: fullPath }, "removed orphaned jail");
      } catch (err) {
        vmLogger.warn({ path: fullPath, err }, "failed to remove orphaned jail");
      }
    }
  } catch (err) {
    vmLogger.warn({ err }, "failed to read jail parent directory during sweep");
  }
}

export function sweepCgroupDirectories(): void {
  const cgroupParents = [
    "/sys/fs/cgroup/firecracker",
    "/sys/fs/cgroup/cpu/firecracker",
    "/sys/fs/cgroup/memory/firecracker",
  ];

  for (const parentDir of cgroupParents) {
    try {
      if (!fs.existsSync(parentDir)) continue;
      const entries = fs.readdirSync(parentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(parentDir, entry.name);
        try {
          fs.rmdirSync(fullPath);
          vmLogger.debug({ path: fullPath }, "removed orphaned cgroup");
        } catch (err) {
          vmLogger.warn({ path: fullPath, err }, "failed to remove orphaned cgroup");
        }
      }
    } catch (err) {
      vmLogger.debug({ parentDir, err }, "could not scan cgroup parent directory");
    }
  }
}
