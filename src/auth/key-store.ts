import fs from "fs";
import path from "path";
import crypto from "crypto";
import { logger } from "../logger.js";

export type Scope = "exec" | "admin" | "metrics";

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  scopes: Scope[];
  rateLimit: number;
  createdAt: number;
  lastUsedAt: number;
  expiresAt?: number | undefined;
  enabled: boolean;
}

export interface ResolvedKey {
  id: string;
  name: string;
  scopes: Scope[];
  rateLimit: number;
}

export function getKeysPath(): string {
  return process.env.AUTH_KEYS_PATH ?? "/var/lib/agent-sandbox/keys.json";
}

let keys: ApiKeyRecord[] = [];
let loaded = false;

export function loadKeys(): ApiKeyRecord[] {
  const keysPath = getKeysPath();
  try {
    if (fs.existsSync(keysPath)) {
      keys = JSON.parse(fs.readFileSync(keysPath, "utf-8"));
      loaded = true;
      return keys;
    }
  } catch (err) {
    logger.warn({ err, path: keysPath }, "failed to load API keys");
  }
  keys = [];
  loaded = true;
  return keys;
}

export function saveKeys(): void {
  const keysPath = getKeysPath();
  try {
    const dir = path.dirname(keysPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = keysPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(keys, null, 2));
    fs.renameSync(tmp, keysPath);
  } catch (err) {
    logger.warn({ err, path: keysPath }, "failed to save API keys");
  }
}

export function hashKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

export function createKey(
  name: string,
  scopes: Scope[] = ["exec"],
  rateLimit: number = 0,
  expiresAt?: number,
): { record: ApiKeyRecord; rawKey: string } {
  if (!loaded) loadKeys();

  const id = crypto.randomBytes(4).toString("hex");
  const randomPart = crypto.randomBytes(16).toString("hex");
  const prefix = process.env.AUTH_KEY_PREFIX ?? "sk_test_";
  const rawKey = `${prefix}${randomPart}`;
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.substring(0, 12);

  const record: ApiKeyRecord = {
    id,
    name,
    keyHash,
    keyPrefix,
    scopes,
    rateLimit,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    enabled: true,
  };

  keys.push(record);
  saveKeys();

  return { record, rawKey };
}

export function verifyKey(rawKey: string): ResolvedKey | null {
  if (!loaded) loadKeys();
  if (!rawKey) return null;

  const keyHash = hashKey(rawKey);
  const record = keys.find((k) => k.keyHash === keyHash);

  if (!record || !record.enabled) return null;
  if (record.expiresAt && Date.now() > record.expiresAt) return null;

  return {
    id: record.id,
    name: record.name,
    scopes: [...record.scopes],
    rateLimit: record.rateLimit,
  };
}

let saveTimer: NodeJS.Timeout | null = null;
const SAVE_DEBOUNCE_MS = 1000;

export function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveKeys();
  }, SAVE_DEBOUNCE_MS);
}

export function flushKeys(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    saveKeys();
  }
}

export function touchKey(id: string): void {
  if (!loaded) loadKeys();
  const record = keys.find((k) => k.id === id);
  if (record) {
    record.lastUsedAt = Date.now();
    scheduleSave();
  }
}

export function revokeKey(id: string): boolean {
  if (!loaded) loadKeys();
  const record = keys.find((k) => k.id === id);
  if (!record) return false;
  record.enabled = false;
  saveKeys();
  return true;
}

export function deleteKey(id: string): boolean {
  if (!loaded) loadKeys();
  const initialLength = keys.length;
  keys = keys.filter((k) => k.id !== id);
  if (keys.length !== initialLength) {
    saveKeys();
    return true;
  }
  return false;
}

export function listKeys(): Omit<ApiKeyRecord, "keyHash">[] {
  if (!loaded) loadKeys();
  return keys.map(({ keyHash, ...rest }) => rest);
}

export function rotateKey(id: string): { record: ApiKeyRecord; rawKey: string } | null {
  if (!loaded) loadKeys();
  const old = keys.find((k) => k.id === id);
  if (!old) return null;

  old.enabled = false;
  const newKey = createKey(old.name, old.scopes, old.rateLimit, old.expiresAt);
  saveKeys();
  return newKey;
}

export function clearKeysStore(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  keys = [];
  loaded = false;
}
