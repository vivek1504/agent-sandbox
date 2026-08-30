import { describe, it, expect } from "vitest";
import {
  c,
  stripAnsi,
  splitDuration,
  formatDuration,
  formatBytes,
  computeStats,
  formatHeroBanner,
  formatEnvironment,
  formatRunConfig,
  formatSectionTable,
  joinSideBySide,
  formatTable,
  type BenchmarkSuite,
} from "./harness.js";

describe("Benchmark UI Harness", () => {
  describe("Duration and Unit Formatting", () => {
    it("splits durations across units correctly", () => {
      expect(splitDuration(0.0005)).toEqual({ value: "500", unit: "ns" });
      expect(splitDuration(0.05)).toEqual({ value: "50.0", unit: "µs" });
      expect(splitDuration(2.45)).toEqual({ value: "2.45", unit: "ms" });
      expect(splitDuration(25.4)).toEqual({ value: "25.4", unit: "ms" });
      expect(splitDuration(1250)).toEqual({ value: "1.25", unit: "s" });
    });

    it("dims unit strings while keeping numbers bright", () => {
      const formatted = formatDuration(2.45, c.brightWhite);
      expect(stripAnsi(formatted)).toBe("2.45ms");
      expect(formatted).toContain(c.brightWhite);
      expect(formatted).toContain(c.gray);
    });

    it("formats bytes with dimmed units", () => {
      const bytesStr = formatBytes(1024 * 1024 * 16);
      expect(stripAnsi(bytesStr)).toBe("16.00 MiB");
      expect(bytesStr).toContain(c.gray);
    });
  });

  describe("Integrated Header & Hero Banner", () => {
    const suites: BenchmarkSuite[] = [
      {
        name: "VM Lifecycle",
        results: [computeStats("TOTAL_COLD_START", [100.0])],
      },
    ];

    it("renders integrated single-line title bar with status badge", () => {
      const banner = formatHeroBanner(suites, {}, 80);
      const clean = stripAnsi(banner);
      expect(clean).toContain("AGENT SANDBOX • BENCHMARKS");
      expect(clean).toContain("1/1 complete");

      const firstLine = clean.split("\n").find((l) => l.includes("AGENT SANDBOX • BENCHMARKS"));
      expect(firstLine).toBeDefined();
      expect(firstLine).toContain("1/1 complete");
    });
  });

  describe("Section Table and Monochrome Styling", () => {
    const sampleSuite: BenchmarkSuite = {
      name: "Session Gateway",
      results: [
        computeStats("warm_session_message", [1.2, 1.4, 1.5, 2.1, 3.8]),
        computeStats("concurrent_burst_1", [15.2, 16.0, 16.5]),
        computeStats("concurrent_burst_5", [45.1, 48.0, 52.3]),
        computeStats("concurrent_burst_10", [90.0, 93.7, 105.2]),
      ],
    };

    it("enhances vertical rhythm with a preceding line break before numbered header", () => {
      const tableStr = formatSectionTable(3, sampleSuite, false);
      expect(tableStr.startsWith("\n")).toBe(true);
      expect(stripAnsi(tableStr)).toContain("03  SESSION GATEWAY");
    });

    it("applies subdued monochrome emphasis for p99 (stark white against muted p50/p95)", () => {
      const tableStr = formatSectionTable(3, sampleSuite, false);
      expect(tableStr).toContain("p99");
      if (c.cyan) expect(tableStr).not.toContain(c.cyan);
      if (c.yellow) expect(tableStr).not.toContain(c.yellow);
    });

    it("renders concurrency as a clean fixed-width geometric gauge with right-aligned columns", () => {
      const tableStr = formatSectionTable(3, sampleSuite, false);
      expect(tableStr).toContain("CONCURRENCY LATENCY & THROUGHPUT");
      expect(tableStr).toContain("■");
      expect(tableStr).toContain("·");
      expect(stripAnsi(tableStr)).toMatch(/10 sessions\s+[■·]+\s+93\.7ms\s+·\s+106\.7 req\/s/);
    });
  });

  describe("Responsive Layout Orchestration", () => {
    const suites: BenchmarkSuite[] = [
      {
        name: "VM Lifecycle",
        results: [
          computeStats("TOTAL_COLD_START", [100.0]),
          computeStats("network_setup", [67.0]),
        ],
      },
      {
        name: "Networking Breakdown",
        results: [
          computeStats("netns_create", [2.96]),
        ],
      },
      {
        name: "Session Gateway",
        results: [
          computeStats("cold_session_start", [136.4]),
        ],
      },
      {
        name: "Cleanup & Teardown",
        results: [
          computeStats("full_cleanupVm", [2.1]),
        ],
      },
    ];

    it("renders single-column layout when requested", () => {
      const output = formatTable(suites, { layout: "single" });
      const clean = stripAnsi(output);
      expect(clean).toContain("BENCHMARKS");
      expect(clean).toContain("ENVIRONMENT");
      expect(clean).toContain("RUN CONFIGURATION");
      expect(clean).toContain("01  VM LIFECYCLE");
      const envIndex = clean.indexOf("ENVIRONMENT");
      const runIndex = clean.indexOf("RUN CONFIGURATION");
      const secIndex = clean.indexOf("01  VM LIFECYCLE");
      expect(envIndex).toBeLessThan(runIndex);
      expect(runIndex).toBeLessThan(secIndex);
    });

    it("renders ENVIRONMENT & RUN CONFIGURATION side-by-side, 1 & 2 side-by-side, 3 & 4 side-by-side", () => {
      const output = formatTable(suites, { layout: "2col" });
      const clean = stripAnsi(output);
      expect(clean).toContain("BENCHMARKS");
      const lines = clean.split("\n");

      // ENVIRONMENT and RUN CONFIGURATION side-by-side on same line
      const envRunRow = lines.find((l) => l.includes("ENVIRONMENT") && l.includes("RUN CONFIGURATION"));
      expect(envRunRow).toBeDefined();

      // 01 VM LIFECYCLE and 02 NETWORKING BREAKDOWN side-by-side
      const suites12Row = lines.find((l) => l.includes("01  VM LIFECYCLE") && l.includes("02  NETWORKING BREAKDOWN"));
      expect(suites12Row).toBeDefined();

      // 03 SESSION GATEWAY and 04 CLEANUP & TEARDOWN side-by-side
      const suites34Row = lines.find((l) => l.includes("03  SESSION GATEWAY") && l.includes("04  CLEANUP & TEARDOWN"));
      expect(suites34Row).toBeDefined();
    });
  });
});
