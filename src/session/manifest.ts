import fs from "fs";
import path from "path";
import { logger } from "../logger.js";

export interface ManifestEntry {
  sessionId: string;
  vmId: string;
  createdAt: number;
  slot: number;
  nsName: string;
  jailDir: string;
  templateName?: string | undefined;
}

export function getManifestPath(): string {
  return process.env.SESSION_MANIFEST_PATH ?? "/var/lib/agent-sandbox/sessions.json";
}

let entries: ManifestEntry[] = [];
let loaded = false;

export function loadManifest(): ManifestEntry[] {
  const manifestPath = getManifestPath();
  try {
    if (fs.existsSync(manifestPath)) {
      entries = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      loaded = true;
      return entries;
    }
  } catch (err) {
    logger.warn({ err, path: manifestPath }, "failed to load session manifest");
  }
  entries = [];
  loaded = true;
  return entries;
}

export function saveManifest(): void {
  const manifestPath = getManifestPath();
  try {
    const dir = path.dirname(manifestPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = manifestPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
    fs.renameSync(tmp, manifestPath);
  } catch (err) {
    logger.warn({ err, path: manifestPath }, "failed to save session manifest");
  }
}

export function addEntry(entry: ManifestEntry): void {
  if (!loaded) loadManifest();
  entries.push(entry);
  saveManifest();
}

export function removeEntry(sessionId: string): void {
  if (!loaded) loadManifest();
  entries = entries.filter((e) => e.sessionId !== sessionId);
  saveManifest();
}

export function clearManifest(): void {
  entries = [];
  saveManifest();
}

export function getEntries(): ManifestEntry[] {
  if (!loaded) loadManifest();
  return [...entries];
}
