import { spawn } from "child_process";
import net from "net";
import fs from "fs";
import path from "path";
import axios from "axios";
import crypto from "crypto";
import { vmLogger } from "../logger.js";
import { vmCount, vmCreationTime, vmCreationTotal, vmTemplateUsage } from "../metrics.js";

import {
  JAILER_BIN,
  jailerArgs,
  prepareJail,
  removeJail,
  type JailPaths,
  type VmResourceConfig,
  loadResourceConfig,
} from "./jailer.js";
import {
  setupVmNetwork,
  teardownVmNetwork,
  type VmNetworkInfo,
} from "./networking.js";
import { type EgressPolicy, loadEgressPolicy } from "./egress-policy.js";

import type { ChildProcessWithoutNullStreams } from "child_process";
import type { Socket } from "net";
import { getTemplate, resolveTemplateName } from "./templates.js";

export type VmState = "creating" | "restoring" | "ready" | "busy" | "dead";

export interface Vm {
  id: string;
  state: VmState;
  firecrackerProcess: ChildProcessWithoutNullStreams;
  apiSock: string;
  vsock: string;
  jailDir?: string;
  networkInfo?: VmNetworkInfo;
  socket?: Socket;
  connectingSocket?: Promise<Socket> | undefined;
  cleaned?: boolean;
}

export async function createVm(
  sessionId: string,
  templateName?: string,
  resources: VmResourceConfig = loadResourceConfig(),
  egressPolicy: EgressPolicy = loadEgressPolicy(),

): Promise<Vm> {
  const instanceId = crypto.randomBytes(4).toString("hex");
  const resolveName = resolveTemplateName(templateName)
  const template = getTemplate(resolveName)!

  const mergedResources = {
    ...resources,
    ...(template.manifest.resources?.memSizeMib
      ? { memSizeMib: template.manifest.resources.memSizeMib }
      : {}),
    ...(template.manifest.resources?.vcpuCount
      ? { vcpuCount: template.manifest.resources.vcpuCount }
      : {}),
  };

  const start = performance.now();
  let jail: JailPaths | undefined;
  let fc: ChildProcessWithoutNullStreams | undefined;
  let networkInfo: VmNetworkInfo | undefined;

  vmLogger.info(
    { sessionId, instanceId, templateName, resources, egressPolicy },
    "creating new VM instance",
  );
  vmCount.inc({ function_id: sessionId, state: "creating" });

  try {
    networkInfo = await setupVmNetwork(instanceId, egressPolicy);

    jail = prepareJail(instanceId, template);
    fc = spawn(JAILER_BIN, jailerArgs(instanceId, networkInfo.nsPath, mergedResources));
    fc.on("error", (err) => {
      vmLogger.error({ instanceId, err }, "jailer process error");
    });

    await waitForFirecrackerApiSocket(jail.apiSocket);

    const client = createFcClient(jail.apiSocket);
    await restoreVm(client, jail);

    const vm: Vm = {
      id: instanceId,
      state: "ready",
      firecrackerProcess: fc,
      apiSock: jail.apiSocket,
      vsock: jail.vsockSocket,
      jailDir: jail.instanceDir,
      networkInfo,
    };

    fc.on("exit", (code, signal) => {
      vm.state = "dead";
      if (vm.socket && !vm.socket.destroyed) {
        vm.socket.destroy();
      }
      vmLogger.info(
        { instanceId, exitCode: code, signal },
        "jailer process exited, VM marked as dead",
      );
    });

    const durationSec = (performance.now() - start) / 1000;
    vmCreationTime.observe(durationSec);
    vmCreationTotal.inc({ status: "success" });
    vmTemplateUsage.inc({ template: resolveName });
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
    try {
      fc?.kill();
    } catch { }

    try {
      if (jail) removeJail(jail.instanceDir);
    } catch (cleanupErr) {
      vmLogger.warn(
        { instanceId, err: cleanupErr },
        "failed to remove unsuccessful jail",
      );
    }

    try {
      if (networkInfo) await teardownVmNetwork(networkInfo);
    } catch (cleanupErr) {
      vmLogger.warn(
        { instanceId, err: cleanupErr },
        "failed to teardown network after failed VM creation",
      );
    }

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
  socketPath: string,
  timeout = 5000,
): Promise<void> {
  const start = Date.now();
  const dir = path.dirname(socketPath);
  const base = path.basename(socketPath);

  return new Promise<void>((resolve, reject) => {
    let resolved = false;
    let watcher: fs.FSWatcher | undefined;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      resolved = true;
      watcher?.close();
      if (timer) clearTimeout(timer);
    };

    const tryConnect = () => {
      if (resolved) return;
      const client = net.createConnection({ path: socketPath });

      client.once("connect", () => {
        client.destroy();
        cleanup();
        vmLogger.debug(
          { path: socketPath, elapsedMs: Date.now() - start },
          "API socket connected",
        );
        resolve();
      });

      client.once("error", () => {
        client.destroy();
        if (resolved) return;
        if (Date.now() - start > timeout) {
          cleanup();
          vmLogger.error(
            { path: socketPath, timeoutMs: timeout },
            "API socket connection timeout",
          );
          return reject(new Error("socket timeout"));
        }
        timer = setTimeout(tryConnect, 5);
      });
    };

    try {
      if (fs.existsSync(dir)) {
        watcher = fs.watch(dir, (_event, filename) => {
          if (filename === base) tryConnect();
        });
        watcher.on("error", () => {});
      }
    } catch {
      // watch setup failed — fall through to polling
    }

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
  jail: JailPaths,
) {
  vmLogger.debug(
    { vsock: jail.vsockSocket },
    "restoring VM from snapshot",
  );

  await client.put("/snapshot/load", {
    snapshot_path: jail.snapshotPath,

    mem_backend: {
      backend_path: jail.memoryPath,
      backend_type: "File",
    },
    track_dirty_pages: true,
    resume_vm: true,
    vsock_override: {
      uds_path: "/run/vsock.socket",
    },
  });

  vmLogger.debug("VM restored from snapshot");
}
