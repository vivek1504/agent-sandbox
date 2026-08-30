import crypto from "crypto";
import { execSync } from "child_process";
import { time, computeStats, type BenchmarkSuite, type TimingResult } from "../harness.js";
import { allocateSlot, releaseSlot, setupVmNetwork, teardownVmNetwork } from "../../vm/networking.js";
import { loadEgressPolicy } from "../../vm/egress-policy.js";
import type { BenchSuiteOptions } from "./vm-lifecycle.js";

function execQuiet(cmd: string): void {
  execSync(cmd, { stdio: "pipe" });
}

export async function runNetworkingSuite(opts: BenchSuiteOptions): Promise<BenchmarkSuite> {
  const egressPolicy = loadEgressPolicy();

  const samples: Record<string, number[]> = {
    netns_create: [],
    veth_pair_and_ip: [],
    tap_device_setup: [],
    sysctl_config: [],
    iptables_egress_chain: [],
    dns_filtering_setup: [],
    tc_bandwidth_setup: [],
    full_setupVmNetwork: [],
    full_teardownVmNetwork: [],
  };

  const totalRuns = opts.iterations > 1 ? opts.iterations + 1 : opts.iterations;

  for (let i = 0; i < totalRuns; i++) {
    const isWarmup = opts.iterations > 1 && i === 0;
    const vmId = `bench-${crypto.randomBytes(4).toString("hex")}`;
    const shortId = vmId.slice(0, 8);
    const nsName = `ns-${shortId}`;
    const vethHost = `vh-${shortId}`;
    const vethNs = `vn-${shortId}`;

    const slot = allocateSlot();
    const hostIp = `10.0.${slot}.2`;
    const nsIp = `10.0.${slot}.1`;
    const tapIp = "192.168.241.1";

    // 1. netns_create
    const { durationMs: nsMs } = await time(() => {
      execQuiet(`ip netns add ${nsName}`);
    });

    // 2. veth_pair_and_ip
    const { durationMs: vethMs } = await time(() => {
      execQuiet(`ip link add ${vethHost} type veth peer name ${vethNs}`);
      execQuiet(`ip link set ${vethNs} netns ${nsName}`);
      execQuiet(`ip link set ${vethHost} up`);
      execQuiet(`ip addr add ${hostIp}/30 dev ${vethHost}`);
      execQuiet(`ip netns exec ${nsName} ip link set lo up`);
      execQuiet(`ip netns exec ${nsName} ip link set ${vethNs} up`);
      execQuiet(`ip netns exec ${nsName} ip addr add ${nsIp}/30 dev ${vethNs}`);
      execQuiet(`ip netns exec ${nsName} ip route add default via ${hostIp}`);
    });

    // 3. tap_device_setup
    const { durationMs: tapMs } = await time(() => {
      execQuiet(`ip netns exec ${nsName} ip tuntap add tap0 mode tap`);
      execQuiet(`ip netns exec ${nsName} ip link set tap0 up`);
      execQuiet(`ip netns exec ${nsName} ip addr add ${tapIp}/29 dev tap0`);
    });

    // 4. sysctl_config
    const { durationMs: sysctlMs } = await time(() => {
      execQuiet(`ip netns exec ${nsName} sysctl -w net.ipv4.ip_forward=1`);
      execQuiet(`ip netns exec ${nsName} sysctl -w net.ipv4.conf.tap0.rp_filter=0`);
      execQuiet(`ip netns exec ${nsName} sysctl -w net.ipv4.conf.all.rp_filter=0`);
    });

    // 5. iptables_egress_chain
    const { durationMs: iptablesMs } = await time(() => {
      execQuiet(`ip netns exec ${nsName} iptables -t nat -A POSTROUTING -s 192.168.241.0/29 -o ${vethNs} -j MASQUERADE`);
      execQuiet(`ip netns exec ${nsName} iptables -A FORWARD -i ${vethNs} -o tap0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`);
      execQuiet(`ip netns exec ${nsName} iptables -N VM_EGRESS`);
      execQuiet(`ip netns exec ${nsName} iptables -A FORWARD -i tap0 -o ${vethNs} -j VM_EGRESS`);
      execQuiet(`ip netns exec ${nsName} iptables -A VM_EGRESS -d 169.254.169.254/32 -j DROP`);
      execQuiet(`ip netns exec ${nsName} iptables -A VM_EGRESS -j ACCEPT`);
    });

    // 6. dns_filtering_setup (simulate dummy check or rule)
    const { durationMs: dnsMs } = await time(() => {
      execQuiet(`ip netns exec ${nsName} iptables -A VM_EGRESS -p udp --dport 53 -j ACCEPT`);
    });

    // 7. tc_bandwidth_setup
    const { durationMs: tcMs } = await time(() => {
      execQuiet(`ip netns exec ${nsName} tc qdisc add dev tap0 root handle 1: htb default 10`);
      execQuiet(`ip netns exec ${nsName} tc class add dev tap0 parent 1: classid 1:10 htb rate 100000kbit burst 10000kbit`);
    });

    // Clean up standalone test namespace
    try {
      execQuiet(`ip netns delete ${nsName}`);
      execQuiet(`ip link delete ${vethHost}`);
    } catch {}
    releaseSlot(slot);

    // 8 & 9. full setup & teardown
    const { result: fullInfo, durationMs: fullSetupMs } = await time(() =>
      setupVmNetwork(vmId, egressPolicy),
    );

    const { durationMs: fullTeardownMs } = await time(() =>
      teardownVmNetwork(fullInfo),
    );

    if (!isWarmup) {
      samples.netns_create!.push(nsMs);
      samples.veth_pair_and_ip!.push(vethMs);
      samples.tap_device_setup!.push(tapMs);
      samples.sysctl_config!.push(sysctlMs);
      samples.iptables_egress_chain!.push(iptablesMs);
      samples.dns_filtering_setup!.push(dnsMs);
      samples.tc_bandwidth_setup!.push(tcMs);
      samples.full_setupVmNetwork!.push(fullSetupMs);
      samples.full_teardownVmNetwork!.push(fullTeardownMs);
    }
  }

  const results: TimingResult[] = Object.keys(samples).map((key) =>
    computeStats(key, samples[key] ?? []),
  );

  return { name: "Networking Breakdown", results };
}
