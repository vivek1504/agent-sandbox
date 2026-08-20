import fs from "fs";
import { vmLogger } from "../logger.js";
import { vmCleanupTotal, vmCount } from "../metrics.js";
import { removeJail } from "./jailer.js";
import { teardownVmNetwork } from "./networking.js";

import type { Vm } from "./vm-manager.js";

export async function cleanupVm(sessionId: string, vm: Vm) {
  if (vm.cleaned) return;

  vm.cleaned = true;
  vmLogger.info(
    { sessionId, vmId: vm.id },
    "cleaning up VM",
  );

  try {
    vm.firecrackerProcess.kill();
    vmLogger.debug({ vmId: vm.id }, "firecracker process killed");
  } catch {}

  try {
    if (fs.existsSync(vm.apiSock)) {
      fs.unlinkSync(vm.apiSock);
      vmLogger.debug({ path: vm.apiSock }, "API socket removed");
    }

    if (fs.existsSync(vm.vsock)) {
      fs.unlinkSync(vm.vsock);
      vmLogger.debug({ path: vm.vsock }, "vsock removed");
    }
  } catch {}

  try {
    if (vm.jailDir) {
      removeJail(vm.jailDir);
      vmLogger.debug({ path: vm.jailDir }, "jail directory removed");
    }
  } catch (err) {
    vmLogger.warn({ vmId: vm.id, err }, "failed to remove jail directory");
  }

  try {
    if (vm.networkInfo) {
      await teardownVmNetwork(vm.networkInfo);
      vmLogger.debug({ nsName: vm.networkInfo.nsName }, "network namespace removed");
    }
  } catch (err) {
    vmLogger.warn({ vmId: vm.id, err }, "failed to teardown VM network");
  }

  vmCleanupTotal.inc();
  vmCount.dec({ function_id: sessionId, state: vm.state });

  vmLogger.info(
    { sessionId, vmId: vm.id },
    "VM cleanup completed",
  );
}
