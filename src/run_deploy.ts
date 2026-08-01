import {
  startFirecrackerProcess,
  configureVM,
  createFcCient,
  waitForVMReady,
} from "./deploy/firecracker.js";
import fs from "fs";
import path from "path";

async function main() {
  const functionId = "__exec__";
  const apiSock = `/tmp/firecracker-${functionId}.socket`;
  const vsockPath = `/tmp/vsock-${functionId}.sock`;

  // Clean up stale sockets from previous runs
  try { fs.unlinkSync(apiSock); } catch { }
  try { fs.unlinkSync(vsockPath); } catch { }

  // Ensure snapshot/ and mem/ directories exist
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
  const client = createFcCient(apiSock);

  const readyPromise = waitForVMReady(fc);
  await configureVM(client, functionId, image);

  console.log("Waiting for VM READY signal...");
  await readyPromise;
  console.log("VM is ready!");

  // Pause and snapshot
  console.log("Pausing VM...");
  await client.patch("/vm", { state: "Paused" });

  // These paths must match what restoreVm() expects:
  //   snapshot/snapshot-__exec__  and  mem/mem-__exec__
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

  // Clean up sockets
  try { fs.unlinkSync(apiSock); } catch { }
  try { fs.unlinkSync(vsockPath); } catch { }

  console.log("\nDone! Files created:");
  console.log(`  ${snapshotPath} (${(fs.statSync(snapshotPath).size / 1024).toFixed(0)} KB)`);
  console.log(`  ${memPath} (${(fs.statSync(memPath).size / 1024 / 1024).toFixed(1)} MB)`);
  console.log("\nYou can now start the server and use the /exec and /mcp endpoints.");
}

main().catch((err) => {
  console.error("Snapshot creation failed:", err);
  process.exit(1);
});
