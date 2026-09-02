import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { vmLogger } from "../logger.js";
import { loadManifest, clearManifest } from "../session/manifest.js";
import { JAIL_BASE_DIR } from "./jailer.js";
import { cleanupStaleNetworkResources } from "./networking.js";

export function sweepOrphanedResources(): void {
  vmLogger.info("starting orphan resource sweep");

  let ownedPids: Set<number> | undefined;
  let ownedInstanceIds: Set<string> | undefined;
  let ownedNamespaces: Set<string> | undefined;

  try {
    const staleEntries = loadManifest();
    if (staleEntries.length > 0) {
      ownedPids = new Set(staleEntries.map((e) => e.pid).filter((p): p is number => typeof p === "number"));
      ownedInstanceIds = new Set(
        staleEntries.map((e) => e.vmId || path.basename(e.jailDir)).filter((id): id is string => Boolean(id)),
      );
      ownedNamespaces = new Set(
        staleEntries.map((e) => e.nsName || e.netns).filter((ns): ns is string => Boolean(ns)),
      );

      vmLogger.info(
        { count: staleEntries.length, sessions: staleEntries.map((e) => e.sessionId) },
        "reconciling orphaned resources from manifest entries",
      );
    }
  } catch (err) {
    vmLogger.warn({ err }, "failed to read stale manifest during sweep");
  }

  killOrphanedProcesses("firecracker", ownedPids);
  killOrphanedProcesses("jailer", ownedPids);

  sweepJailDirectories(ownedInstanceIds);

  cleanupStaleNetworkResources(ownedNamespaces);

  sweepCgroupDirectories(ownedInstanceIds);

  try {
    clearManifest();
  } catch (err) {
    vmLogger.warn({ err }, "failed to clear manifest during sweep");
  }

  vmLogger.info("orphan resource sweep complete");
}

export function killOrphanedProcesses(name: string, ownedPids?: Set<number>): void {
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

      if (ownedPids && !ownedPids.has(pid)) {
        vmLogger.debug({ pid, process: name }, "skipping process not owned by service manifest");
        continue;
      }

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

export function sweepJailDirectories(ownedInstanceIds?: Set<string>): void {
  const jailParent = path.join(JAIL_BASE_DIR, "firecracker");
  if (!fs.existsSync(jailParent)) return;

  try {
    let dirs = fs.readdirSync(jailParent);
    if (ownedInstanceIds) {
      dirs = dirs.filter((dir) => ownedInstanceIds.has(dir));
    }
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

export function sweepCgroupDirectories(ownedInstanceIds?: Set<string>): void {
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
        if (ownedInstanceIds && !ownedInstanceIds.has(entry.name)) continue;
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
