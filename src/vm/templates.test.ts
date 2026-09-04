import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  getTemplate,
  listTemplates,
  resolveTemplateName,
  loadTemplateRegistry,
} from "./templates.js";
import * as jailer from "./jailer.js";

describe("Template Registry", () => {
  let tmpDir: string;
  let artifactsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "template-test-"));
    artifactsDir = path.join(tmpDir, "artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });
    vi.spyOn(jailer, "ARTIFACTS_DIR", "get").mockReturnValue(artifactsDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("registers legacy template when no templates directory exists", () => {
    // Create legacy flat artifacts
    fs.writeFileSync(path.join(artifactsDir, "rootfs.ext4"), "fake rootfs");
    fs.writeFileSync(path.join(artifactsDir, "snapshot-exec"), "fake snapshot");
    fs.writeFileSync(path.join(artifactsDir, "mem-exec"), "fake mem");

    loadTemplateRegistry();

    const nodeTemplate = getTemplate("node");
    expect(nodeTemplate).toBeDefined();
    expect(nodeTemplate?.manifest.name).toBe("node");
    expect(resolveTemplateName()).toBe("node");
    expect(resolveTemplateName("exec")).toBe("node");
    expect(resolveTemplateName("node")).toBe("node");
  });

  it("throws error when resolving an unknown template", () => {
    expect(() => resolveTemplateName("non-existent-lang")).toThrow(
      /Unknown template "non-existent-lang"/,
    );
  });

  it("discovers and loads valid templates from templates directory", () => {
    const templatesDir = path.join(artifactsDir, "templates", "custom-python");
    fs.mkdirSync(templatesDir, { recursive: true });

    const manifest = {
      name: "custom-python",
      displayName: "Python 3.12 Custom",
      version: "1.0.0",
      description: "Python environment",
      tools: ["python3", "pip"],
      baseImage: "alpine",
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync(path.join(templatesDir, "template.json"), JSON.stringify(manifest));
    fs.writeFileSync(path.join(templatesDir, "rootfs.ext4"), "data");
    fs.writeFileSync(path.join(templatesDir, "snapshot"), "data");
    fs.writeFileSync(path.join(templatesDir, "memory"), "data");

    loadTemplateRegistry();

    const custom = getTemplate("custom-python");
    expect(custom).toBeDefined();
    expect(custom?.manifest.displayName).toBe("Python 3.12 Custom");

    const list = listTemplates();
    expect(list.some((t) => t.name === "custom-python")).toBe(true);
  });
});
