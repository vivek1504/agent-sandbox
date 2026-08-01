import { spawn } from "child_process";
import fs from "fs";
import axios from "axios";
import path from "path";
import { firecrackerLogger } from "../utils/logger.js";

export async function startFirecrackerProcess(apiSock: string) {
  firecrackerLogger.debug({ apiSock }, "spawning firecracker process");

  const fc = spawn("firecracker", ["--api-sock", apiSock]);

  fc.on("error", (err) => {
    firecrackerLogger.error(
      { err, apiSock },
      "firecracker process error",
    );
  });

  fc.stderr.on("data", (d) => {
    firecrackerLogger.warn(
      { apiSock, stderr: d.toString().trim() },
      "firecracker stderr output",
    );
  });

  fc.on("exit", (code, signal) => {
    firecrackerLogger.info(
      { apiSock, exitCode: code, signal },
      "firecracker process exited",
    );
  });

  await waitForFile(apiSock, 5000);
  firecrackerLogger.debug({ apiSock }, "firecracker API socket ready");

  return fc;
}

export async function waitForFile(path: any, timeout = 5000) {
  const start = Date.now();

  while (true) {
    if (fs.existsSync(path)) return;

    if (Date.now() - start > timeout) {
      firecrackerLogger.error(
        { path, timeoutMs: timeout },
        "timeout waiting for file",
      );
      throw new Error("timeout waiting for socket");
    }

    await new Promise((r) => setTimeout(r, 100));
  }
}

export function createFcCient(apiSock: string) {
  return axios.create({
    socketPath: apiSock,
    baseURL: "http://localhost",
    headers: {
      "Content-Type": "application/json",
    },
  });
}

export async function configureVM(
  client: any,
  functionId: string,
  image: string,
) {
  firecrackerLogger.debug({ functionId }, "configuring VM");

  await client.put("/machine-config", {
    vcpu_count: 1,
    mem_size_mib: 128,
  });
  firecrackerLogger.debug({ functionId, vcpu: 1, memMib: 128 }, "machine config set");

  await client.put("/boot-source", {
    kernel_image_path: path.resolve("vmlinux"),
    boot_args: "console=ttyS0 reboot=k panic=1 pci=off init=/init -- /start.sh",
  });
  firecrackerLogger.debug({ functionId }, "boot source configured");

  await client.put("/drives/rootfs", {
    drive_id: "rootfs",
    path_on_host: image,
    is_root_device: true,
    is_read_only: true,
  });
  firecrackerLogger.debug({ functionId, image }, "rootfs drive attached");

  const guestCid = Math.floor(Math.random() * 10000) + 3;
  const vsockPath = `/tmp/vsock-${functionId}.sock`;
  await client.put("/vsock", {
    vsock_id: "vsock0",
    guest_cid: guestCid,
    uds_path: vsockPath,
  });
  firecrackerLogger.debug({ functionId, guestCid, vsockPath }, "vsock configured");

  await client.put("/logger", {
    log_path: `firecracker.log`,
    level: "Debug",
    show_level: true,
  });

  await client.put("/actions", {
    action_type: "InstanceStart",
  });
  firecrackerLogger.info({ functionId }, "VM instance started");
}

export function waitForVMReady(fc: any) {
  return new Promise<void>((resolve, reject) => {
    let buffer = "";

    const timeout = setTimeout(() => {
      firecrackerLogger.error("VM startup timeout — READY signal not received within 50s");
      reject(new Error("VM startup timeout"));
    }, 50000);

    fc.stdout.on("data", (d: Buffer) => {
      buffer += d.toString();

      if (buffer.includes("READY")) {
        clearTimeout(timeout);
        firecrackerLogger.debug("VM READY signal received");
        setTimeout(resolve, 200);
      }
    });
  });
}

export async function snapshotVM(client: any, functionId: string) {
  firecrackerLogger.debug({ functionId }, "pausing VM for snapshot");
  await client.patch("/vm", { state: "Paused" });

  const snapshotPath = path.resolve(`snapshot/snapshot-${functionId}`);
  const memPath = path.resolve(`mem/mem-${functionId}`);

  await client.put("/snapshot/create", {
    snapshot_type: "Full",
    snapshot_path: snapshotPath,
    mem_file_path: memPath,
  });

  firecrackerLogger.info(
    { functionId, snapshotPath, memPath },
    "VM snapshot created",
  );
}

export async function cleanupResources(paths: any) {
  firecrackerLogger.debug(
    { outputDir: paths.outputDir, apiSock: paths.apiSock, vsock: paths.vsock },
    "cleaning up deployment resources",
  );

  const results = await Promise.allSettled([
    fs.promises.rm(paths.outputDir, { recursive: true, force: true }),
    fs.promises.rm(paths.apiSock),
    fs.promises.rm(paths.vsock),
  ]);

  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    firecrackerLogger.warn(
      { failedCount: failed.length, errors: failed.map((r: any) => r.reason?.message) },
      "some cleanup operations failed (non-critical)",
    );
  }
}
