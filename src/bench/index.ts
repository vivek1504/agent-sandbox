import {
  formatTable,
  c,
  type BenchmarkSuite,
} from "./harness.js";
import { loadTemplateRegistry } from "../vm/templates.js";
import { ensureHostNetworkSetup } from "../vm/networking.js";
import { runVmLifecycleSuite } from "./suites/vm-lifecycle.js";
import { runNetworkingSuite } from "./suites/networking.js";
import { runGatewaySuite } from "./suites/gateway.js";
import { runCleanupSuite } from "./suites/cleanup.js";
import { runTemplateSuite } from "./suites/template.js";

export interface BenchOptions {
  suite: string;
  iterations: number;
  template: string;
  concurrency: number | number[];
  verboseStats?: boolean;
  layout?: "auto" | "2col" | "single";
}

function parseArgs(): BenchOptions {
  const args = process.argv.slice(2);
  const options: BenchOptions = {
    suite: "all",
    iterations: 10,
    template: "node",
    concurrency: [1, 5, 10],
    verboseStats: false,
    layout: "auto",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--suite" || arg === "-s") && args[i + 1] !== undefined) {
      options.suite = args[++i]!;
    } else if ((arg === "--iterations" || arg === "-i" || arg === "-n") && args[i + 1] !== undefined) {
      options.iterations = parseInt(args[++i]!, 10);
    } else if ((arg === "--template" || arg === "-t") && args[i + 1] !== undefined) {
      options.template = args[++i]!;
    } else if (arg === "--layout" && args[i + 1] !== undefined) {
      const raw = args[++i]!;
      options.layout = raw === "2col" || raw === "single" ? raw : "auto";
    } else if ((arg === "--concurrency" || arg === "-c") && args[i + 1] !== undefined) {
      const raw = args[++i]!;
      if (raw.includes(",")) {
        options.concurrency = raw
          .split(",")
          .map((n) => parseInt(n.trim(), 10))
          .filter((n) => !isNaN(n));
      } else {
        const num = parseInt(raw, 10);
        options.concurrency = isNaN(num) ? 5 : num;
      }
    } else if (arg === "--verbose-stats" || arg === "--verbose" || arg === "-v") {
      options.verboseStats = true;
    }
  }

  return options;
}

async function main() {
  const opts = parseArgs();
  const suites: BenchmarkSuite[] = [];
  const targetSuite = opts.suite.toLowerCase();
  const benchStartTime = performance.now();

  try {
    // Initialize host networking and template registry
    try {
      ensureHostNetworkSetup();
    } catch {}
    loadTemplateRegistry();

    let hasError = false;
    let suiteIndex = 0;
    const runSuite = async (name: string, fn: () => Promise<BenchmarkSuite>) => {
      suiteIndex++;
      const startTime = performance.now();

      process.stdout.write(
        `  ${c.gray}▸${c.reset} [${suiteIndex}] Running ${c.bold}${name}${c.reset} (${opts.iterations} iters)... `,
      );

      try {
        const suite = await fn();
        const elapsedSec = ((performance.now() - startTime) / 1000).toFixed(2);
        suite.durationMs = performance.now() - startTime;
        suites.push(suite);

        process.stdout.write(`${c.bold}${c.brightWhite}✔${c.reset} ${c.gray}(${elapsedSec}s)${c.reset}\n`);
      } catch (err: any) {
        hasError = true;
        const msg = err?.response?.data?.fault_message || err?.message || String(err);

        process.stdout.write(`${c.red}${c.bold}✘ Failed${c.reset}\n`);
        console.error(`\n${c.red}[!] Suite "${name}" failed:${c.reset} ${msg}`);

        if (msg.includes("KVM MSRs") || msg.includes("Failed to restore")) {
          console.error(
            `\n${c.yellow}[TIP] Firecracker snapshot restoration failed because the snapshot in '/var/lib/agent-sandbox/artifacts/templates/${opts.template}' was generated on a host with different KVM/CPU state.${c.reset}`,
          );
          console.error(
            `      Rebuild the template snapshot on this host using:\n        ${c.bold}sudo node dist/create_snapshot.js ${opts.template}${c.reset}\n`,
          );
        }
        if (targetSuite !== "all") {
          throw err;
        }
      }
    };

    console.log(`\n  ${c.bold}${c.brightWhite}PERFORMANCE BENCHMARKS${c.reset}`);
    console.log(`  ${c.gray}${"─".repeat(50)}${c.reset}`);

    if (targetSuite === "all" || targetSuite === "vm") {
      await runSuite("VM Lifecycle", () => runVmLifecycleSuite(opts));
    }
    if (targetSuite === "all" || targetSuite === "networking") {
      await runSuite("Networking Breakdown", () => runNetworkingSuite(opts));
    }
    if (targetSuite === "all" || targetSuite === "gateway") {
      await runSuite("Session Gateway", () => runGatewaySuite(opts));
    }
    if (targetSuite === "all" || targetSuite === "cleanup") {
      await runSuite("Cleanup & Teardown", () => runCleanupSuite(opts));
    }
    if (targetSuite === "template") {
      await runSuite("Template Build Pipeline", () => runTemplateSuite(opts));
    }

    if (suites.length === 0) {
      console.error("\nNo benchmark suites completed successfully.");
      process.exit(1);
    }

    const totalDurationSec = ((performance.now() - benchStartTime) / 1000).toFixed(1);

    const meta = {
      timestamp: new Date().toISOString(),
      iterations: opts.iterations,
      template: opts.template,
      concurrency: opts.concurrency,
      suite: opts.suite,
      verboseStats: opts.verboseStats,
      layout: opts.layout,
      totalDurationSec,
    };

    if (!hasError && process.stdout.isTTY) {
      // Clear ephemeral progress logs so final dashboard renders cleanly at the top of the terminal
      process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    }
    console.log(formatTable(suites, meta));
  } catch (err) {
    console.error("Benchmark execution halted:", err);
    process.exit(1);
  }
}

main();
