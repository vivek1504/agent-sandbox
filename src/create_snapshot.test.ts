import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import fs from "fs";
import { createFcClient, waitForFile, waitForVmReady } from "./run_deploy.js";

describe("waitForVmReady", () => {
  function makeFakeFirecracker() {
    return { stdout: new EventEmitter() };
  }

  it("resolves when READY arrives in one chunk", async () => {
    const fc = makeFakeFirecracker();
    const promise = waitForVmReady(fc);
    fc.stdout.emit("data", Buffer.from("booting...\nREADY\n"));
    await expect(promise).resolves.toBeUndefined();
  });

  it("resolves when READY is split across chunks", async () => {
    const fc = makeFakeFirecracker();
    const promise = waitForVmReady(fc);
    fc.stdout.emit("data", Buffer.from("REA"));
    fc.stdout.emit("data", Buffer.from("DY"));
    await expect(promise).resolves.toBeUndefined();
  });
});

describe("waitForFile", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns immediately if file exists", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    await expect(waitForFile("/tmp/test.sock", 1000)).resolves.toBeUndefined();
  });

  it("throws on timeout", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    await expect(waitForFile("/tmp/missing.sock", 200)).rejects.toThrow(
      "timeout waiting for socket",
    );
  });
});

describe("createFcClient", () => {
  it("creates an axios client with socketPath", () => {
    const client = createFcClient("/tmp/test.sock");
    expect(client.defaults.socketPath).toBe("/tmp/test.sock");
    expect(client.defaults.baseURL).toBe("http://localhost");
  });
});
