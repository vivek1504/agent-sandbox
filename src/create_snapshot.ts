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
  removeJail,
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
      () => reject(new Error(`VM startup timeout. Output received so far:\n${buffer}`)),
      50_000,
    );
    fc.stdout.on("data", (data: Buffer) => {
      const str = data.toString();
      console.log("[VM Output]:", str.trim());
      buffer += str;
      if (buffer.includes("READY")) {
        clearTimeout(timeout);
        setTimeout(resolve, 200);
      }
    });
  });
}

async function main() {
  const templateName = process.argv[2] || "node";
  const customRootfsPath = process.argv[3];
  const functionId = `snap-${templateName}`;

  const templateDir = path.join(ARTIFACTS_DIR, "templates", templateName);
  fs.mkdirSync(templateDir, { recursive: true });

  const rootfsSource = customRootfsPath
    ? path.resolve(customRootfsPath)
    : path.resolve("rootfs.ext4");

  if (!fs.existsSync(rootfsSource)) {
    console.error(`ERROR: rootfs file not found at ${rootfsSource}`);
    process.exit(1);
  }

  const templateRootfs = path.join(templateDir, "rootfs.ext4");
  if (path.resolve(rootfsSource) !== path.resolve(templateRootfs)) {
    fs.copyFileSync(rootfsSource, templateRootfs);
  }

  let jail: JailPaths | undefined;
  let networkInfo: VmNetworkInfo | undefined;
  let fc: any;

  try {
    jail = prepareSnapshotCreationJail(functionId, templateRootfs);

    console.log(`Setting up network namespace for template "${templateName}" snapshot creation...`);
    try {
      networkInfo = await setupVmNetwork(functionId);
    } catch (err) {
      console.error("Failed to set up network namespace:", err);
      console.error("Ensure you have root/CAP_NET_ADMIN privileges.");
      process.exit(1);
    }

    const vmResources: VmResourceConfig = loadResourceConfig();

    console.log("Starting Firecracker process...");
    fc = await startFirecrackerProcess(functionId, jail, networkInfo.nsPath, vmResources);

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

    console.log(
      `  ${snapshotPath} (${(fs.statSync(snapshotPath).size / 1024).toFixed(0)} KB)`,
    );
    console.log(
      `  ${memPath} (${(fs.statSync(memPath).size / 1024 / 1024).toFixed(1)} MB)`,
    );

    const targetSnapshot = path.join(templateDir, "snapshot");
    const targetMemory = path.join(templateDir, "memory");

    fs.copyFileSync(snapshotPath, targetSnapshot);
    fs.copyFileSync(memPath, targetMemory);

    const manifest = {
      name: templateName,
      displayName: templateName.charAt(0).toUpperCase() + templateName.slice(1),
      version: "1.0.0",
      description: `${templateName} environment template`,
      tools: [templateName, "sh"],
      baseImage: "alpine:3.20",
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(templateDir, "template.json"),
      JSON.stringify(manifest, null, 2),
    );

    if (templateName === "node") {
      fs.copyFileSync(snapshotPath, path.join(ARTIFACTS_DIR, "snapshot-exec"));
      fs.copyFileSync(memPath, path.join(ARTIFACTS_DIR, "mem-exec"));
      if (!fs.existsSync(path.join(ARTIFACTS_DIR, "rootfs.ext4"))) {
        fs.copyFileSync(templateRootfs, path.join(ARTIFACTS_DIR, "rootfs.ext4"));
      }
    }

    console.log(`\nDone! Template "${templateName}" created at ${templateDir}`);
  } finally {
    if (fc) {
      console.log("Killing Firecracker process...");
      try {
        fc.kill("SIGKILL");
      } catch {}
    }
    if (jail) {
      try {
        removeJail(jail.instanceDir);
      } catch (err) {
        console.warn("Warning: failed to clean up jail directory:", err);
      }
    }
    if (networkInfo) {
      console.log("Cleaning up snapshot network namespace...");
      try {
        await teardownVmNetwork(networkInfo);
      } catch (err) {
        console.warn("Warning: failed to clean up network namespace:", err);
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Snapshot creation failed:", err);
    try {
      const templateName = process.argv[2] || "node";
      const fcLogPath = `/var/lib/agent-sandbox/jailer/firecracker/snap-${templateName}/root/firecracker.log`;
      if (fs.existsSync(fcLogPath)) {
        console.error("\n=== Firecracker Internal Log ===");
        console.error(fs.readFileSync(fcLogPath, "utf-8"));
        console.error("===============================\n");
      }
    } catch (logErr) {
      console.error("Could not read firecracker log:", logErr);
    }
    process.exit(1);
  });
}
