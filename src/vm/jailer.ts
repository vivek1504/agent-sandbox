import fs from "fs";
import path from "path";

export const JAILER_BIN =
  process.env.FIRECRACKER_JAILER_BIN ?? "/usr/local/bin/jailer";
export const FIRECRACKER_BIN =
  process.env.FIRECRACKER_BIN ?? "/usr/local/bin/firecracker";
export const JAIL_BASE_DIR =
  process.env.FIRECRACKER_JAIL_BASE ?? "/var/lib/lambda/jailer";
export const ARTIFACTS_DIR =
  process.env.FIRECRACKER_ARTIFACTS_DIR ?? "/var/lib/lambda/artifacts";

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

export function prepareJail(vmId: string, snapshotId: string): JailPaths {
  const sourceSnapshot = artifactPath("snapshot", snapshotId);
  const sourceMemory = artifactPath("mem", snapshotId);
  const dir = instanceDir(vmId);
  const rootDir = path.join(dir, "root");
  const artifactsDir = path.join(rootDir, "artifacts");
  console.log(`Preparing jail for VM ${vmId} with snapshot ${snapshotId}`);

  for (const source of [sourceSnapshot, sourceMemory]) {
    const stat = fs.statSync(source);
    if (!stat.isFile())
      throw new Error(`Jailer artifact is not a regular file: ${source}`);
  }

  if (fs.existsSync(dir))
    throw new Error(`Jail directory already exists: ${dir}`);

  fs.mkdirSync(artifactsDir, { recursive: true, mode: 0o755 });
  fs.linkSync(sourceSnapshot, path.join(artifactsDir, "snapshot"));
  fs.linkSync(sourceMemory, path.join(artifactsDir, "memory"));
  fs.linkSync(
    "/var/lib/lambda/artifacts/rootfs.ext4",
    path.join(rootDir, "rootfs.ext4"),
  );

  fs.linkSync(
    "/var/lib/lambda/artifacts/vmlinux",
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

export function jailerArgs(vmId: string, netnsPath?: string): string[] {
  assertSafeName(vmId, "VM ID");
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
    "--resource-limit",
    "no-file=1024",
  ];

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

export function prepareSnapshotCreationJail(vmId: string): JailPaths {
  const dir = instanceDir(vmId);
  const rootDir = path.join(dir, "root");

  const runDir = path.join(rootDir, "run");
  const artifactsDir = path.join(rootDir, "artifacts");

  if (fs.existsSync(dir)) {
    throw new Error(`Jail directory already exists: ${dir}`);
  }

  fs.mkdirSync(runDir, { recursive: true, mode: 0o755 });
  fs.mkdirSync(artifactsDir, { recursive: true, mode: 0o755 });

  fs.chownSync(runDir, FIRECRACKER_UID, FIRECRACKER_GID);
  fs.chownSync(artifactsDir, FIRECRACKER_UID, FIRECRACKER_GID);

  fs.linkSync(
    path.join(ARTIFACTS_DIR, "vmlinux"),
    path.join(rootDir, "vmlinux"),
  );

  fs.linkSync(
    path.join(ARTIFACTS_DIR, "rootfs.ext4"),
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
