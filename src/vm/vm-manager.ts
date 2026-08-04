import { spawn } from "child_process";
import net from "net";
import axios from "axios";
import path from "path";
import crypto from "crypto";
import { vmLogger } from "../logger.js";
import { vmCount, vmCreationTime, vmCreationTotal } from "../metrics.js";
import { fileURLToPath } from "url";

import type { ChildProcessWithoutNullStreams } from "child_process";
import type { Socket } from "net";

export type VmState = "creating" | "restoring" | "ready" | "busy" | "dead";

export interface Vm {
  id: string;
  state: VmState;
  firecrackerProcess: ChildProcessWithoutNullStreams;
  apiSock: string;
  vsock: string;
  socket?: Socket;
  cleaned?: boolean;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "../..")

export async function createVm(sessionId: string, snapshotId?: string): Promise<Vm> {
  const instanceId = crypto.randomBytes(4).toString("hex");
  const apiSock = `/tmp/firecracker-${sessionId}-${instanceId}.socket`;
  const vsock = `/tmp/vsock-${sessionId}-${instanceId}.sock`;
  const start = performance.now();

  vmLogger.info(
    { sessionId, instanceId, apiSock, vsock },
    "creating new VM instance",
  );
  vmCount.inc({ function_id: sessionId, state: "creating" });

  try {
    const fc = spawn("firecracker", ["--api-sock", apiSock]);
    fc.on("error", (err) => {
      vmLogger.error({ instanceId, err }, "firecracker process error");
    });

    fc.on("exit", (code, signal) => {
      vmLogger.info(
        { instanceId, exitCode: code, signal },
        "firecracker process exited",
      );
    });

    await waitForFirecrackerApiSocket(apiSock);

    const client = createFcClient(apiSock);
    await restoreVm(client, snapshotId || sessionId, vsock);

    const vm: Vm = {
      id: instanceId,
      state: "ready",
      firecrackerProcess: fc,
      apiSock,
      vsock,
    };

    const durationSec = (performance.now() - start) / 1000;
    vmCreationTime.observe(durationSec);
    vmCreationTotal.inc({ status: "success" });
    vmCount.dec({ function_id: sessionId, state: "creating" });
    vmCount.inc({ function_id: sessionId, state: "ready" });

    vmLogger.info(
      {
        sessionId,
        instanceId,
        durationMs: durationSec * 1000,
      },
      "VM instance created and ready",
    );
    return vm;
  } catch (err) {
    const durationSec = (performance.now() - start) / 1000;
    vmCreationTime.observe(durationSec);
    vmCreationTotal.inc({ status: "error" });
    vmCount.dec({ function_id: sessionId, state: "creating" });

    vmLogger.error(
      { sessionId, instanceId, err, durationMs: durationSec * 1000 },
      "VM creation failed",
    );
    throw err;
  }
}

export async function waitForFirecrackerApiSocket(
  path: string,
  timeout = 5000,
) {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();

    const tryConnect = () => {
      const client = net.createConnection({ path });

      client.once("connect", () => {
        client.destroy();
        vmLogger.debug(
          { path, elapsedMs: Date.now() - start },
          "API socket connected",
        );
        resolve();
      });

      client.once("error", () => {
        client.destroy();

        if (Date.now() - start > timeout) {
          vmLogger.error(
            { path, timeoutMs: timeout },
            "API socket connection timeout",
          );
          return reject(new Error("socket timeout"));
        }
        setTimeout(tryConnect, 50);
      });
    };

    tryConnect();
  });
}

export function createFcClient(apiSock: string) {
  return axios.create({
    socketPath: apiSock,
    baseURL: "http://localhost",
    headers: {
      "Content-Type": "application/json",
    },
  });
}

export async function restoreVm(
  client: any,
  functionId: string,
  vsock: string,
) {
  vmLogger.debug({ functionId, vsock }, "restoring VM from snapshot");

  await client.put("/snapshot/load", {
    snapshot_path: path.join(
      ROOT,
      "snapshot",
      `snapshot-${functionId}`
    ),

    mem_backend: {
      backend_path: path.join(
        ROOT,
        "mem",
        `mem-${functionId}`
      ),
      backend_type: "File",
    },
    track_dirty_pages: true,
    resume_vm: true,
    vsock_override: {
      uds_path: vsock,
    },
  });

  vmLogger.debug({ functionId }, "VM restored from snapshot");
}
