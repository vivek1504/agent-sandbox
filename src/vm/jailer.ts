import fs from "fs";
import path from "path";
import type { ResolvedTemplate } from "./templates.js";

export interface VmResourceConfig {
  vcpuCount: number;
  memSizeMib: number;
  cpuQuotaUs: number;
  cpuPeriodUs: number;
  memoryLimitBytes: number;
  noFileSoftLimit: number;
  diskLimitBytes?: number;
  pidsLimit?: number;
}

export const JAILER_BIN =
  process.env.FIRECRACKER_JAILER_BIN ?? "/usr/local/bin/jailer";
export const FIRECRACKER_BIN =
  process.env.FIRECRACKER_BIN ?? "/usr/local/bin/firecracker";
export const JAIL_BASE_DIR =
  process.env.FIRECRACKER_JAIL_BASE ?? "/var/lib/agent-sandbox/jailer";
export const ARTIFACTS_DIR =
  process.env.FIRECRACKER_ARTIFACTS_DIR ?? "/var/lib/agent-sandbox/artifacts";

export const FIRECRACKER_UID = parseId(
  process.env.FIRECRACKER_UID ?? "997",
  "FIRECRACKER_UID",
);
export const FIRECRACKER_GID = parseId(
  process.env.FIRECRACKER_GID ?? "982",
  "FIRECRACKER_GID",
);

export interface JailPaths {
  id: string;
  instanceDir: string;
  rootDir: string;
  apiSocket: string;
  vsockSocket: string;
  snapshotPath: string;
  memoryPath: string;
}

function parseId(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a numeric ID`);
  return Number(value);
}

function assertSafeName(value: string, name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${name} contains unsupported characters`);
  }
}

function instanceDir(vmId: string): string {
  assertSafeName(vmId, "VM ID");
  return path.join(JAIL_BASE_DIR, "firecracker", vmId);
}

function artifactPath(prefix: "snapshot" | "mem", snapshotId: string): string {
  assertSafeName(snapshotId, "snapshot ID");
  return path.join(ARTIFACTS_DIR, `${prefix}-${snapshotId}`);
}

