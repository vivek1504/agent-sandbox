import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanupVm } from "./cleanup.js";
import fs from "fs";
import type { Vm } from "./vm-manager.js";

function makeVm(overrides = {}): Vm {
  return {
    id: "test",
    state: "ready",
    firecrackerProcess: { kill: vi.fn() } as any,
    apiSock: "/tmp/test-api.sock",
    vsock: "/tmp/test-vsock.sock",
    ...overrides,
  };
}

describe("cleanupVm", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("kills the process and removes sockets", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "unlinkSync").mockImplementation(() => {});

    const vm = makeVm();
    await cleanupVm("session-1", vm);

    expect(vm.firecrackerProcess.kill).toHaveBeenCalled();
    expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
  });

  it("skips if already cleaned", async () => {
    const vm = makeVm({ cleaned: true });
    await cleanupVm("session-1", vm);
    expect(vm.firecrackerProcess.kill).not.toHaveBeenCalled();
  });
});
