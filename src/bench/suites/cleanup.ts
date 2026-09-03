import crypto from "crypto";
import { spawn } from "child_process";
import fs from "fs";
import { time, computeStats, type BenchmarkSuite, type TimingResult } from "../harness.js";
import { getTemplate, resolveTemplateName } from "../../vm/templates.js";
import { prepareJail, removeJail, JAILER_BIN, jailerArgs, loadResourceConfig } from "../../vm/jailer.js";
import { setupVmNetwork, teardownVmNetwork } from "../../vm/networking.js";
import { loadEgressPolicy } from "../../vm/egress-policy.js";
import { cleanupVm } from "../../vm/cleanup.js";
import { waitForFirecrackerApiSocket, createFcClient, restoreVm, type Vm } from "../../vm/vm-manager.js";
import type { BenchSuiteOptions } from "./vm-lifecycle.js";

export async function runCleanupSuite(opts: BenchSuiteOptions): Promise<BenchmarkSuite> {
  const resolvedName = resolveTemplateName(opts.template);
  const template = getTemplate(resolvedName)!;
  const resources = loadResourceConfig();
  const mergedResources = {
    ...resources,
    ...(template.manifest.resources?.memSizeMib
      ? { memSizeMib: template.manifest.resources.memSizeMib }
      : {}),
    ...(template.manifest.resources?.vcpuCount
      ? { vcpuCount: template.manifest.resources.vcpuCount }
      : {}),
  };
  const egressPolicy = loadEgressPolicy();

  const samples: Record<string, number[]> = {
    fc_process_kill: [],
    jail_directory_rmrf: [],
    network_teardown: [],
    full_cleanupVm: [],
  };

  const totalRuns = opts.iterations > 1 ? opts.iterations + 1 : opts.iterations;

  for (let i = 0; i < totalRuns; i++) {
    const isWarmup = opts.iterations > 1 && i === 0;
    const instanceId = `bench-clean-${crypto.randomBytes(4).toString("hex")}`;

    // Setup a VM
    const networkInfo = await setupVmNetwork(instanceId, egressPolicy);
    const jail = prepareJail(instanceId, template);
    const fc = spawn(JAILER_BIN, jailerArgs(instanceId, networkInfo.nsPath, mergedResources));
    await waitForFirecrackerApiSocket(jail.apiSocket, 5000);
    const client = createFcClient(jail.apiSocket);
    await restoreVm(client, jail);

    // Step 1: fc_process_kill (measure actual exit, not just signal delivery)
    const { durationMs: killMs } = await time(async () => {
      try {
        fc.kill("SIGKILL");
      } catch {}
      await new Promise<void>((resolve) => {
        if (fc.exitCode !== null) return resolve();
        fc.once("exit", () => resolve());
        setTimeout(resolve, 5000);
      });
    });

    // Step 2: jail_directory_rmrf
    const { durationMs: rmJailMs } = await time(() => {
      try {
        if (fs.existsSync(jail.instanceDir)) {
          removeJail(jail.instanceDir);
        }
      } catch {}
    });

    // Step 3: network_teardown
    const { durationMs: netTeardownMs } = await time(() => {
      try {
        return teardownVmNetwork(networkInfo);
      } catch {}
    });

    // Step 4: full_cleanupVm
    const fullInstanceId = `bench-cleanfull-${crypto.randomBytes(4).toString("hex")}`;
    const fullNet = await setupVmNetwork(fullInstanceId, egressPolicy);
    const fullJail = prepareJail(fullInstanceId, template);
    const fullFc = spawn(JAILER_BIN, jailerArgs(fullInstanceId, fullNet.nsPath, mergedResources));
    await waitForFirecrackerApiSocket(fullJail.apiSocket, 5000);

    const vm: Vm = {
      id: fullInstanceId,
      state: "ready",
      firecrackerProcess: fullFc,
      apiSock: fullJail.apiSocket,
      vsock: fullJail.vsockSocket,
      jailDir: fullJail.instanceDir,
      networkInfo: fullNet,
    };

    const { durationMs: fullCleanupMs } = await time(() =>
      cleanupVm("bench-session", vm),
    );

    if (!isWarmup) {
      samples.fc_process_kill!.push(killMs);
      samples.jail_directory_rmrf!.push(rmJailMs);
      samples.network_teardown!.push(netTeardownMs);
      samples.full_cleanupVm!.push(fullCleanupMs);
    }
  }

  const results: TimingResult[] = Object.keys(samples).map((key) =>
    computeStats(key, samples[key] ?? []),
  );

  return { name: "Cleanup & Teardown", results };
}
