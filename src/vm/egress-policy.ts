export interface DnsPolicy {
  mode: "allow" | "deny" | "none";
  domains: string[];
  upstreamDns?: string[];
}

export interface DestinationRule {
  cidr: string;
  port?: string;
  protocol?: "tcp" | "udp" | "all";
}

export interface DestinationPolicy {
  mode: "allow" | "deny" | "none";
  rules: DestinationRule[];
}

export interface BandwidthPolicy {
  enabled: boolean;
  egressRateKbit: number;
  burstKbit: number;
}

export interface EgressPolicy {
  dns: DnsPolicy;
  destination: DestinationPolicy;
  bandwidth: BandwidthPolicy;
}

export function parseDestinationRules(raw: string): DestinationRule[] {
  if (!raw.trim()) return [];
  return raw.split(",").map(entry => {
    const trimmed = entry.trim();
    let proto: "tcp" | "udp" | "all" | undefined;
    let rest = trimmed;

    if (rest.endsWith("/tcp")) {
      proto = "tcp";
      rest = rest.slice(0, -4);
    } else if (rest.endsWith("/udp")) {
      proto = "udp";
      rest = rest.slice(0, -4);
    } else if (rest.endsWith("/all")) {
      proto = "all";
      rest = rest.slice(0, -4);
    }

    const firstColon = rest.indexOf(":");
    let cidr: string;
    let port: string | undefined;

    if (firstColon !== -1) {
      cidr = rest.slice(0, firstColon).trim();
      port = rest.slice(firstColon + 1).trim();
    } else {
      cidr = rest.trim();
    }

    return {
      cidr,
      ...(port ? { port } : {}),
      ...(proto ? { protocol: proto } : {}),
    };
  });
}


export function loadEgressPolicy(): EgressPolicy {
  const dnsMode = (process.env.VM_DNS_MODE as "allow" | "deny" | "none") ?? "none";
  const destMode = (process.env.VM_DEST_MODE as "allow" | "deny" | "none") ?? "none";

  return {
    dns: {
      mode: ["allow", "deny", "none"].includes(dnsMode) ? dnsMode : "none",
      domains: process.env.VM_DNS_DOMAINS
        ? process.env.VM_DNS_DOMAINS.split(",").map(d => d.trim()).filter(Boolean)
        : [],
      upstreamDns: process.env.VM_DNS_UPSTREAM
        ? process.env.VM_DNS_UPSTREAM.split(",").map(d => d.trim()).filter(Boolean)
        : ["8.8.8.8", "1.1.1.1"],
    },
    destination: {
      mode: ["allow", "deny", "none"].includes(destMode) ? destMode : "none",
      rules: process.env.VM_DEST_RULES
        ? parseDestinationRules(process.env.VM_DEST_RULES)
        : [],
    },
    bandwidth: {
      enabled: process.env.VM_BW_ENABLED === "true",
      egressRateKbit: parseInt(process.env.VM_BW_RATE_KBIT ?? "10240", 10),
      burstKbit: parseInt(process.env.VM_BW_BURST_KBIT ?? "1024", 10),
    },
  };
}
