import crypto from "crypto";
import { time, computeStats, type BenchmarkSuite, type TimingResult } from "../harness.js";
import { sendSessionMessage } from "../../session/gateway.js";
import { destroySession } from "../../session/session.js";
import type { BenchSuiteOptions } from "./vm-lifecycle.js";

export async function runGatewaySuite(opts: BenchSuiteOptions): Promise<BenchmarkSuite> {
  const levels: number[] = Array.isArray(opts.concurrency)
    ? opts.concurrency
    : typeof opts.concurrency === "number"
    ? [opts.concurrency]
    : [5];

  const samples: Record<string, number[]> = {
    cold_session_start: [],
    warm_session_message: [],
    file_write_roundtrip: [],
    file_read_roundtrip: [],
  };

  for (const lvl of levels) {
    samples[`concurrent_burst_${lvl}`] = [];
  }

  const totalRuns = opts.iterations > 1 ? opts.iterations + 1 : opts.iterations;

  for (let i = 0; i < totalRuns; i++) {
    const isWarmup = opts.iterations > 1 && i === 0;
    const sessionId = `bench-gw-${crypto.randomBytes(4).toString("hex")}`;

    // 1. Cold session start
    const { durationMs: coldMs } = await time(() =>
      sendSessionMessage(
        sessionId,
        { type: "execute", command: "echo", args: ["cold_gateway"] },
        undefined,
        60000,
        opts.template,
      ),
    );

    // 2. Warm session message
    const { durationMs: warmMs } = await time(() =>
      sendSessionMessage(
        sessionId,
        { type: "execute", command: "echo", args: ["warm_gateway"] },
        undefined,
        60000,
      ),
    );

    // 3. File write roundtrip
    const dummyContent = Buffer.from("benchmark gateway file content\n").toString("base64");
    const { durationMs: writeMs } = await time(() =>
      sendSessionMessage(
        sessionId,
        { type: "write_file", path: "bench.txt", content: dummyContent },
        undefined,
        60000,
      ),
    );

    // 4. File read roundtrip
    const { durationMs: readMs } = await time(() =>
      sendSessionMessage(
        sessionId,
        { type: "read_file", path: "bench.txt" },
        undefined,
        60000,
      ),
    );

    // Clean up single session
    await destroySession(sessionId);

    // 5. Concurrent bursts for each requested concurrency tier
    const burstResults: Record<number, number> = {};
    for (const lvl of levels) {
      const burstSessionIds = Array.from(
        { length: lvl },
        () => `bench-burst-${lvl}-${crypto.randomBytes(4).toString("hex")}`,
      );

      const { durationMs: burstMs } = await time(async () => {
        await Promise.all(
          burstSessionIds.map((sid) =>
            sendSessionMessage(
              sid,
              { type: "execute", command: "echo", args: ["burst"] },
              undefined,
              60000,
              opts.template,
            ),
          ),
        );
      });

      await Promise.all(burstSessionIds.map((sid) => destroySession(sid)));
      burstResults[lvl] = burstMs;
    }

    if (!isWarmup) {
      samples.cold_session_start!.push(coldMs);
      samples.warm_session_message!.push(warmMs);
      samples.file_write_roundtrip!.push(writeMs);
      samples.file_read_roundtrip!.push(readMs);
      for (const lvl of levels) {
        samples[`concurrent_burst_${lvl}`]!.push(burstResults[lvl]!);
      }
    }
  }

  const results: TimingResult[] = Object.keys(samples).map((key) =>
    computeStats(key, samples[key] ?? []),
  );

  return { name: "Session Gateway", results };
}
