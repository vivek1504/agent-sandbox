import path from "path";
import fs from "fs";
import crypto from "crypto";
import { execSync } from "child_process";
import { time, computeStats, type BenchmarkSuite, type TimingResult } from "../harness.js";
import type { BenchSuiteOptions } from "./vm-lifecycle.js";

function execQuiet(cmd: string, cwd?: string): void {
  execSync(cmd, { stdio: "pipe", cwd });
}

export async function runTemplateSuite(opts: BenchSuiteOptions): Promise<BenchmarkSuite> {
  const template = opts.template || "node";
  const projectRoot = path.resolve(process.cwd());
  const templatesDir = path.join(projectRoot, "templates");

  const samples: Record<string, number[]> = {
    docker_base_build: [],
    docker_template_build: [],
    rootfs_extraction: [],
    snapshot_creation: [],
    TOTAL_TEMPLATE_PIPELINE: [],
  };

  // Run 1 iteration since template build is heavy
  const iterations = 1;

  for (let i = 0; i < iterations; i++) {
    // 1. Docker base build
    const { durationMs: baseMs } = await time(() =>
      execQuiet(
        `docker build --no-cache -t agent-sandbox-base -f "${templatesDir}/base/Dockerfile" "${projectRoot}"`,
      ),
    );

    // 2. Docker template build
    const { durationMs: tmplBuildMs } = await time(() =>
      execQuiet(
        `docker build --no-cache -t agent-sandbox-${template} -f "${templatesDir}/${template}/Dockerfile" "${projectRoot}"`,
      ),
    );

    // 3. Rootfs export
    const rootfsSize = 1024;
    const rootfsPath = `/tmp/bench-rootfs-${template}.ext4`;
    const mountDir = `/tmp/mnt-bench-${crypto.randomUUID().slice(0, 8)}`;

    const { durationMs: rootfsMs } = await time(() => {
      try {
        execQuiet(`umount -l "${rootfsPath}" 2>/dev/null || true`);
      } catch {}

      execQuiet(`dd if=/dev/zero of="${rootfsPath}" bs=1M count=${rootfsSize}`);
      execQuiet(`mkfs.ext4 -F "${rootfsPath}"`);
      execQuiet(`mkdir -p "${mountDir}"`);
      execQuiet(`mount -o loop "${rootfsPath}" "${mountDir}"`);

      const containerId = execSync(`docker create "agent-sandbox-${template}"`, {
        encoding: "utf-8",
      }).trim();

      execQuiet(`docker export "${containerId}" | tar -x -C "${mountDir}"`);
      execQuiet(`docker rm "${containerId}"`);
      execQuiet(`umount "${mountDir}"`);
      execQuiet(`rmdir "${mountDir}"`);
    });

    // 4. Snapshot creation
    const { durationMs: snapMs } = await time(() => {
      execQuiet(`npx tsc -b`, projectRoot);
      execQuiet(
        `sudo rm -rf "/var/lib/agent-sandbox/jailer/firecracker/snap-${template}"`,
      );
      execQuiet(
        `sudo node dist/create_snapshot.js "${template}" "${rootfsPath}"`,
        projectRoot,
      );
    });

    try {
      if (fs.existsSync(rootfsPath)) fs.unlinkSync(rootfsPath);
    } catch {}

    const totalMs = baseMs + tmplBuildMs + rootfsMs + snapMs;

    samples.docker_base_build!.push(baseMs);
    samples.docker_template_build!.push(tmplBuildMs);
    samples.rootfs_extraction!.push(rootfsMs);
    samples.snapshot_creation!.push(snapMs);
    samples.TOTAL_TEMPLATE_PIPELINE!.push(totalMs);
  }

  const results: TimingResult[] = Object.keys(samples).map((key) =>
    computeStats(key, samples[key] ?? []),
  );

  return { name: "Template Build Pipeline", results };
}
