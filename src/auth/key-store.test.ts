import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  createKey,
  verifyKey,
  revokeKey,
  deleteKey,
  listKeys,
  rotateKey,
  clearKeysStore,
} from "./key-store.js";

describe("KeyStore", () => {
  let tmpDir: string;
  let keysPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keystore-test-"));
    keysPath = path.join(tmpDir, "keys.json");
    process.env.AUTH_KEYS_PATH = keysPath;
    clearKeysStore();
  });

  afterEach(() => {
    delete process.env.AUTH_KEYS_PATH;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { }
  });

  it("creates key and saves rawKey with prefix sk_test_", () => {
    const { record, rawKey } = createKey("test-key", ["exec"], 100);
    expect(rawKey).toMatch(/^sk_test_[a-f0-9]{32}$/);
    expect(record.name).toBe("test-key");
    expect(record.scopes).toEqual(["exec"]);
    expect(record.rateLimit).toBe(100);
    expect(record.enabled).toBe(true);
  });

  it("verifies valid rawKey successfully", () => {
    const { rawKey } = createKey("test-key", ["exec", "admin"]);
    const verified = verifyKey(rawKey);
    expect(verified).not.toBeNull();
    expect(verified?.name).toBe("test-key");
    expect(verified?.scopes).toEqual(["exec", "admin"]);
  });

  it("rejects invalid or non-existent rawKey", () => {
    createKey("test-key");
    expect(verifyKey("sk_test_invalidkey12345678901234567890")).toBeNull();
  });

  it("revokes key and prevents subsequent verification", () => {
    const { record, rawKey } = createKey("test-key");
    expect(verifyKey(rawKey)).not.toBeNull();

    const revoked = revokeKey(record.id);
    expect(revoked).toBe(true);
    expect(verifyKey(rawKey)).toBeNull();
  });

  it("deletes key from store", () => {
    const { record, rawKey } = createKey("test-key");
    const deleted = deleteKey(record.id);
    expect(deleted).toBe(true);
    expect(verifyKey(rawKey)).toBeNull();
    expect(listKeys()).toHaveLength(0);
  });

  it("rotates key generating new rawKey and disabling old key", () => {
    const { record: oldRecord, rawKey: oldRawKey } = createKey("test-key", ["exec"]);
    const rotated = rotateKey(oldRecord.id);

    expect(rotated).not.toBeNull();
    expect(verifyKey(oldRawKey)).toBeNull();
    expect(verifyKey(rotated!.rawKey)).not.toBeNull();
  });

  it("redacts keyHash in listKeys", () => {
    createKey("test-key");
    const list = listKeys();
    expect(list[0]).not.toHaveProperty("keyHash");
    expect(list[0]).toHaveProperty("keyPrefix");
  });
});
