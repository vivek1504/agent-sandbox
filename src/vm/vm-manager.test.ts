import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import net from "net";

vi.mock("./jailer.js", () => ({
  JAILER_BIN: "/usr/local/bin/jailer",
  jailerArgs: vi.fn(() => ["--id", "test-vm"]),
  prepareJail: vi.fn(() => ({
    id: "test-vm",
    instanceDir: "/var/lib/agent-sandbox/jailer/firecracker/test-vm",
    rootDir: "/var/lib/agent-sandbox/jailer/firecracker/test-vm/root",
    apiSocket: "/tmp/test-api.socket",
    vsockSocket: "/tmp/test-vsock.socket",
    snapshotPath: "/artifacts/snapshot",
    memoryPath: "/artifacts/memory",
  })),
  removeJail: vi.fn(),
  loadResourceConfig: vi.fn(() => ({
    vcpuCount: 1,
    memSizeMib: 128,
    cpuQuotaUs: 50000,
    cpuPeriodUs: 100000,
    memoryLimitBytes: 128 * 1024 * 1024,
    noFileSoftLimit: 1024,
    diskLimitBytes: 512 * 1024 * 1024,
    pidsLimit: 256,
  })),
}));

vi.mock("./networking.js", () => ({
  setupVmNetwork: vi.fn().mockResolvedValue({
    slot: 1,
    nsName: "ns-test",
    nsPath: "/var/run/netns/ns-test",
    vethHost: "vh-test",
    vethNs: "vn-test",
    hostIp: "10.0.1.2",
    nsIp: "10.0.1.1",
    tapIp: "192.168.241.1",
    guestIp: "192.168.241.2",
  }),
  teardownVmNetwork: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./templates.js", () => ({
  resolveTemplateName: vi.fn(() => "node"),
  getTemplate: vi.fn(() => ({
    manifest: {
      name: "node",
      displayName: "Node",
      version: "1.0.0",
      description: "Node template",
      tools: ["node"],
      baseImage: "alpine",
      createdAt: "2026-08-01T00:00:00Z",
    },
    rootfsPath: "/artifacts/rootfs.ext4",
    snapshotPath: "/artifacts/snapshot",
    memoryPath: "/artifacts/memory",
  })),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    create: vi.fn(() => ({
      put: vi.fn().mockResolvedValue({ data: {} }),
    })),
  },
}));

import { spawn } from "child_process";
import axios from "axios";
import { createVm, restoreVm } from "./vm-manager.js";
import { removeJail } from "./jailer.js";
import { teardownVmNetwork } from "./networking.js";

describe("VM Manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates and restores a VM transitioning state to ready", async () => {
    const fakeProcess = new EventEmitter() as any;
    fakeProcess.kill = vi.fn();
    vi.mocked(spawn).mockReturnValue(fakeProcess);

    // Mock socket connection to return immediately
    vi.spyOn(net, "createConnection").mockImplementation(() => {
      const emitter = new EventEmitter() as any;
      emitter.destroy = vi.fn();
      setTimeout(() => emitter.emit("connect"), 5);
      return emitter;
    });

    const vm = await createVm("session-1", "node");

    expect(vm.state).toBe("ready");
    expect(vm.apiSock).toBe("/tmp/test-api.socket");
    expect(vm.vsock).toBe("/tmp/test-vsock.socket");
  });

  it("marks VM state as dead when firecracker process exits", async () => {
    const fakeProcess = new EventEmitter() as any;
    fakeProcess.kill = vi.fn();
    vi.mocked(spawn).mockReturnValue(fakeProcess);

    vi.spyOn(net, "createConnection").mockImplementation(() => {
      const emitter = new EventEmitter() as any;
      emitter.destroy = vi.fn();
      setTimeout(() => emitter.emit("connect"), 5);
      return emitter;
    });

    const vm = await createVm("session-2", "node");
    expect(vm.state).toBe("ready");

    fakeProcess.emit("exit", 137, "SIGKILL");
    expect(vm.state).toBe("dead");
  });

  it("cleans up jail and network resources if snapshot restore fails", async () => {
    const fakeProcess = new EventEmitter() as any;
    fakeProcess.kill = vi.fn();
    vi.mocked(spawn).mockReturnValue(fakeProcess);

    vi.spyOn(net, "createConnection").mockImplementation(() => {
      const emitter = new EventEmitter() as any;
      emitter.destroy = vi.fn();
      setTimeout(() => emitter.emit("connect"), 5);
      return emitter;
    });

    const fakeAxiosClient = {
      put: vi.fn().mockRejectedValue(new Error("Snapshot restore failed")),
    };
    vi.mocked(axios.create).mockReturnValue(fakeAxiosClient as any);

    await expect(createVm("session-fail", "node")).rejects.toThrow(
      "Snapshot restore failed",
    );

    expect(fakeProcess.kill).toHaveBeenCalled();
    expect(removeJail).toHaveBeenCalled();
    expect(teardownVmNetwork).toHaveBeenCalled();
  });

  it("configures Firecracker client with snapshot restore payload", async () => {
    const fakeAxiosClient = {
      put: vi.fn().mockResolvedValue({ data: {} }),
    };

    const jail: any = {
      instanceDir: "/jail",
      snapshotPath: "/artifacts/snapshot",
      memoryPath: "/artifacts/memory",
      vsockSocket: "/run/vsock.socket",
    };

    await restoreVm(fakeAxiosClient, jail);

    expect(fakeAxiosClient.put).toHaveBeenCalledWith("/snapshot/load", {
      snapshot_path: "/artifacts/snapshot",
      mem_backend: {
        backend_path: "/artifacts/memory",
        backend_type: "File",
      },
      track_dirty_pages: false,
      resume_vm: true,
    });
  });
});
