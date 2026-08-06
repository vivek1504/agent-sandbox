import { spawn } from "child_process";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export async function startFirecrackerProcess(apiSock: string) {
  const fc = spawn("firecracker", ["--api-sock", apiSock]);

  fc.on("error", (err) => console.error("Firecracker process error:", err));
  fc.stderr.on("data", (data) =>
    console.warn("Firecracker stderr:", data.toString().trim()),
  );

  await waitForFile(apiSock);
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

export async function configureVm(
  client: any,
  functionId: string,
  image: string,
) {
  await client.put("/machine-config", { vcpu_count: 1, mem_size_mib: 128 });

  await client.put("/boot-source", {
    kernel_image_path: path.resolve("vmlinux"),
    boot_args: "console=ttyS0 reboot=k panic=1 pci=off init=/init -- /start.sh",
  });

  await client.put("/drives/rootfs", {
    drive_id: "rootfs",
    path_on_host: image,
    is_root_device: true,
    is_read_only: true,
  });

  await client.put("/vsock", {
    vsock_id: "vsock0",
    guest_cid: Math.floor(Math.random() * 10000) + 3,
    uds_path: `/tmp/vsock-${functionId}.sock`,
  });

  await client.put("/logger", {
    log_path: "firecracker.log",
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
    const timeout = setTimeout(() => reject(new Error("VM startup timeout")), 50_000);
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
  const functionId = "__exec__";
  const apiSock = `/tmp/firecracker-${functionId}.socket`;
  const vsockPath = `/tmp/vsock-${functionId}.sock`;

  try {
    fs.unlinkSync(apiSock);
  } catch {}
  try {
    fs.unlinkSync(vsockPath);
  } catch {}

  fs.mkdirSync("snapshot", { recursive: true });
  fs.mkdirSync("mem", { recursive: true });

  const image = path.resolve("rootfs.ext4");
  if (!fs.existsSync(image)) {
    console.error("ERROR: rootfs.ext4 not found in project root");
    process.exit(1);
  }

  console.log("Starting Firecracker process...");
  const fc = await startFirecrackerProcess(apiSock);

  console.log("Configuring VM...");
  const client = createFcClient(apiSock);

  const readyPromise = waitForVmReady(fc);
  await configureVm(client, functionId, image);

  console.log("Waiting for VM READY signal...");
  await readyPromise;
  console.log("VM is ready!");

  console.log("Pausing VM...");
  await client.patch("/vm", { state: "Paused" });

  const snapshotPath = path.resolve(`snapshot/snapshot-${functionId}`);
  const memPath = path.resolve(`mem/mem-${functionId}`);

  console.log(`Creating snapshot at:\n  ${snapshotPath}\n  ${memPath}`);
  await client.put("/snapshot/create", {
    snapshot_type: "Full",
    snapshot_path: snapshotPath,
    mem_file_path: memPath,
  });

  console.log("Snapshot created successfully!");
  console.log("Killing Firecracker process...");
  fc.kill("SIGKILL");

  try {
    fs.unlinkSync(apiSock);
  } catch {}
  try {
    fs.unlinkSync(vsockPath);
  } catch {}

  console.log("\nDone! Files created:");
  console.log(
    `  ${snapshotPath} (${(fs.statSync(snapshotPath).size / 1024).toFixed(0)} KB)`,
  );
  console.log(
    `  ${memPath} (${(fs.statSync(memPath).size / 1024 / 1024).toFixed(1)} MB)`,
  );
  console.log(
    "\nYou can now start the server and use the /exec and /mcp endpoints.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Snapshot creation failed:", err);
    process.exit(1);
  });
}
