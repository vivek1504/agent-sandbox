import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "fs";

vi.mock("fs", () => ({
  default: {
    statSync: vi.fn(),
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    linkSync: vi.fn(),
    rmSync: vi.fn(),
  },
}));

import { loadResourceConfig, jailerArgs, prepareJail, removeJail, detectCgroupVersion } from "./jailer.js";

describe("jailer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("builds a jailed Firecracker command", () => {
    expect(jailerArgs("abc123")).toContain("--api-sock");
    expect(jailerArgs("abc123")).toContain("/run/api.socket");
  });

  it("stages snapshot artifacts before starting the jail", () => {
    vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const jail = prepareJail("abc123", "__exec__");

    expect(fs.linkSync).toHaveBeenCalledTimes(4);

    expect(fs.linkSync).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("snapshot-__exec__"),
      expect.stringContaining("artifacts/snapshot"),
    );

    expect(fs.linkSync).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("mem-__exec__"),
      expect.stringContaining("artifacts/memory"),
    );

    expect(fs.linkSync).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("rootfs.ext4"),
      expect.stringContaining("root/rootfs.ext4"),
    );

    expect(fs.linkSync).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("vmlinux"),
      expect.stringContaining("root/vmlinux"),
    );
    expect(jail.snapshotPath).toBe("/artifacts/snapshot");
    expect(jail.vsockSocket).toContain("abc123/root/run/vsock.socket");
  });

  it("rejects unsafe jail IDs and deletion paths", () => {
    expect(() => jailerArgs("../../bad")).toThrow("VM ID");
    expect(() => removeJail("/tmp/not-a-jail")).toThrow("outside");
  });

  it("includes cgroup CPU and memory limits in args", () => {
    const args = jailerArgs("test1", undefined, {
      ...loadResourceConfig(),
      cpuQuotaUs: 25_000,
      memoryLimitBytes: 64 * 1024 * 1024,
    });
    expect(args).toContain("--cgroup");
    const argsStr = args.join(" ");
    const cgroupVer = detectCgroupVersion();
    if (cgroupVer === 2) {
      expect(argsStr).toContain("--cgroup-version 2");
      expect(argsStr).toContain("cpu.max=25000 100000");
      expect(argsStr).toContain(`memory.max=${64 * 1024 * 1024}`);
    } else {
      expect(argsStr).toContain("--cgroup-version 1");
      expect(argsStr).toContain("cpu.cpu.cfs_quota_us=25000");
      expect(argsStr).toContain("cpu.cpu.cfs_period_us=100000");
      expect(argsStr).toContain(`memory.memory.limit_in_bytes=${64 * 1024 * 1024}`);
    }
  });
  it("uses default resources when none specified", () => {
    const args = jailerArgs("test2");
    const argsStr = args.join(" ");
    const cgroupVer = detectCgroupVersion();
    if (cgroupVer === 2) {
      expect(argsStr).toContain("cpu.max=50000 100000");
    } else {
      expect(argsStr).toContain("cpu.cpu.cfs_quota_us=50000");
    }
  });
});
