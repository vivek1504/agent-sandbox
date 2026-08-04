import { readVsockResponse } from "../vm/protocol.js";
import { getVmSocket } from "../vm/transport.js";
import { cleanupVm } from "../vm/cleanup.js";
import { getSession, createSession, touchSession } from "./session.js";
import { sessionLogger } from "../logger.js";
import {
  execMessageTotal,
  execMessageDurationSeconds,
  execProcessExitCode,
  execWorkspaceBytesWritten
} from "../metrics.js";
import crypto from "crypto";
import { createVm, type Vm } from "../vm/vm-manager.js";
import { log } from "../mcp/server.js";

export async function ensureSession(sessionId: string): Promise<Vm> {
  let session = getSession(sessionId);
  session = session || createSession(sessionId);
  log(session + " if present returns session.vm or creation")
  if (session.vm) return session.vm;
  if (session.creation) return session.creation;

  log("creating session")
  session.creation = createVm(sessionId, "__exec__")
    .then(async (vm) => {
      log("session creation completed")
      if (getSession(sessionId) !== session || session.state === "destroying") {
        await cleanupVm(sessionId, vm);
        throw new Error("Session was destroyed while its VM was being created");
      }
      session.vm = vm;
      session.state = "active";
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
): Promise<any> {
  log("ensureSession")
  const vm = await ensureSession(sessionId);
  touchSession(sessionId);

  const id = message.id || crypto.randomUUID();
  const fullMessage = { ...message, id };

  log("getVmSocket")
  const socket = await getVmSocket(vm);
  log("socket.write")
  socket.write(JSON.stringify(fullMessage) + "\n");

  sessionLogger.debug(
    { sessionId, messageType: message.type, messageId: id },
    "message sent to VM"
  );

  const startTime = process.hrtime.bigint();
  let status = "success";
  let result;

  try {
    log("readVsockResponse")
    result = await readVsockResponse(socket, timeout, onStream);

    if (message.type === "execute" && result.data?.exitCode !== undefined) {
      execProcessExitCode.inc({ command: message.command, exit_code: result.data.exitCode.toString() });
    } else if (message.type === "write_file" && result.data?.bytesWritten) {
      execWorkspaceBytesWritten.inc(result.data.bytesWritten);
    }
    log("done")
    return { ...result, messageId: id };
  } catch (err) {
    status = "error";
    throw err;
  } finally {
    const duration = Number(process.hrtime.bigint() - startTime) / 1_000_000_000;
    execMessageDurationSeconds.observe({ type: message.type }, duration);
    execMessageTotal.inc({ type: message.type, status });
  }
}