function enforceJailPermissions(paths: string[]): void {
  const isStrict =
    process.env.NODE_ENV === "production" ||
    process.env.STRICT_PERMISSIONS === "true";

  try {
    for (const p of paths) {
      fs.chmodSync(p, 0o750);
      fs.chownSync(p, FIRECRACKER_UID, FIRECRACKER_GID);
    }
  } catch (err) {
    if (isStrict) {
      throw new Error(
        `Failed to set strict permissions on jail directory in production: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // In development / test mode, allow fallback for mock filesystems or non-root runners
  }
}

export function prepareJail(
  vmId: string,
  template: ResolvedTemplate,
): JailPaths {
  const dir = instanceDir(vmId);
  const rootDir = path.join(dir, "root");
  const artifactsDir = path.join(rootDir, "artifacts");

  if (fs.existsSync(dir))
    throw new Error(`Jail directory already exists: ${dir}`);

  const runDir = path.join(rootDir, "run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });

  enforceJailPermissions([dir, rootDir, runDir, artifactsDir]);

  fs.linkSync(template.snapshotPath, path.join(artifactsDir, "snapshot"));
  fs.linkSync(template.memoryPath, path.join(artifactsDir, "memory"));
  fs.linkSync(template.rootfsPath, path.join(rootDir, "rootfs.ext4"));

  fs.linkSync(
    path.join(ARTIFACTS_DIR, "vmlinux"),
    path.join(rootDir, "vmlinux"),
  );

  return {
    id: vmId,
    instanceDir: dir,
    rootDir,
    apiSocket: path.join(rootDir, "run", "api.socket"),
    vsockSocket: path.join(rootDir, "run", "vsock.socket"),
    snapshotPath: "/artifacts/snapshot",
    memoryPath: "/artifacts/memory",
  };
}

export function detectCgroupVersion(): 1 | 2 {
  try {
    const mounts = fs.readFileSync("/proc/mounts", "utf-8");
    return mounts.includes("cgroup2") ? 2 : 1;
  } catch {
    return 2;
  }
}

export function jailerArgs(vmId: string, netnsPath?: string, resources: VmResourceConfig = loadResourceConfig()): string[] {
  assertSafeName(vmId, "VM ID");
  const cgroupVersion = detectCgroupVersion();
  const pidsLimit = resources.pidsLimit ?? 256;
  const args = [
    "--id",
    vmId,
    "--exec-file",
    FIRECRACKER_BIN,
    "--uid",
    String(FIRECRACKER_UID),
    "--gid",
    String(FIRECRACKER_GID),
    "--chroot-base-dir",
    JAIL_BASE_DIR,
    "--cgroup-version",
    String(cgroupVersion),
    "--resource-limit",
    `no-file=${resources.noFileSoftLimit}`,
  ];

  if (cgroupVersion === 2) {
    args.push(
      "--cgroup",
      `cpu.max=${resources.cpuQuotaUs} ${resources.cpuPeriodUs}`,
      "--cgroup",
      `memory.max=${resources.memoryLimitBytes}`,
      "--cgroup",
      `pids.max=${pidsLimit}`
    );
  } else {
    args.push(
      "--cgroup",
      `cpu.cpu.cfs_quota_us=${resources.cpuQuotaUs}`,
      "--cgroup",
      `cpu.cpu.cfs_period_us=${resources.cpuPeriodUs}`,
      "--cgroup",
      `memory.memory.limit_in_bytes=${resources.memoryLimitBytes}`,
      "--cgroup",
      `pids.pids.max=${pidsLimit}`
    );
  }

  if (netnsPath) {
    args.push("--netns", netnsPath);
  }

  args.push("--", "--api-sock", "/run/api.socket");
  return args;
}

export function removeJail(instancePath: string): void {
  const expectedParent = path.resolve(JAIL_BASE_DIR, "firecracker") + path.sep;
  const resolved = path.resolve(instancePath);
  if (!resolved.startsWith(expectedParent)) {
    throw new Error(
      "refusing to remove a path outside the Jailer base directory",
    );
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

export function prepareSnapshotCreationJail(
  vmId: string,
  customRootfsPath?: string,
): JailPaths {
  const dir = instanceDir(vmId);
  const rootDir = path.join(dir, "root");

  const runDir = path.join(rootDir, "run");
  const artifactsDir = path.join(rootDir, "artifacts");

  if (fs.existsSync(dir)) {
    throw new Error(`Jail directory already exists: ${dir}`);
  }

  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });

  enforceJailPermissions([dir, rootDir, runDir, artifactsDir]);

  fs.linkSync(
    path.join(ARTIFACTS_DIR, "vmlinux"),
    path.join(rootDir, "vmlinux"),
  );

  const rootfsSource = customRootfsPath || path.join(ARTIFACTS_DIR, "rootfs.ext4");
  fs.linkSync(
    rootfsSource,
    path.join(rootDir, "rootfs.ext4"),
  );


  return {
    id: vmId,
    instanceDir: dir,
    rootDir,
    apiSocket: path.join(runDir, "api.socket"),
    vsockSocket: path.join(runDir, "vsock.socket"),

    snapshotPath: "/artifacts/snapshot",
    memoryPath: "/artifacts/memory",
  };
}

export function loadResourceConfig(): VmResourceConfig {
  return {
    vcpuCount: parseInt(process.env.VM_VCPU_COUNT ?? "1", 10),
    memSizeMib: parseInt(process.env.VM_MEM_SIZE_MIB ?? "128", 10),
    cpuQuotaUs: parseInt(process.env.VM_CPU_QUOTA_US ?? "50000", 10),
    cpuPeriodUs: parseInt(process.env.VM_CPU_PERIOD_US ?? "100000", 10),
    memoryLimitBytes: parseInt(
      process.env.VM_MEMORY_LIMIT_BYTES ?? String(128 * 1024 * 1024),
      10,
    ),
    noFileSoftLimit: parseInt(process.env.VM_NOFILE_LIMIT ?? "1024", 10),
    diskLimitBytes: process.env.VM_DISK_LIMIT_BYTES
      ? parseInt(process.env.VM_DISK_LIMIT_BYTES, 10)
      : 512 * 1024 * 1024,
    pidsLimit: parseInt(process.env.VM_PIDS_MAX ?? "256", 10),
  };
}
