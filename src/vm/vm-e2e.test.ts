import { describe, it, expect } from "vitest";
import fs from "fs";
import {
  FIRECRACKER_BIN,
  JAILER_BIN,
  ARTIFACTS_DIR,
  loadResourceConfig,
} from "./jailer.js";
import { createVm } from "./vm-manager.js";
import { cleanupVm } from "./cleanup.js";
import { getVmSocket } from "./transport.js";
import { readVsockResponse } from "./protocol.js";
import { loadTemplateRegistry, getTemplate, listTemplates } from "./templates.js";
import crypto from "crypto";

function checkE2EPrerequisites(): { ready: boolean; reason?: string } {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    return { ready: false, reason: "Requires root (CAP_NET_ADMIN / CAP_SYS_ADMIN) privileges" };
  }

  if (!fs.existsSync("/dev/kvm")) {
    return { ready: false, reason: "/dev/kvm not found" };
  }

  try {
    fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    return { ready: false, reason: "/dev/kvm is not readable/writable" };
  }

  if (!fs.existsSync(FIRECRACKER_BIN) || !fs.existsSync(JAILER_BIN)) {
    return { ready: false, reason: `Firecracker/Jailer binaries not found at ${FIRECRACKER_BIN}` };
  }

  loadTemplateRegistry();
  const templates = listTemplates();
  if (templates.length === 0) {
    return { ready: false, reason: `No templates found in ${ARTIFACTS_DIR}/templates` };
  }

  return { ready: true };
}

describe("Firecracker microVM End-to-End Integration", () => {
  const { ready, reason } = checkE2EPrerequisites();

  it.skipIf(!ready)(
    `boots a real microVM, restores snapshot, executes command via vsock, and cleans up [${reason ?? "ready"}]`,
    async () => {
      loadTemplateRegistry();
      const templateName = getTemplate("node")?.manifest.name ?? listTemplates()[0]?.name;
      expect(templateName).toBeDefined();

      const testSessionId = `e2e-${crypto.randomBytes(4).toString("hex")}`;
      const vm = await createVm(testSessionId, templateName);

      try {
        expect(vm.state).toBe("ready");
        expect(vm.id).toBeDefined();
        expect(vm.vsock).toBeDefined();

        const socket = await getVmSocket(vm);
        expect(socket.destroyed).toBe(false);

        const msgId = crypto.randomUUID();
        const testPayload = {
          id: msgId,
          type: "execute",
          command: "echo",
          args: ["agent-sandbox-e2e-passed"],
        };

        socket.write(JSON.stringify(testPayload) + "\n");
        const response = await readVsockResponse(socket, 15000, undefined, msgId);

        expect(response.type).toBe("response");
        expect(response.data?.exitCode).toBe(0);
      } finally {
        await cleanupVm(testSessionId, vm);
        expect(vm.cleaned).toBe(true);
      }
    },
    30000,
  );

  it("handles environment prerequisite verification gracefully", () => {
    const status = checkE2EPrerequisites();
    expect(typeof status.ready).toBe("boolean");
    if (!status.ready) {
      expect(typeof status.reason).toBe("string");
    }
  });
});
