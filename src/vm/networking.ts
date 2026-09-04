import { execSync, exec as execCb } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { vmLogger } from "../logger.js";
import { vmEgressPolicyApplied, vmSlotCapacity } from "../metrics.js";
import {
  type EgressPolicy,
  type DnsPolicy,
  type DestinationPolicy,
  type DestinationRule,
  type BandwidthPolicy,
  loadEgressPolicy,
} from "./egress-policy.js";

const execAsync = promisify(execCb);

const usedSlots = new Set<number>();
export const MAX_SLOTS = parseInt(process.env.VM_MAX_SLOTS ?? "254", 10);

function updateSlotMetrics(): void {
  vmSlotCapacity.set({ state: "used" }, usedSlots.size);
  vmSlotCapacity.set({ state: "available" }, MAX_SLOTS - usedSlots.size);
}

export function allocateSlot(): number {
  for (let slot = 1; slot <= MAX_SLOTS; slot++) {
    if (!usedSlots.has(slot)) {
      usedSlots.add(slot);
      updateSlotMetrics();
      return slot;
    }
  }
  throw new Error(`No available network slots (max ${MAX_SLOTS} concurrent VMs)`);
}

export function releaseSlot(slot: number): void {
  usedSlots.delete(slot);
  updateSlotMetrics();
}

export function recoverUsedSlots(): void {
  usedSlots.clear();

  try {
    const nsListOut = execSync("ip netns list 2>/dev/null", { encoding: "utf-8" });
    const namespaces = nsListOut
      .split("\n")
      .map((line) => line.split(" ")[0]?.trim())
      .filter((name): name is string => !!name && /^ns-[A-Za-z0-9_-]+$/.test(name));

    for (const ns of namespaces) {
      try {
        const shortId = ns.replace("ns-", "");
        const vethHost = `vh-${shortId}`;
        const addrOut = execSync(`ip addr show ${vethHost} 2>/dev/null`, { encoding: "utf-8" });
        const match = addrOut.match(/10\.0\.(\d+)\.\d+/);
        if (match && match[1]) {
          const slot = parseInt(match[1], 10);
          usedSlots.add(slot);
          vmLogger.info({ slot, ns }, "recovered used network slot from OS state");
        }
      } catch {
        // veth interface may be gone or unassigned
      }
    }
  } catch {
    // ip netns list failed or unprivileged context
  }

  updateSlotMetrics();
  vmLogger.info({ usedSlots: [...usedSlots] }, "slot recovery complete");
}

export interface VmNetworkInfo {
  slot: number;
  nsName: string;
  nsPath: string;
  vethHost: string;
  vethNs: string;
  hostIp: string;
  nsIp: string;
  tapIp: string;
  guestIp: string;
  egressPolicy?: EgressPolicy;
}

function buildNetworkInfo(vmId: string, slot: number): VmNetworkInfo {
  const shortId = vmId.slice(0, 8);
  return {
    slot,
    nsName: `ns-${shortId}`,
    nsPath: `/var/run/netns/ns-${shortId}`,
    vethHost: `vh-${shortId}`,
    vethNs: `vn-${shortId}`,
    hostIp: `10.0.${slot}.2`,
    nsIp: `10.0.${slot}.1`,
    tapIp: "192.168.241.1",
    guestIp: "192.168.241.2",
  };
}

async function run(cmd: string, label: string): Promise<void> {
  vmLogger.debug({ cmd }, label);
  await execAsync(cmd);
}

async function runInNs(nsName: string, cmd: string, label: string): Promise<void> {
  const fullCmd = `ip netns exec ${nsName} sh -c "${cmd.replace(/"/g, '\\"')}"`;
  vmLogger.debug({ cmd: fullCmd }, label);
  await execAsync(fullCmd);
}

