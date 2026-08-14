import fs from "fs";
import path from "path";
import { ARTIFACTS_DIR } from "./jailer.js";
import { vmLogger } from "../logger.js";

export interface TemplateManifest {
  name: string;
  displayName: string;
  version: string;
  description: string;
  tools: string[];
  baseImage: string;
  resources?: {
    memSizeMib?: number;
    vcpuCount?: number;
  };
  createdAt: string;
}

export interface ResolvedTemplate {
  manifest: TemplateManifest;
  rootfsPath: string;
  snapshotPath: string;
  memoryPath: string;
}

const DEFAULT_TEMPLATE = "node";
const templates = new Map<string, ResolvedTemplate>();

export function getTemplate(name: string): ResolvedTemplate | undefined {
  return templates.get(name);
}

export function getDefaultTemplate(): ResolvedTemplate {
  const t = templates.get(DEFAULT_TEMPLATE);
  if (!t) throw new Error(`Default template "${DEFAULT_TEMPLATE}" not found`);
  return t;
}

export function listTemplates(): TemplateManifest[] {
  return [...templates.values()].map(t => t.manifest);
}

export function resolveTemplateName(input?: string): string {
  if (!input || input === "exec") return DEFAULT_TEMPLATE;
  if (!templates.has(input)) {
    throw new Error(
      `Unknown template "${input}". Available: ${[...templates.keys()].join(", ")}`
    );
  }
  return input;
}

export function loadTemplateRegistry(): void {
  const templatesDir = path.join(ARTIFACTS_DIR, "templates");

  if (!fs.existsSync(templatesDir)) {
    registerLegacyTemplate();
    return;
  }

  const entries = fs.readdirSync(templatesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const templateDir = path.join(templatesDir, entry.name);
    try {
      registerTemplate(templateDir);
    } catch (err) {
      vmLogger.warn(
        { templateDir, err },
        "skipping invalid template directory"
      );
    }
  }

  if (templates.size === 0) {
    registerLegacyTemplate();
  }

  vmLogger.info(
    { count: templates.size, templates: [...templates.keys()] },
    "template registry loaded"
  );
}

function registerTemplate(templateDir: string): void {
  const manifestPath = path.join(templateDir, "template.json");
  const rootfsPath = path.join(templateDir, "rootfs.ext4");
  const snapshotPath = path.join(templateDir, "snapshot");
  const memoryPath = path.join(templateDir, "memory");

  for (const f of [manifestPath, rootfsPath, snapshotPath, memoryPath]) {
    if (!fs.existsSync(f)) {
      throw new Error(`Missing required file: ${f}`);
    }
  }

  const manifest: TemplateManifest = JSON.parse(
    fs.readFileSync(manifestPath, "utf-8")
  );

  templates.set(manifest.name, {
    manifest,
    rootfsPath,
    snapshotPath,
    memoryPath,
  });
}

function registerLegacyTemplate(): void {
  const rootfsPath = path.join(ARTIFACTS_DIR, "rootfs.ext4");
  const snapshotPath = path.join(ARTIFACTS_DIR, "snapshot-exec");
  const memoryPath = path.join(ARTIFACTS_DIR, "mem-exec");

  for (const f of [rootfsPath, snapshotPath, memoryPath]) {
    if (!fs.existsSync(f)) {
      vmLogger.warn({ path: f }, "legacy artifact missing");
      return;
    }
  }

  templates.set("node", {
    manifest: {
      name: "node",
      displayName: "Node.js (Legacy)",
      version: "0.0.0",
      description: "Default Node.js environment (legacy flat artifacts)",
      tools: ["node", "npm", "sh"],
      baseImage: "alpine",
      createdAt: new Date().toISOString(),
    },
    rootfsPath,
    snapshotPath,
    memoryPath,
  });

  vmLogger.info("registered legacy artifacts as 'node' template");
}
