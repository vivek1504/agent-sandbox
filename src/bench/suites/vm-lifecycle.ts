import crypto from "crypto";
import { spawn } from "child_process";
import { time, computeStats, type BenchmarkSuite, type TimingResult } from "../harness.js";
import { getTemplate, resolveTemplateName } from "../../vm/templates.js";
import { loadResourceConfig, prepareJail, removeJail, JAILER_BIN, jailerArgs } from "../../vm/jailer.js";
import { loadEgressPolicy } from "../../vm/egress-policy.js";
import { setupVmNetwork, teardownVmNetwork } from "../../vm/networking.js";
import { waitForFirecrackerApiSocket, createFcClient, restoreVm } from "../../vm/vm-manager.js";
import { connectVsock } from "../../vm/transport.js";
import { readVsockResponse } from "../../vm/protocol.js";

export interface BenchSuiteOptions {
  iterations: number;
  template: string;
  concurrency?: number | number[];
}

export async function runVmLifecycleSuite(opts: BenchSuiteOptions): Promise<BenchmarkSuite> {
  const resolvedName = resolveTemplateName(opts.template);
  const template = getTemplate(resolvedName);

  if (!template) {
    throw new Error(`Template "${opts.template}" not found. Ensure template files exist in artifacts.`);
  }

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
    network_setup: [],
    jail_setup: [],
    jailer_spawn: [],
    api_socket_ready: [],
    snapshot_restore: [],
    vsock_connect: [],
    first_message_rtt: [],
    warm_message_rtt: [],
    TOTAL_COLD_START: [],
  };

  // Perform 1 warmup run if iterations > 1
  const totalRuns = opts.iterations > 1 ? opts.iterations + 1 : opts.iterations;

  for (let i = 0; i < totalRuns; i++) {
    const isWarmup = opts.iterations > 1 && i === 0;
    const instanceId = `bench-${crypto.randomBytes(4).toString("hex")}`;

    // Phase 1: Network
    const { result: networkInfo, durationMs: netMs } = await time(() =>
      setupVmNetwork(instanceId, egressPolicy),
    );

    // Phase 2: Jail
    const { result: jail, durationMs: jailMs } = await time(() =>
      prepareJail(instanceId, template),
    );

    // Phase 3: Jailer spawn
    const { result: fc, durationMs: spawnMs } = await time(async () => {
      const child = spawn(JAILER_BIN, jailerArgs(instanceId, networkInfo.nsPath, mergedResources));
      child.on("error", () => {});
      return child;
    });

    // Phase 4: API socket ready
    const { durationMs: socketMs } = await time(() =>
      waitForFirecrackerApiSocket(jail.apiSocket, 5000),
    );

    // Phase 5: Snapshot restore
    const client = createFcClient(jail.apiSocket);
    const { durationMs: restoreMs } = await time(() => restoreVm(client, jail));

    // Phase 6: Vsock connect
    const { result: socket, durationMs: vsockMs } = await time(async () => {
      const sock = await connectVsock(jail.vsockSocket);
      sock.write("CONNECT 5000\n");
      return sock;
    });

    // Phase 7: First message RTT
    const firstMsgId = crypto.randomUUID();
    const { durationMs: firstMsgMs } = await time(async () => {
      const msg = { type: "execute", command: "echo", args: ["bench_first"], id: firstMsgId };
      socket.write(JSON.stringify(msg) + "\n");
      await readVsockResponse(socket, 10000, undefined, firstMsgId);
    });

    // Phase 8: Warm message RTT
    const warmMsgId = crypto.randomUUID();
    const { durationMs: warmMsgMs } = await time(async () => {
      const msg = { type: "execute", command: "echo", args: ["bench_warm"], id: warmMsgId };
      socket.write(JSON.stringify(msg) + "\n");
      await readVsockResponse(socket, 10000, undefined, warmMsgId);
    });

    const totalMs = netMs + jailMs + spawnMs + socketMs + restoreMs + vsockMs + firstMsgMs;

    // Cleanup
    try {
      socket.destroy();
      fc.kill("SIGKILL");
      removeJail(jail.instanceDir);
      await teardownVmNetwork(networkInfo);
    } catch {}

    if (!isWarmup) {
      samples.network_setup!.push(netMs);
      samples.jail_setup!.push(jailMs);
      samples.jailer_spawn!.push(spawnMs);
      samples.api_socket_ready!.push(socketMs);
      samples.snapshot_restore!.push(restoreMs);
      samples.vsock_connect!.push(vsockMs);
      samples.first_message_rtt!.push(firstMsgMs);
      samples.warm_message_rtt!.push(warmMsgMs);
      samples.TOTAL_COLD_START!.push(totalMs);
    }
  }

  const results: TimingResult[] = Object.keys(samples).map((key) =>
    computeStats(key, samples[key] ?? []),
  );

  return { name: "VM Lifecycle", results };
}
