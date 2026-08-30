import os from "os";
import fs from "fs";
import { execSync } from "child_process";

export interface TimingResult {
  name: string;
  samples: number[];
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  p99: number;
  stddev: number;
}

export interface BenchmarkSuite {
  name: string;
  results: TimingResult[];
  durationMs?: number;
}

export interface SystemStats {
  osName: string;
  distro: string;
  kernel: string;
  arch: string;
  hostname: string;
  cpuModel: string;
  cpuCores: number;
  cpuThreads: number;
  cpuSpeedMhz?: number | undefined;
  memTotalBytes: number;
  memFreeBytes: number;
  memAvailableBytes: number;
  memBuffersCachedBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  swapFreeBytes: number;
  kvmStatus: string;
  firecrackerVersion: string;
  nodeVersion: string;
  v8Version: string;
  loadAvg: number[];
  uptimeSeconds: number;
}

// ---------------------------------------------------------------------------
// ANSI Terminal Styling
// ---------------------------------------------------------------------------
const isColorSupported =
  !("NO_COLOR" in process.env) &&
  (process.env.FORCE_COLOR === "1" ||
    process.env.FORCE_COLOR === "true" ||
    (process.stdout.isTTY && process.env.TERM !== "dumb"));

export const c = {
  reset: isColorSupported ? "\x1b[0m" : "",
  bold: isColorSupported ? "\x1b[1m" : "",
  dim: isColorSupported ? "\x1b[2m" : "",
  italic: isColorSupported ? "\x1b[3m" : "",
  underline: isColorSupported ? "\x1b[4m" : "",

  // Foreground
  black: isColorSupported ? "\x1b[30m" : "",
  red: isColorSupported ? "\x1b[31m" : "",
  green: isColorSupported ? "\x1b[32m" : "",
  yellow: isColorSupported ? "\x1b[33m" : "",
  blue: isColorSupported ? "\x1b[34m" : "",
  magenta: isColorSupported ? "\x1b[35m" : "",
  cyan: isColorSupported ? "\x1b[36m" : "",
  white: isColorSupported ? "\x1b[37m" : "",
  gray: isColorSupported ? "\x1b[90m" : "",

  // Bright Foreground
  brightRed: isColorSupported ? "\x1b[91m" : "",
  brightGreen: isColorSupported ? "\x1b[92m" : "",
  brightYellow: isColorSupported ? "\x1b[93m" : "",
  brightBlue: isColorSupported ? "\x1b[94m" : "",
  brightMagenta: isColorSupported ? "\x1b[95m" : "",
  brightCyan: isColorSupported ? "\x1b[96m" : "",
  brightWhite: isColorSupported ? "\x1b[97m" : "",

  // Tail Latency / Accent Orange
  orange: isColorSupported ? "\x1b[38;5;208m" : "",
};

export function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function padEndAnsi(str: string, targetLength: number): string {
  const visibleLen = stripAnsi(str).length;
  const pad = Math.max(0, targetLength - visibleLen);
  return str + " ".repeat(pad);
}

export function padStartAnsi(str: string, targetLength: number): string {
  const visibleLen = stripAnsi(str).length;
  const pad = Math.max(0, targetLength - visibleLen);
  return " ".repeat(pad) + str;
}

