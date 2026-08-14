import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  addEntry,
  removeEntry,
  loadManifest,
  getEntries,
  clearManifest,
  type ManifestEntry,
} from "./manifest.js";

describe("manifest", () => {
  let tmpDir: string;
  let tmpManifestPath: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-test-"));
    tmpManifestPath = path.join(tmpDir, "sessions.json");
    originalEnv = process.env.SESSION_MANIFEST_PATH;
    process.env.SESSION_MANIFEST_PATH = tmpManifestPath;
    clearManifest();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SESSION_MANIFEST_PATH;
    } else {
      process.env.SESSION_MANIFEST_PATH = originalEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds and loads entries atomically", () => {
    const entry: ManifestEntry = {
      sessionId: "s1",
      vmId: "vm1",
      createdAt: 1000,
      slot: 5,
      nsName: "ns-vm1",
      jailDir: "/var/lib/lambda/jailer/firecracker/vm1",
    };

    addEntry(entry);

    expect(fs.existsSync(tmpManifestPath)).toBe(true);
    expect(getEntries()).toEqual([entry]);

    const loaded = loadManifest();
    expect(loaded).toEqual([entry]);
  });

  it("removes entries correctly", () => {
    const entry1: ManifestEntry = {
      sessionId: "s1",
      vmId: "vm1",
      createdAt: 1000,
      slot: 5,
      nsName: "ns-vm1",
      jailDir: "/path/1",
    };
    const entry2: ManifestEntry = {
      sessionId: "s2",
      vmId: "vm2",
      createdAt: 2000,
      slot: 6,
      nsName: "ns-vm2",
      jailDir: "/path/2",
    };

    addEntry(entry1);
    addEntry(entry2);
    expect(getEntries().length).toBe(2);

    removeEntry("s1");
    expect(getEntries()).toEqual([entry2]);
    expect(loadManifest()).toEqual([entry2]);
  });
});
