import { spawn } from "child_process";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  JAILER_BIN,
  jailerArgs,
  ARTIFACTS_DIR,
  prepareSnapshotCreationJail,
  type JailPaths,
  type VmResourceConfig,
  loadResourceConfig,
} from "./vm/jailer.js";
import {
  setupVmNetwork,
  teardownVmNetwork,
  type VmNetworkInfo,
} from "./vm/networking.js";

export async function startFirecrackerProcess(
  functionId: string,
  jail: JailPaths,
  netnsPath?: string,
  resources?: VmResourceConfig,
) {
  const fc = spawn(JAILER_BIN, jailerArgs(functionId, netnsPath, resources), {
    stdio: ["ignore", "pipe", "pipe"],
  });

  fc.on("error", (err) => console.error("Firecracker process error:", err));
  fc.stderr.on("data", (data) =>
    console.warn("Firecracker stderr:", data.toString().trim()),
  );

  await waitForFile(jail.apiSocket);
  return fc;
}

export async function waitForFile(
  filePath: string,
  timeout = 5000,
): Promise<void> {
  const start = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - start > timeout) {
      throw new Error("timeout waiting for socket");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function createFcClient(apiSock: string) {
  return axios.create({
    socketPath: apiSock,
    baseURL: "http://localhost",
    headers: { "Content-Type": "application/json" },
  });
}

export async function configureVm(client: any, resources: VmResourceConfig = loadResourceConfig()) {
  await client.put("/machine-config", { vcpu_count: resources.vcpuCount, mem_size_mib: resources.memSizeMib });

  await client.put("/boot-source", {
    kernel_image_path: "/vmlinux",
    boot_args: "console=ttyS0 reboot=k panic=1 pci=off init=/init -- /start.sh",
  });

  await client.put("/drives/rootfs", {
    drive_id: "rootfs",
    path_on_host: "/rootfs.ext4",
    is_root_device: true,
    is_read_only: true,
  });

  await client.put("/vsock", {
    vsock_id: "vsock0",
    guest_cid: Math.floor(Math.random() * 10000) + 3,
    uds_path: "/run/vsock.socket",
  });

  await client.put("/logger", {
    log_path: "/firecracker.log",
    level: "Debug",
    show_level: true,
  });

  await client.put("/network-interfaces/eth0", {
    iface_id: "eth0",
    host_dev_name: "tap0",
    guest_mac: "02:FC:00:00:00:01",
  });

  await client.put("/actions", { action_type: "InstanceStart" });
}

export function waitForVmReady(fc: { stdout: NodeJS.EventEmitter }) {
  return new Promise<void>((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(
      () => reject(new Error("VM startup timeout")),
      50_000,
    );
    fc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      if (buffer.includes("READY")) {
        clearTimeout(timeout);
        setTimeout(resolve, 200);
      }
    });
  });
}

async function main() {
  const functionId = "exec";

  fs.mkdirSync("snapshot", { recursive: true });
  fs.mkdirSync("mem", { recursive: true });

  const image = path.resolve("rootfs.ext4");
  if (!fs.existsSync(image)) {
    console.error("ERROR: rootfs.ext4 not found in project root");
    process.exit(1);
  }

  const jail = prepareSnapshotCreationJail(functionId);

  console.log("Setting up network namespace for snapshot creation...");
  let networkInfo: VmNetworkInfo | undefined;
  try {
    networkInfo = setupVmNetwork(functionId);
  } catch (err) {
    console.error("Failed to set up network namespace:", err);
    console.error("Ensure you have root/CAP_NET_ADMIN privileges.");
    process.exit(1);
  }

  const vmResources: VmResourceConfig = loadResourceConfig();

  console.log("Starting Firecracker process...");
  const fc = await startFirecrackerProcess(functionId, jail, networkInfo.nsPath, vmResources);

  console.log("Configuring VM...");
  const client = createFcClient(jail.apiSocket);

  const readyPromise = waitForVmReady(fc);
  await configureVm(client, vmResources);

  console.log("Waiting for VM READY signal...");
  await readyPromise;
  console.log("VM is ready!");

  console.log("Pausing VM...");
  await client.patch("/vm", { state: "Paused" });

  const snapshotPath = path.join(jail.rootDir, "artifacts", "snapshot");
  const memPath = path.join(jail.rootDir, "artifacts", "memory");

  console.log(`Creating snapshot at:\n  ${snapshotPath}\n  ${memPath}`);
  await client.put("/snapshot/create", {
    snapshot_type: "Full",
    snapshot_path: "/artifacts/snapshot",
    mem_file_path: "/artifacts/memory",
  });

  console.log("Snapshot created successfully!");
  console.log("Killing Firecracker process...");
  fc.kill("SIGKILL");

  console.log(
    `  ${snapshotPath} (${(fs.statSync(snapshotPath).size / 1024).toFixed(0)} KB)`,
  );
  console.log(
    `  ${memPath} (${(fs.statSync(memPath).size / 1024 / 1024).toFixed(1)} MB)`,
  );

  fs.renameSync(
    snapshotPath,
    path.join(ARTIFACTS_DIR, `snapshot-${functionId}`),
  );

  fs.renameSync(memPath, path.join(ARTIFACTS_DIR, `mem-${functionId}`));

  console.log("\nDone! Files created:");
  console.log(
    "\nYou can now start the server and use the /exec and /mcp endpoints.",
  );

  if (networkInfo) {
    console.log("Cleaning up snapshot network namespace...");
    try {
      teardownVmNetwork(networkInfo);
    } catch (err) {
      console.warn("Warning: failed to clean up network namespace:", err);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Snapshot creation failed:", err);
    process.exit(1);
  });
}