async function setupEgressChain(info: VmNetworkInfo): Promise<void> {
  await runInNs(
    info.nsName,
    `iptables -t nat -A POSTROUTING -s 192.168.241.0/29 -o ${info.vethNs} -j MASQUERADE`,
    "namespace NAT masquerade",
  );

  await runInNs(
    info.nsName,
    `iptables -A FORWARD -i ${info.vethNs} -o tap0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`,
    "namespace forward veth->tap (established)",
  );

  await runInNs(
    info.nsName,
    `iptables -N VM_EGRESS`,
    "create IPv4 VM egress chain",
  );

  await runInNs(
    info.nsName,
    `iptables -A FORWARD -i tap0 -o ${info.vethNs} -j VM_EGRESS`,
    "forward tap->veth via IPv4 VM_EGRESS chain",
  );

  // Block IPv6 forward traffic to prevent egress policy bypass
  try {
    await runInNs(
      info.nsName,
      "ip6tables -P INPUT DROP && ip6tables -P FORWARD DROP && ip6tables -P OUTPUT DROP",
      "drop IPv6 traffic in namespace",
    );
  } catch (err) {
    let ipv6Enabled = false;
    try {
      if (fs.existsSync("/proc/sys/net/ipv6/conf/all/disable_ipv6")) {
        ipv6Enabled = fs.readFileSync("/proc/sys/net/ipv6/conf/all/disable_ipv6", "utf-8").trim() === "0";
      }
    } catch {}

    if (ipv6Enabled && (process.env.STRICT_PERMISSIONS === "true" || process.env.NODE_ENV === "production")) {
      throw new Error(
        `Failed to enforce IPv6 egress drop inside namespace ${info.nsName} while host IPv6 is enabled: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    vmLogger.warn(
      { nsName: info.nsName, err },
      "ip6tables could not be configured in namespace; IPv6 module may not be present",
    );
  }
}

function sanitizeDomain(domain: string): string | null {
  const clean = domain.startsWith("*.") ? domain.slice(2) : domain;
  const trimmed = clean.trim();
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(trimmed)) {
    vmLogger.warn({ domain }, "skipping invalid domain name in DNS policy");
    return null;
  }
  return trimmed;
}

async function setupDnsFiltering(info: VmNetworkInfo, dns: DnsPolicy): Promise<void> {
  if (dns.mode === "none") return;

  const confDir = `/tmp/dnsmasq-${info.nsName}`;
  fs.mkdirSync(confDir, { recursive: true });

  const upstreamServers =
    dns.upstreamDns && dns.upstreamDns.length > 0
      ? dns.upstreamDns
      : ["8.8.8.8", "1.1.1.1"];

  let config = `# Auto-generated for ${info.nsName}\nlisten-address=${info.tapIp}\nbind-interfaces\nno-resolv\n`;
  for (const s of upstreamServers) {
    config += `server=${s}\n`;
  }

  if (dns.mode === "deny") {
    for (const domain of dns.domains) {
      const clean = sanitizeDomain(domain);
      if (clean) config += `address=/${clean}/\n`;
    }
  } else if (dns.mode === "allow") {
    config += `address=/#/\n`;
    for (const domain of dns.domains) {
      const clean = sanitizeDomain(domain);
      if (clean) config += `server=/${clean}/${upstreamServers[0]}\n`;
    }
  }

  const confFile = path.join(confDir, "dnsmasq.conf");
  const pidFile = path.join(confDir, "dnsmasq.pid");
  const logFile = path.join(confDir, "dnsmasq.log");

  fs.writeFileSync(confFile, config);

  await runInNs(
    info.nsName,
    `dnsmasq --conf-file=${confFile} --pid-file=${pidFile} --log-facility=${logFile}`,
    "start dnsmasq DNS filter",
  );

  await Promise.all([
    runInNs(
      info.nsName,
      `iptables -t nat -A PREROUTING -i tap0 -p udp --dport 53 -j REDIRECT --to-ports 53`,
      "redirect guest DNS (UDP) to local dnsmasq filter",
    ),
    runInNs(
      info.nsName,
      `iptables -t nat -A PREROUTING -i tap0 -p tcp --dport 53 -j REDIRECT --to-ports 53`,
      "redirect guest DNS (TCP) to local dnsmasq filter",
    ),
    runInNs(
      info.nsName,
      `iptables -A INPUT -i tap0 -p udp --dport 53 -j ACCEPT`,
      "allow redirected DNS (UDP) to dnsmasq",
    ),
    runInNs(
      info.nsName,
      `iptables -A INPUT -i tap0 -p tcp --dport 53 -j ACCEPT`,
      "allow redirected DNS (TCP) to dnsmasq",
    ),
    runInNs(
      info.nsName,
      `iptables -A VM_EGRESS -p udp --dport 53 -j DROP`,
      "block direct DNS egress (UDP)",
    ),
    runInNs(
      info.nsName,
      `iptables -A VM_EGRESS -p tcp --dport 53 -j DROP`,
      "block direct DNS egress (TCP)",
    ),
  ]);

  vmLogger.info(
    { nsName: info.nsName, mode: dns.mode, domainCount: dns.domains.length },
    "DNS filtering configured",
  );
}

async function teardownDnsFiltering(info: VmNetworkInfo): Promise<void> {
  const confDir = `/tmp/dnsmasq-${info.nsName}`;
  const pidFile = path.join(confDir, "dnsmasq.pid");

  try {
    if (fs.existsSync(pidFile)) {
      const pid = fs.readFileSync(pidFile, "utf-8").trim();
      if (pid) {
        await runInNs(info.nsName, `kill ${pid}`, "stop dnsmasq");
      }
    }
  } catch (err) {
    vmLogger.warn({ nsName: info.nsName, err }, "failed to stop dnsmasq process");
  }

  try {
    if (fs.existsSync(confDir)) {
      fs.rmSync(confDir, { recursive: true, force: true });
    }
  } catch { }
}

function buildIptablesRule(
  rule: DestinationRule,
  target: "ACCEPT" | "DROP",
): string {
  let cmd = `iptables -A VM_EGRESS -d ${rule.cidr}`;
  const proto = rule.protocol ?? "all";

  if (proto !== "all") {
    cmd += ` -p ${proto}`;
  }

  if (rule.port) {
    if (!rule.protocol || rule.protocol === "all") {
      cmd += ` -p tcp`;
    }
    cmd += ` --dport ${rule.port}`;
  }

  cmd += ` -j ${target}`;
  return cmd;
}

async function setupDestinationFiltering(
  info: VmNetworkInfo,
  dest: DestinationPolicy,
): Promise<void> {
  const metadataBlockRules: DestinationRule[] = [
    { cidr: "169.254.169.254/32", protocol: "all" },
  ];

  for (const rule of metadataBlockRules) {
    const cmd = buildIptablesRule(rule, "DROP");
    await runInNs(info.nsName, cmd, "block cloud metadata");
  }


  if (dest.mode === "deny") {
    for (const rule of dest.rules) {
      const cmd = buildIptablesRule(rule, "DROP");
      await runInNs(info.nsName, cmd, `deny ${rule.cidr}`);
    }
    await runInNs(
      info.nsName,
      `iptables -A VM_EGRESS -j ACCEPT`,
      "default accept other destinations",
    );
  } else if (dest.mode === "allow") {
    for (const rule of dest.rules) {
      const cmd = buildIptablesRule(rule, "ACCEPT");
      await runInNs(info.nsName, cmd, `allow ${rule.cidr}`);
    }
    await runInNs(
      info.nsName,
      `iptables -A VM_EGRESS -j DROP`,
      "default deny all unlisted destinations",
    );
  } else {
    await runInNs(
      info.nsName,
      `iptables -A VM_EGRESS -j ACCEPT`,
      "default accept all destinations",
    );
  }

  vmLogger.info(
    { nsName: info.nsName, mode: dest.mode, ruleCount: dest.rules.length },
    "destination filtering configured",
  );
}

async function setupBandwidthThrottling(
  info: VmNetworkInfo,
  bw: BandwidthPolicy,
): Promise<void> {
  if (!bw.enabled) return;

  await runInNs(
    info.nsName,
    `tc qdisc add dev tap0 root handle 1: htb default 10`,
    "add HTB qdisc on tap0",
  );
  await runInNs(
    info.nsName,
    `tc class add dev tap0 parent 1: classid 1:10 htb rate ${bw.egressRateKbit}kbit burst ${bw.burstKbit}kbit`,
    `set egress rate ${bw.egressRateKbit}kbit`,
  );

  await runInNs(
    info.nsName,
    `tc qdisc add dev tap0 handle ffff: ingress`,
    "add ingress qdisc on tap0",
  );
  await runInNs(
    info.nsName,
    `tc filter add dev tap0 parent ffff: protocol ip u32 match u32 0 0 police rate ${bw.egressRateKbit}kbit burst ${bw.burstKbit}kbit drop flowid :1`,
    `set ingress police ${bw.egressRateKbit}kbit`,
  );

  vmLogger.info(
    { nsName: info.nsName, rateKbit: bw.egressRateKbit, burstKbit: bw.burstKbit },
    "bandwidth throttling configured",
  );
}

export async function setupVmNetwork(
  vmId: string,
  egressPolicy: EgressPolicy = loadEgressPolicy(),
): Promise<VmNetworkInfo> {
  const slot = allocateSlot();
  const info = buildNetworkInfo(vmId, slot);
  info.egressPolicy = egressPolicy;

  vmLogger.info(
    {
      vmId,
      nsName: info.nsName,
      slot,
      hostIp: info.hostIp,
      nsIp: info.nsIp,
      egressPolicy: {
        dnsMode: egressPolicy.dns.mode,
        destMode: egressPolicy.destination.mode,
        bwEnabled: egressPolicy.bandwidth.enabled,
      },
    },
    "setting up VM network namespace",
  );

  try {
    await execAsync(`ip netns delete ${info.nsName} 2>/dev/null`).catch(() => {});
    await execAsync(`ip link delete ${info.vethHost} 2>/dev/null`).catch(() => {});
  } catch {}

  try {
    await run(`ip netns add ${info.nsName}`, "create namespace");

    await run(
      [
        `ip link add ${info.vethHost} type veth peer name ${info.vethNs}`,
        `ip link set ${info.vethNs} netns ${info.nsName}`,
        `ip link set ${info.vethHost} up`,
        `ip addr add ${info.hostIp}/30 dev ${info.vethHost}`,
      ].join(" && "),
      "create veth pair and configure host side",
    );

    await runInNs(
      info.nsName,
      [
        "ip link set lo up",
        `ip link set ${info.vethNs} up`,
        `ip addr add ${info.nsIp}/30 dev ${info.vethNs}`,
        `ip route add default via ${info.hostIp}`,
        "ip tuntap add tap0 mode tap",
        "ip link set tap0 up",
        `ip addr add ${info.tapIp}/29 dev tap0`,
      ].join(" && "),
      "configure namespace interfaces and routing",
    );

    await Promise.all([
      runInNs(
        info.nsName,
        "sysctl -w net.ipv4.ip_forward=1",
        "enable ip forwarding in namespace",
      ),
      runInNs(
        info.nsName,
        "sysctl -w net.ipv4.conf.tap0.rp_filter=2",
        "set loose rp_filter for tap0",
      ),
      runInNs(
        info.nsName,
        "sysctl -w net.ipv4.conf.all.rp_filter=2",
        "set loose rp_filter for all",
      ),
      runInNs(
        info.nsName,
        "sysctl -w net.ipv6.conf.all.disable_ipv6=1 2>/dev/null || true",
        "disable ipv6 in namespace",
      ),
    ]);

    await setupEgressChain(info);

    if (egressPolicy.dns.mode !== "none") {
      await setupDnsFiltering(info, egressPolicy.dns);
    }

    await setupDestinationFiltering(info, egressPolicy.destination);

    await setupBandwidthThrottling(info, egressPolicy.bandwidth);

    vmEgressPolicyApplied.inc({
      dns_mode: egressPolicy.dns.mode,
      dest_mode: egressPolicy.destination.mode,
      bw_enabled: String(egressPolicy.bandwidth.enabled),
    });

    vmLogger.info(
      { vmId, nsName: info.nsName },
      "VM network namespace setup complete",
    );

    return info;
  } catch (err) {
    vmLogger.error({ vmId, err }, "VM network setup failed, cleaning up");
    try {
      await teardownVmNetwork(info);
    } catch (cleanupErr) {
      vmLogger.warn({ vmId, cleanupErr }, "cleanup after failed network setup also failed");
    }
    throw err;
  }
}

export async function teardownVmNetwork(info: VmNetworkInfo): Promise<void> {
  vmLogger.info(
    { nsName: info.nsName, slot: info.slot },
    "tearing down VM network namespace",
  );

  try {
    await teardownDnsFiltering(info);
  } catch (err) {
    vmLogger.warn({ nsName: info.nsName, err }, "failed to cleanup DNS filtering");
  }

  try {
    await run(`ip netns delete ${info.nsName}`, "delete namespace");
  } catch (err) {
    vmLogger.warn({ nsName: info.nsName, err }, "failed to delete namespace");
  }

  try {
    await run(`ip link delete ${info.vethHost}`, "delete host veth");
  } catch {
  }

  releaseSlot(info.slot);

  vmLogger.info(
    { nsName: info.nsName, slot: info.slot },
    "VM network namespace teardown complete",
  );
}

//to fix the bug where stale namespaces were not cleaned up and there was 100% packet loss
export function cleanupStaleNetworkResources(): void {
  try {
    const nsListOut = execSync("ip netns list 2>/dev/null", { encoding: "utf-8" });
    const staleNamespaces = nsListOut
      .split("\n")
      .map((line) => line.split(" ")[0]?.trim())
      .filter((name): name is string => !!name && /^ns-[A-Za-z0-9_-]+$/.test(name));

    if (staleNamespaces.length === 0) return;

    vmLogger.info(
      { count: staleNamespaces.length, namespaces: staleNamespaces },
      "cleaning up stale network namespaces from previous runs",
    );

    for (const ns of staleNamespaces) {
      const shortId = ns.replace("ns-", "");
      const vethHost = `vh-${shortId}`;

      try {
        execSync(`ip link delete ${vethHost} 2>/dev/null`, { stdio: "pipe" });
      } catch {
        // veth may already be gone
      }

      try {
        execSync(`ip netns delete ${ns} 2>/dev/null`, { stdio: "pipe" });
      } catch {
        // namespace may already be gone
      }

      const confDir = `/tmp/dnsmasq-${ns}`;
      try {
        if (fs.existsSync(confDir)) {
          fs.rmSync(confDir, { recursive: true, force: true });
        }
      } catch { }

      vmLogger.debug({ ns, vethHost }, "cleaned up stale namespace");
    }

    vmLogger.info(
      { cleaned: staleNamespaces.length },
      "stale network resource cleanup complete",
    );
  } catch (err) {
    vmLogger.warn({ err }, "failed to clean up stale network resources");
  }
}

export function ensureHostNetworkSetup(): void {
  vmLogger.info("verifying host network prerequisites");

  cleanupStaleNetworkResources();
  const fwd = execSync("sysctl -n net.ipv4.ip_forward", { encoding: "utf-8" }).trim();
  if (fwd !== "1") {
    throw new Error(
      "net.ipv4.ip_forward is not enabled. Run: sudo sysctl -w net.ipv4.ip_forward=1",
    );
  }

  const routeOut = execSync("ip route get 8.8.8.8", { encoding: "utf-8" });
  const match = routeOut.match(/dev\s+(\S+)/);
  if (!match) {
    throw new Error("Could not detect internet-facing interface");
  }
  const iface = match[1];

  vmLogger.info({ internetInterface: iface }, "host network prerequisites OK");

  try {
    const existing = execSync("iptables -t nat -S POSTROUTING", {
      encoding: "utf-8",
    });
    if (!existing.includes("-s 10.0.0.0/16")) {
      run(
        `iptables -t nat -A POSTROUTING -s 10.0.0.0/16 -o ${iface} -j MASQUERADE`,
        "add host NAT for VM veth subnets",
      );
    }
  } catch (err) {
    vmLogger.warn({ err }, "could not verify/add host NAT rule");
  }

  try {
    const existing = execSync("iptables -S FORWARD", { encoding: "utf-8" });
    if (!existing.includes("-s 10.0.0.0/16 -j ACCEPT")) {
      run(
        `iptables -I FORWARD -s 10.0.0.0/16 -j ACCEPT`,
        "add host FORWARD for VM subnets (outbound)",
      );
    }
    if (!existing.includes("-d 10.0.0.0/16")) {
      run(
        `iptables -I FORWARD -d 10.0.0.0/16 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`,
        "add host FORWARD for VM subnets (return)",
      );
    }
    if (!existing.includes("169.254.169.254")) {
      run(
        `iptables -I FORWARD -s 10.0.0.0/16 -d 169.254.169.254/32 -j DROP`,
        "block cloud metadata from VMs (host-level)",
      );
    }
  } catch (err) {
    vmLogger.warn({ err }, "could not verify/add host FORWARD rules");
  }

  try {
    const existingInput = execSync("iptables -S INPUT", { encoding: "utf-8" });
    if (!existingInput.includes("-s 10.0.0.0/16 -j DROP")) {
      run(
        `iptables -I INPUT -s 10.0.0.0/16 -j DROP`,
        "block VMs from accessing host services (host-level INPUT)",
      );
    }
  } catch (err) {
    vmLogger.warn({ err }, "could not verify/add host INPUT drop rule");
  }
}