// ---------------------------------------------------------------------------
// Telemetry & Hardware Discovery
// ---------------------------------------------------------------------------
export function getSystemStats(): SystemStats {
  let distro = `${os.type()} ${os.release()}`;
  try {
    if (fs.existsSync("/etc/os-release")) {
      const osRel = fs.readFileSync("/etc/os-release", "utf-8");
      const prettyMatch = osRel.match(/PRETTY_NAME="([^"]+)"/);
      if (prettyMatch?.[1]) {
        distro = prettyMatch[1];
      }
    }
  } catch {}

  let memTotalBytes = os.totalmem();
  let memFreeBytes = os.freemem();
  let memAvailableBytes = memFreeBytes;
  let memBuffersCachedBytes = 0;
  let swapTotalBytes = 0;
  let swapFreeBytes = 0;

  try {
    if (fs.existsSync("/proc/meminfo")) {
      const memInfo = fs.readFileSync("/proc/meminfo", "utf-8");
      const parseKb = (key: string): number => {
        const m = memInfo.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
        return m?.[1] ? parseInt(m[1], 10) * 1024 : 0;
      };

      const total = parseKb("MemTotal");
      const free = parseKb("MemFree");
      const avail = parseKb("MemAvailable");
      const buffers = parseKb("Buffers");
      const cached = parseKb("Cached");
      const sTotal = parseKb("SwapTotal");
      const sFree = parseKb("SwapFree");

      if (total > 0) memTotalBytes = total;
      if (free > 0) memFreeBytes = free;
      if (avail > 0) memAvailableBytes = avail;
      memBuffersCachedBytes = buffers + cached;
      swapTotalBytes = sTotal;
      swapFreeBytes = sFree;
    }
  } catch {}

  const swapUsedBytes = Math.max(0, swapTotalBytes - swapFreeBytes);

  let cpuModel = "Unknown CPU";
  let cpuCores = 0;
  let cpuThreads = os.cpus().length;
  let cpuSpeedMhz: number | undefined;

  const cpus = os.cpus();
  if (cpus.length > 0) {
    cpuModel = cpus[0]!.model.replace(/\s+/g, " ").trim();
    cpuSpeedMhz = cpus[0]!.speed;
  }

  try {
    if (fs.existsSync("/proc/cpuinfo")) {
      const cpuInfo = fs.readFileSync("/proc/cpuinfo", "utf-8");
      const modelMatch = cpuInfo.match(/^model name\s+:\s+(.+)$/m);
      if (modelMatch?.[1]) {
        cpuModel = modelMatch[1].replace(/\s+/g, " ").trim();
      }
      const coresMatch = cpuInfo.match(/^cpu cores\s+:\s+(\d+)$/m);
      if (coresMatch?.[1]) {
        cpuCores = parseInt(coresMatch[1], 10);
      }
    }
  } catch {}

  if (cpuCores === 0) {
    cpuCores = Math.max(1, Math.floor(cpuThreads / 2));
  }

  let kvmStatus = "Not detected";
  try {
    if (fs.existsSync("/dev/kvm")) {
      try {
        fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK);
        kvmStatus = "KVM (r/w)";
      } catch {
        kvmStatus = "KVM (restricted)";
      }
    } else {
      kvmStatus = "KVM (unavailable)";
    }
  } catch {
    kvmStatus = "Unavailable";
  }

  let firecrackerVersion = "Firecracker";
  try {
    const fcBin = process.env.FIRECRACKER_BIN || "/usr/local/bin/firecracker";
    if (fs.existsSync(fcBin)) {
      const verOut = execSync(`${fcBin} --version 2>/dev/null`, { encoding: "utf-8" }).trim();
      const firstLine = verOut.split("\n")[0]?.trim();
      if (firstLine) {
        firecrackerVersion = firstLine;
      }
    }
  } catch {
    firecrackerVersion = "Firecracker";
  }

  return {
    osName: os.type(),
    distro,
    kernel: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
    cpuModel,
    cpuCores,
    cpuThreads,
    cpuSpeedMhz,
    memTotalBytes,
    memFreeBytes,
    memAvailableBytes,
    memBuffersCachedBytes,
    swapTotalBytes,
    swapUsedBytes,
    swapFreeBytes,
    kvmStatus,
    firecrackerVersion,
    nodeVersion: process.version,
    v8Version: process.versions.v8 || "unknown",
    loadAvg: os.loadavg(),
    uptimeSeconds: os.uptime(),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  if (!isColorSupported) {
    return `${val.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
  }
  return `${c.brightWhite}${val.toFixed(i === 0 ? 0 : 2)}${c.reset} ${c.gray}${units[i]}${c.reset}`;
}

export async function time<T>(fn: () => T | Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = process.hrtime.bigint();
  const result = await fn();
  const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  return { result, durationMs };
}

export function computeStats(name: string, samples: number[]): TimingResult {
  if (samples.length === 0) {
    return {
      name,
      samples: [],
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      p95: 0,
      p99: 0,
      stddev: 0,
    };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / sorted.length;

  return {
    name,
    samples: sorted,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    mean,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    stddev: Math.sqrt(variance),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  const clampedIdx = Math.max(0, Math.min(idx, sorted.length - 1));
  return sorted[clampedIdx] ?? 0;
}

export function splitDuration(ms: number): { value: string; unit: string } {
  if (ms < 0.001) {
    return { value: (ms * 1_000_000).toFixed(0), unit: "ns" };
  } else if (ms < 0.1) {
    return { value: (ms * 1000).toFixed(1), unit: "µs" };
  } else if (ms < 1) {
    return { value: ms.toFixed(2), unit: "ms" };
  } else if (ms < 10) {
    return { value: ms.toFixed(2), unit: "ms" };
  } else if (ms < 100) {
    return { value: ms.toFixed(1), unit: "ms" };
  } else if (ms < 1000) {
    return { value: ms.toFixed(1), unit: "ms" };
  } else {
    return { value: (ms / 1000).toFixed(2), unit: "s" };
  }
}

export function formatDuration(
  ms: number,
  colorOrEmphasized?: boolean | string,
  unitColor: string = c.gray,
): string {
  const { value, unit } = splitDuration(ms);
  if (!isColorSupported) {
    return `${value}${unit}`;
  }

  let numColor = c.brightWhite;
  if (typeof colorOrEmphasized === "string") {
    numColor = colorOrEmphasized;
  } else if (colorOrEmphasized === true) {
    numColor = `${c.bold}${c.brightWhite}`;
  } else if (colorOrEmphasized === false) {
    numColor = c.white;
  }

  return `${numColor}${value}${c.reset}${unitColor}${unit}${c.reset}`;
}

// ---------------------------------------------------------------------------
// Redesigned Benchmark Presentation Engine
// ---------------------------------------------------------------------------

export function formatHeroBanner(
  suites: BenchmarkSuite[],
  meta?: Record<string, any>,
  bannerWidth: number = 76,
): string {
  const lines: string[] = [];
  const width = Math.max(76, bannerWidth);

  const findMetric = (suiteName: string, opName: string): TimingResult | undefined => {
    const s = suites.find((x) => x.name.toLowerCase().includes(suiteName.toLowerCase()));
    return s?.results.find((r) => r.name === opName);
  };

  const coldStart = findMetric("Lifecycle", "TOTAL_COLD_START") || findMetric("Gateway", "cold_session_start");
  const netSetup = findMetric("Lifecycle", "network_setup") || findMetric("Networking", "full_setupVmNetwork");
  const firstRtt = findMetric("Lifecycle", "first_message_rtt");
  const warmMsg = findMetric("Lifecycle", "warm_message_rtt") || findMetric("Gateway", "warm_session_message");

  const gatewaySuite = suites.find((x) => x.name.toLowerCase().includes("gateway"));
  const burstResults = gatewaySuite?.results.filter((r) => r.name.startsWith("concurrent_burst_")) || [];
  const maxBurst = burstResults.length > 0 ? burstResults[burstResults.length - 1] : undefined;
  const maxBurstLvl = maxBurst ? maxBurst.name.replace("concurrent_burst_", "") : undefined;

  // Level 1: Integrated Single-Line Header with Status Badge
  const totalDurationSec = meta?.totalDurationSec
    ? `${meta.totalDurationSec}s`
    : "completed";
  const iters = meta?.iterations ?? 10;
  const titleLeft = `${c.bold}${c.brightWhite}AGENT SANDBOX • BENCHMARKS${c.reset}`;
  const badgeRight = `${c.brightWhite}✔${c.reset} ${c.bold}${c.brightWhite}${suites.length}/${suites.length} complete${c.reset} ${c.gray}· ${iters * suites.length} iters · ${totalDurationSec}${c.reset}`;

  const titleLeftLen = stripAnsi(titleLeft).length;
  const badgeRightLen = stripAnsi(badgeRight).length;
  const headerGap = Math.max(2, width - (titleLeftLen + badgeRightLen));

  lines.push("");
  lines.push(`${titleLeft}${" ".repeat(headerGap)}${badgeRight}`);
  lines.push(`${c.gray}${"─".repeat(width)}${c.reset}`);
  lines.push("");

  // Level 2: Key Numbers Hero Cards
  const val1 = coldStart ? formatDuration(coldStart.median, c.bold + c.brightWhite) : "—";
  const val2 = netSetup ? formatDuration(netSetup.median, c.white) : "—";
  const val3 = firstRtt
    ? formatDuration(firstRtt.median, c.white)
    : (warmMsg ? formatDuration(warmMsg.median, c.white) : "—");
  const val4 = maxBurst
    ? formatDuration(maxBurst.median, c.white)
    : (warmMsg ? formatDuration(warmMsg.median, c.white) : "—");

  const label3 = firstRtt ? "FIRST RTT" : "WARM MSG";
  const label4 = maxBurst ? `BURST ×${maxBurstLvl}` : "WARM MSG";

  let vLine = "";
  let lLine = "";
  let pLine = "";

  if (width >= 120) {
    const blockW = Math.floor((width - 6) / 2);
    const cW = Math.floor((blockW - 2) / 2);
    const gap = " ".repeat(Math.max(6, width - (cW * 4 + 4)));

    vLine = `  ${padEndAnsi(val1, cW)}  ${padEndAnsi(val2, cW)}${gap}${padEndAnsi(val3, cW)}  ${padEndAnsi(val4, cW)}`;
    lLine = `  ${padEndAnsi(c.bold + "COLD START" + c.reset, cW)}  ${padEndAnsi(c.bold + "NETWORK" + c.reset, cW)}${gap}${padEndAnsi(c.bold + label3 + c.reset, cW)}  ${padEndAnsi(c.bold + label4 + c.reset, cW)}`;
    pLine = `  ${padEndAnsi(c.gray + "p50 latency" + c.reset, cW)}  ${padEndAnsi(c.gray + "p50 setup" + c.reset, cW)}${gap}${padEndAnsi(c.gray + "p50 vsock" + c.reset, cW)}  ${padEndAnsi(c.gray + "p50 parallel" + c.reset, cW)}`;
  } else {
    const colWidth = Math.max(18, Math.floor((width - 4) / 4));
    vLine = `  ${padEndAnsi(val1, colWidth)} ${padEndAnsi(val2, colWidth)} ${padEndAnsi(val3, colWidth)} ${padEndAnsi(val4, colWidth)}`;
    lLine = `  ${padEndAnsi(c.bold + "COLD START" + c.reset, colWidth)} ${padEndAnsi(c.bold + "NETWORK" + c.reset, colWidth)} ${padEndAnsi(c.bold + label3 + c.reset, colWidth)} ${padEndAnsi(c.bold + label4 + c.reset, colWidth)}`;
    pLine = `  ${padEndAnsi(c.gray + "p50 latency" + c.reset, colWidth)} ${padEndAnsi(c.gray + "p50 setup" + c.reset, colWidth)} ${padEndAnsi(c.gray + "p50 vsock" + c.reset, colWidth)} ${padEndAnsi(c.gray + "p50 parallel" + c.reset, colWidth)}`;
  }

  lines.push(vLine);
  lines.push(lLine);
  lines.push(pLine);
  lines.push("");

  return lines.join("\n");
}

export function formatEnvironment(
  metaOrWidth?: Record<string, any> | number,
  customWidth: number = 70,
): string {
  const stats = getSystemStats();
  const width = typeof metaOrWidth === "number" ? metaOrWidth : customWidth;
  const lines: string[] = [];

  lines.push(`${c.bold}${c.brightWhite}ENVIRONMENT${c.reset}`);
  lines.push(`${c.gray}${"─".repeat(width)}${c.reset}`);

  const row = (label: string, value: string) => {
    lines.push(`  ${padEndAnsi(c.gray + label + c.reset, 14)} ${value}`);
  };

  row("OS", `${c.brightWhite}${stats.distro}${c.reset} ${c.gray}· Linux ${stats.kernel} (${stats.arch})${c.reset}`);
  row(
    "CPU",
    `${c.brightWhite}${stats.cpuModel}${c.reset} ${c.gray}· ${stats.cpuCores}C / ${stats.cpuThreads}T${c.reset}`,
  );
  row(
    "RAM",
    `${formatBytes(stats.memTotalBytes)} total ${c.gray}·${c.reset} ${c.brightWhite}${formatBytes(stats.memAvailableBytes)} avail${c.reset}`,
  );
  row("VM", `${c.brightWhite}${stats.kvmStatus}${c.reset} ${c.gray}·${c.reset} ${stats.firecrackerVersion}`);
  row("Runtime", `${c.brightWhite}Node.js ${stats.nodeVersion}${c.reset} ${c.gray}· V8 ${stats.v8Version}${c.reset}`);
  lines.push("");

  return lines.join("\n");
}

export function formatRunConfig(meta?: Record<string, any>, customWidth: number = 70): string {
  const width = customWidth;
  const lines: string[] = [];

  const timestamp = meta?.timestamp || new Date().toISOString();
  const template = meta?.template ?? "node";
  const iterations = meta?.iterations ?? 10;
  const concurrency = meta?.concurrency
    ? Array.isArray(meta.concurrency)
      ? meta.concurrency.join(" · ")
      : String(meta.concurrency)
    : "1 · 5 · 10";

  lines.push(`${c.bold}${c.brightWhite}RUN CONFIGURATION${c.reset}`);
  lines.push(`${c.gray}${"─".repeat(width)}${c.reset}`);

  const row = (label: string, value: string) => {
    lines.push(`  ${padEndAnsi(c.gray + label + c.reset, 14)} ${value}`);
  };

  row("Template", `${c.bold}${c.brightWhite}${template}${c.reset}`);
  row("Iterations", `${iterations}`);
  row("Concurrency", `${concurrency}`);
  row("Started", `${timestamp}`);
  lines.push("");

  return lines.join("\n");
}

export function joinSideBySide(
  leftStr: string,
  rightStr: string,
  colWidth: number,
  gap: number = 6,
): string {
  const leftLines = leftStr.split("\n");
  const rightLines = rightStr.split("\n");

  while (leftLines.length > 0 && leftLines[leftLines.length - 1]?.trim() === "") {
    leftLines.pop();
  }
  while (rightLines.length > 0 && rightLines[rightLines.length - 1]?.trim() === "") {
    rightLines.pop();
  }

  const maxLines = Math.max(leftLines.length, rightLines.length);
  const lines: string[] = [];
  const spacer = " ".repeat(gap);

  for (let i = 0; i < maxLines; i++) {
    const left = leftLines[i] ?? "";
    const right = rightLines[i] ?? "";
    lines.push(`${padEndAnsi(left, colWidth)}${spacer}${right}`);
  }

  return lines.join("\n");
}

export function formatSectionTable(
  index: number,
  suite: BenchmarkSuite,
  verbose: boolean = false,
  customWidth: number = 76,
): string {
  const lines: string[] = [];
  const width = customWidth;
  const suiteNum = String(index).padStart(2, "0");

  // Level 3: Clean Section Header with enhanced vertical rhythm (preceding line break)
  lines.push("");
  lines.push(`${c.bold}${c.brightWhite}${suiteNum}  ${suite.name.toUpperCase()}${c.reset}`);
  lines.push(`${c.gray}${"─".repeat(width)}${c.reset}`);

  // Level 4: Compact & Focused Measurements
  const colOp = Math.max(24, Math.min(32, width - 42));
  const colVal = 12;

  if (verbose) {
    // Verbose format with Min / p50 / Mean / p95 / p99
    const hOp = padEndAnsi(c.gray + "Operation" + c.reset, 22);
    const hMin = padStartAnsi(c.gray + "Min" + c.reset, 9);
    const hP50 = padStartAnsi(c.gray + "p50" + c.reset, 9);
    const hMean = padStartAnsi(c.gray + "Mean" + c.reset, 9);
    const hP95 = padStartAnsi(c.gray + "p95" + c.reset, 9);
    const hP99 = padStartAnsi(c.bold + c.brightWhite + "p99" + c.reset, 9);
    lines.push(`  ${hOp} ${hMin} ${hP50} ${hMean} ${hP95} ${hP99}`);
    lines.push(`  ${c.gray}${"─".repeat(width - 2)}${c.reset}`);

    for (const r of suite.results) {
      const isTotal = r.name.startsWith("TOTAL") || r.name.startsWith("full_");
      if (isTotal) {
        lines.push(`  ${c.gray}${"─".repeat(width - 2)}${c.reset}`);
      }

      const nameLabel = isTotal ? c.bold + c.brightWhite + r.name + c.reset : r.name;
      const cellOp = padEndAnsi(nameLabel, 22);
      const cellMin = padStartAnsi(formatDuration(r.min, c.dim + c.white), 9);
      const cellP50 = padStartAnsi(formatDuration(r.median, c.dim + c.white), 9);
      const cellMean = padStartAnsi(formatDuration(r.mean, c.dim + c.white), 9);
      const cellP95 = padStartAnsi(formatDuration(r.p95, c.dim + c.white), 9);
      const cellP99 = padStartAnsi(formatDuration(r.p99, c.bold + c.brightWhite), 9);

      lines.push(`  ${cellOp} ${cellMin} ${cellP50} ${cellMean} ${cellP95} ${cellP99}`);
    }
  } else {
    // Default Focused format: Operation | p50 | p95 | p99
    const isGateway = suite.name.toLowerCase().includes("gateway");
    const regularResults = isGateway
      ? suite.results.filter((r) => !r.name.startsWith("concurrent_burst_"))
      : suite.results;

    const hOp = padEndAnsi(c.gray + "Operation" + c.reset, colOp);
    const hP50 = padStartAnsi(c.gray + "p50 (Median)" + c.reset, colVal);
    const hP95 = padStartAnsi(c.gray + "p95" + c.reset, colVal);
    const hP99 = padStartAnsi(c.bold + c.brightWhite + "p99" + c.reset, colVal);

    lines.push(`  ${hOp} ${hP50} ${hP95} ${hP99}`);
    lines.push(`  ${c.gray}${"─".repeat(width - 2)}${c.reset}`);

    for (let i = 0; i < regularResults.length; i++) {
      const r = regularResults[i]!;
      const isTotal = r.name.startsWith("TOTAL") || r.name.startsWith("full_");
      if (isTotal && r.name.startsWith("TOTAL") && i > 0) {
        lines.push(`  ${c.gray}${"─".repeat(width - 2)}${c.reset}`);
      }

      const nameLabel = isTotal ? c.bold + c.brightWhite + r.name + c.reset : r.name;
      const cellOp = padEndAnsi(nameLabel, colOp);
      const cellP50 = padStartAnsi(formatDuration(r.median, c.dim + c.white), colVal);
      const cellP95 = padStartAnsi(formatDuration(r.p95, c.dim + c.white), colVal);
      const cellP99 = padStartAnsi(formatDuration(r.p99, c.bold + c.brightWhite), colVal);

      lines.push(`  ${cellOp} ${cellP50} ${cellP95} ${cellP99}`);
    }

    // Explicit Concurrency Story for Gateway Suite
    if (isGateway) {
      const burstResults = suite.results.filter((r) => r.name.startsWith("concurrent_burst_"));
      if (burstResults.length > 0) {
        lines.push("");
        lines.push(`  ${c.bold}${c.brightWhite}CONCURRENCY LATENCY & THROUGHPUT${c.reset}`);
        lines.push(`  ${c.gray}${"─".repeat(width - 2)}${c.reset}`);

        const maxMedian = Math.max(...burstResults.map((r) => r.median));
        const barWidth = 16;

        for (const b of burstResults) {
          const lvl = b.name.replace("concurrent_burst_", "");
          const lvlNum = parseInt(lvl, 10);
          const throughputVal = (lvlNum / (b.median / 1000)).toFixed(1);

          // Standard linear gauge with strictly fixed visible length
          const barFilled = Math.max(1, Math.min(barWidth, Math.round((b.median / maxMedian) * barWidth)));
          const barEmpty = Math.max(0, barWidth - barFilled);
          const bar = `${c.brightWhite}${"■".repeat(barFilled)}${c.reset}${c.gray}${"·".repeat(barEmpty)}${c.reset}`;

          const label = padEndAnsi(`  ${lvl} session${lvlNum > 1 ? "s" : ""}`, 14);
          const lat = padStartAnsi(formatDuration(b.median, c.bold + c.brightWhite), 10);
          const tputFormatted = padStartAnsi(`${c.white}${throughputVal}${c.reset} ${c.gray}req/s${c.reset}`, 14);

          lines.push(`  ${label} ${bar}  ${lat}  ${c.gray}·${c.reset}  ${tputFormatted}`);
        }
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main Formatter Orchestration
// ---------------------------------------------------------------------------
export function formatTable(suites: BenchmarkSuite[], meta?: Record<string, any>): string {
  const verbose = !!meta?.verboseStats;
  const termWidth = typeof process !== "undefined" && process.stdout?.columns ? process.stdout.columns : 80;

  // Responsive layout: enable two-column grid on wide screens (>= 130 cols) or when explicitly requested
  const isTwoCol = meta?.layout === "2col" || (meta?.layout !== "single" && termWidth >= 130);

  if (isTwoCol) {
    const colWidth = Math.min(74, Math.max(58, Math.floor((termWidth - 8) / 2)));
    const gap = 6;
    const totalWidth = colWidth * 2 + gap;
    const parts: string[] = [];

    // 1. Executive Summary Hero Card (Top anchor)
    parts.push(formatHeroBanner(suites, meta, totalWidth));

    // 2. ENVIRONMENT & RUN CONFIGURATION Side-by-Side
    const envStr = formatEnvironment(colWidth);
    const runStr = formatRunConfig(meta, colWidth);
    parts.push(joinSideBySide(envStr, runStr, colWidth, gap));

    // 3. Benchmark Suites Paired Side-by-Side (1 & 2, 3 & 4, etc.)
    for (let i = 0; i < suites.length; i += 2) {
      const leftSuite = suites[i]!;
      const rightSuite = suites[i + 1];

      const leftTableStr = formatSectionTable(i + 1, leftSuite, verbose, colWidth);

      if (rightSuite) {
        const rightTableStr = formatSectionTable(i + 2, rightSuite, verbose, colWidth);
        parts.push(joinSideBySide(leftTableStr, rightTableStr, colWidth, gap));
      } else {
        parts.push(leftTableStr);
      }
    }

    return parts.join("\n");
  } else {
    // Single-column linear layout
    const width = 76;
    const parts: string[] = [];

    // 1. Hero Banner
    parts.push(formatHeroBanner(suites, meta, width));

    // 2. Environment & Run
    parts.push(formatEnvironment(width));
    parts.push(formatRunConfig(meta, width));

    // 3. Section Tables
    for (let i = 0; i < suites.length; i++) {
      parts.push(formatSectionTable(i + 1, suites[i]!, verbose, width));
    }

    return parts.join("\n");
  }
}
