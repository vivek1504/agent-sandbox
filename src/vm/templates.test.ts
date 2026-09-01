import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  loadTemplateRegistry,
  getTemplate,
  listTemplates,
  resolveTemplateName,
  getDefaultTemplate,
} from "./templates.js";
import * as jailer from "./jailer.js";

describe("templates registry", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "template-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("loads templates from directory with template.json", () => {
    const templatesDir = path.join(tmpDir, "templates");
    const nodeDir = path.join(templatesDir, "node");
    fs.mkdirSync(nodeDir, { recursive: true });

    const manifest = {
      name: "node",
      displayName: "Node.js 22",
      version: "1.0.0",
      description: "Node.js environment",
      tools: ["node", "npm"],
      baseImage: "alpine:3.20",
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync(path.join(nodeDir, "template.json"), JSON.stringify(manifest));
    fs.writeFileSync(path.join(nodeDir, "rootfs.ext4"), "fake-rootfs");
    fs.writeFileSync(path.join(nodeDir, "snapshot"), "fake-snapshot");
    fs.writeFileSync(path.join(nodeDir, "memory"), "fake-memory");

    vi.spyOn(jailer, "ARTIFACTS_DIR", "get").mockReturnValue(tmpDir);

    loadTemplateRegistry();

    const template = getTemplate("node");
    expect(template).toBeDefined();
    expect(template?.manifest.displayName).toBe("Node.js 22");

    const list = listTemplates();
    expect(list.some((t) => t.name === "node")).toBe(true);

    expect(resolveTemplateName()).toBe("node");
    expect(resolveTemplateName("node")).toBe("node");
    expect(getDefaultTemplate().manifest.name).toBe("node");
  });

  it("throws error when resolving non-existent template", () => {
    expect(() => resolveTemplateName("non-existent-template")).toThrow("Unknown template");
  });
});
