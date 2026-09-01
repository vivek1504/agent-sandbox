import net, { Socket } from "net";
import { vmLogger } from "../logger.js";
import { vsockConnectionTime, vsockErrors } from "../metrics.js";
import type { Vm } from "./vm-manager.js";

export async function connectVsock(
  path: string,
  timeout = 5000,
): Promise<Socket> {
  vmLogger.debug({ path, timeoutMs: timeout }, "connecting to vsock");
  const start = performance.now();

  return new Promise((resolve, reject) => {
    const connectStart = Date.now();

    const tryConnect = () => {
      const socket = net.createConnection({ path });

      socket.once("connect", () => {
        const durationSec = (performance.now() - start) / 1000;
        vsockConnectionTime.observe(durationSec);
        vmLogger.debug(
          { path, elapsedMs: Date.now() - connectStart },
          "vsock connected",
        );
        resolve(socket);
      });

      socket.once("error", () => {
        socket.destroy();

        if (Date.now() - connectStart > timeout) {
          vsockErrors.inc({ error_type: "timeout" });
          vmLogger.error({ path, timeoutMs: timeout }, "vsock connection timeout");
          return reject(new Error("Vsock timeout"));
        }

        setTimeout(tryConnect, 100);
      });
    };

    tryConnect();
  });
}

const connectingSockets = new Map<string, Promise<Socket>>();

export async function getVmSocket(vm: Vm): Promise<Socket> {
  if (vm.socket && !vm.socket.destroyed) {
    return vm.socket;
  }

  const existingPromise = connectingSockets.get(vm.id);
  if (existingPromise) {
    return existingPromise;
  }

  vmLogger.debug({ vmId: vm.id, vsock: vm.vsock }, "establishing new VM socket");
  const connectPromise = (async () => {
    try {
      const socket = await connectVsock(vm.vsock);
      socket.write("CONNECT 5000\n");
      vm.socket = socket;
      return socket;
    } finally {
      connectingSockets.delete(vm.id);
    }
  })();

  connectingSockets.set(vm.id, connectPromise);
  return connectPromise;
}

/**
 * Simple async mutex to serialize requests on a single vsock connection.
 * Prevents concurrent callers from interleaving responses.
 */
const vmLocks = new Map<string, Promise<void>>();

export async function acquireVmLock(vmId: string): Promise<() => void> {
  // Wait for any existing lock to release
  while (vmLocks.has(vmId)) {
    await vmLocks.get(vmId);
  }

  let release: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    release = () => {
      vmLocks.delete(vmId);
      resolve();
    };
  });

  vmLocks.set(vmId, lockPromise);
  return release!;
}

