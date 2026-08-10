import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { loadEgressPolicy, parseDestinationRules } from "./egress-policy.js";

describe("egress-policy", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads default egress policy when no env vars are set", () => {
    delete process.env.VM_DNS_MODE;
    delete process.env.VM_DEST_MODE;
    delete process.env.VM_BW_ENABLED;

    const policy = loadEgressPolicy();
    expect(policy.dns.mode).toBe("none");
    expect(policy.dns.domains).toEqual([]);
    expect(policy.dns.upstreamDns).toEqual(["8.8.8.8", "1.1.1.1"]);
    expect(policy.destination.mode).toBe("none");
    expect(policy.destination.rules).toEqual([]);
    expect(policy.bandwidth.enabled).toBe(false);
    expect(policy.bandwidth.egressRateKbit).toBe(10240);
    expect(policy.bandwidth.burstKbit).toBe(1024);
  });

  it("parses destination rules correctly", () => {
    const raw = "169.254.169.254/32, 10.0.0.0/8:443/tcp, 192.168.1.0/24:80:443/udp";
    const rules = parseDestinationRules(raw);

    expect(rules).toHaveLength(3);
    expect(rules[0]).toEqual({ cidr: "169.254.169.254/32" });
    expect(rules[1]).toEqual({ cidr: "10.0.0.0/8", port: "443", protocol: "tcp" });
    expect(rules[2]).toEqual({ cidr: "192.168.1.0/24", port: "80:443", protocol: "udp" });
  });

  it("loads egress policy from environment variables", () => {
    process.env.VM_DNS_MODE = "allow";
    process.env.VM_DNS_DOMAINS = "*.npmjs.org, github.com";
    process.env.VM_DNS_UPSTREAM = "1.1.1.1";
    process.env.VM_DEST_MODE = "deny";
    process.env.VM_DEST_RULES = "169.254.169.254/32, 10.0.0.0/8";
    process.env.VM_BW_ENABLED = "true";
    process.env.VM_BW_RATE_KBIT = "5120";
    process.env.VM_BW_BURST_KBIT = "512";

    const policy = loadEgressPolicy();

    expect(policy.dns.mode).toBe("allow");
    expect(policy.dns.domains).toEqual(["*.npmjs.org", "github.com"]);
    expect(policy.dns.upstreamDns).toEqual(["1.1.1.1"]);
    expect(policy.destination.mode).toBe("deny");
    expect(policy.destination.rules).toEqual([
      { cidr: "169.254.169.254/32" },
      { cidr: "10.0.0.0/8" },
    ]);
    expect(policy.bandwidth.enabled).toBe(true);
    expect(policy.bandwidth.egressRateKbit).toBe(5120);
    expect(policy.bandwidth.burstKbit).toBe(512);
  });
});
