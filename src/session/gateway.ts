import { readVsockResponse } from "../vm/protocol.js";
import { getVmSocket, acquireVmLock } from "../vm/transport.js";
import { cleanupVm } from "../vm/cleanup.js";
import { getSession, createSession, touchSession } from "./session.js";
import { sessionLogger } from "../logger.js";
import {
  execMessageTotal,
  execMessageDurationSeconds,
  execProcessExitCode,
  execWorkspaceBytesWritten,
} from "../metrics.js";
import crypto from "crypto";
import { createVm, type Vm } from "../vm/vm-manager.js";
import { type VmResourceConfig, loadResourceConfig } from "../vm/jailer.js";
import { type EgressPolicy, loadEgressPolicy } from "../vm/egress-policy.js";
import { addEntry } from "./manifest.js";

export async function ensureSession(
  sessionId: string,
  templateName?: string,
  ownerId?: string,
  resources: VmResourceConfig = loadResourceConfig(),
  egressPolicy: EgressPolicy = loadEgressPolicy(),
): Promise<Vm> {
  let session = getSession(sessionId);
  session = session || createSession(sessionId, templateName, ownerId);
  if (session.vm) {
    if (session.vm.state === "dead" || session.vm.cleaned) {
      sessionLogger.warn(
        { sessionId, vmId: session.vm.id },
        "VM is dead or cleaned up, resetting session VM for recreation",
      );
      const deadVm = session.vm;
      session.vm = undefined;
      session.state = "creating";
      await cleanupVm(sessionId, deadVm).catch(() => {});
    } else {
      return session.vm;
    }
  }
  if (session.creation) return session.creation;

  session.creation = createVm(sessionId, templateName, resources, egressPolicy)

    .then(async (vm) => {
      if (getSession(sessionId) !== session || session.state === "destroying") {
        await cleanupVm(sessionId, vm);
        throw new Error("Session was destroyed while its VM was being created");
      }
      session.vm = vm;
      session.state = "active";
      if (vm.networkInfo && vm.jailDir) {
        addEntry({
          sessionId,
          ownerId: session.ownerId,
          vmId: vm.id,
          createdAt: session.createdAt,
          slot: vm.networkInfo.slot,
          nsName: vm.networkInfo.nsName,
          jailDir: vm.jailDir,
          templateName,
        });
      }
      return vm;
    })
    .finally(() => {
      session.creation = undefined;
    });

  return session.creation;
}

export async function sendSessionMessage(
  sessionId: string,
  message: Record<string, any>,
  onStream?: (chunk: any) => void,
  timeout: number = 60000,
  templateName?: string,
  ownerId?: string,
): Promise<any> {
  touchSession(sessionId);
  const vm = await ensureSession(sessionId, templateName, ownerId);
  touchSession(sessionId);

  const id = message.id || crypto.randomUUID();
  const fullMessage = { ...message, id };

  // Acquire per-VM lock to serialize requests on the shared socket
  const releaseLock = await acquireVmLock(vm.id);

  try {
    const socket = await getVmSocket(vm);
    socket.write(JSON.stringify(fullMessage) + "\n");

    sessionLogger.debug(
      { sessionId, messageType: message.type, messageId: id },
      "message sent to VM",
    );

    const startTime = process.hrtime.bigint();
    let status = "success";
    let result;

    try {
      result = await readVsockResponse(socket, timeout, onStream, id);

      if (message.type === "execute" && result.data?.exitCode !== undefined) {
        execProcessExitCode.inc({
          command: message.command,
          exit_code: result.data.exitCode.toString(),
        });
      } else if (message.type === "write_file" && result.data?.bytesWritten) {
        execWorkspaceBytesWritten.inc(result.data.bytesWritten);
      }

      return { ...result, messageId: id };
    } catch (err) {
      status = "error";
      throw err;
    } finally {
      const duration =
        Number(process.hrtime.bigint() - startTime) / 1_000_000_000;
      execMessageDurationSeconds.observe({ type: message.type }, duration);
      execMessageTotal.inc({ type: message.type, status });
    }
  } finally {
    releaseLock();
  }
}

