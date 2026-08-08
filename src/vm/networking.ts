import { execSync } from "child_process";
import { vmLogger } from "../logger.js";

const usedSlots = new Set<number>();

export function allocateSlot(): number {
  for (let slot = 1; slot <= 254; slot++) {
    if (!usedSlots.has(slot)) {
      usedSlots.add(slot);
      return slot;
    }
  }
  throw new Error("No available network slots (max 254 concurrent VMs)");
}

export function releaseSlot(slot: number): void {
  usedSlots.delete(slot);
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

function run(cmd: string, label: string): void {
  vmLogger.debug({ cmd }, label);
  execSync(cmd, { stdio: "pipe" });
}

function runInNs(nsName: string, cmd: string, label: string): void {
  const fullCmd = `ip netns exec ${nsName} ${cmd}`;
  vmLogger.debug({ cmd: fullCmd }, label);
  execSync(fullCmd, { stdio: "pipe" });
}

export function setupVmNetwork(vmId: string): VmNetworkInfo {
  const slot = allocateSlot();
  const info = buildNetworkInfo(vmId, slot);

  vmLogger.info(
    { vmId, nsName: info.nsName, slot, hostIp: info.hostIp, nsIp: info.nsIp },
    "setting up VM network namespace",
  );

  try {
    run(`ip netns add ${info.nsName}`, "create namespace");

    run(
      `ip link add ${info.vethHost} type veth peer name ${info.vethNs}`,
      "create veth pair",
    );

    run(
      `ip link set ${info.vethNs} netns ${info.nsName}`,
      "move veth to namespace",
    );
    run(`ip link set ${info.vethHost} up`, "bring up host veth");
    run(
      `ip addr add ${info.hostIp}/30 dev ${info.vethHost}`,
      "assign host veth IP",
    );

    runInNs(info.nsName, "ip link set lo up", "bring up loopback");
    runInNs(
      info.nsName,
      `ip link set ${info.vethNs} up`,
      "bring up namespace veth",
    );
    runInNs(
      info.nsName,
      `ip addr add ${info.nsIp}/30 dev ${info.vethNs}`,
      "assign namespace veth IP",
    );
    runInNs(
      info.nsName,
      `ip route add default via ${info.hostIp}`,
      "set default route in namespace",
    );

    runInNs(info.nsName, "ip tuntap add tap0 mode tap", "create TAP");
    runInNs(info.nsName, "ip link set tap0 up", "bring up TAP");
    runInNs(
      info.nsName,
      `ip addr add ${info.tapIp}/29 dev tap0`,
      "assign TAP IP",
    );

    runInNs(
      info.nsName,
      "sysctl -w net.ipv4.ip_forward=1",
      "enable ip forwarding in namespace",
    );
    runInNs(
      info.nsName,
      "sysctl -w net.ipv4.conf.tap0.rp_filter=0",
      "disable rp_filter for tap0",
    );
    runInNs(
      info.nsName,
      "sysctl -w net.ipv4.conf.all.rp_filter=0",
      "disable rp_filter for all",
    );

    runInNs(
      info.nsName,
      `iptables -t nat -A POSTROUTING -s 192.168.241.0/29 -o ${info.vethNs} -j MASQUERADE`,
      "namespace NAT masquerade",
    );
    runInNs(
      info.nsName,
      `iptables -A FORWARD -i tap0 -o ${info.vethNs} -j ACCEPT`,
      "namespace forward tap->veth",
    );
    runInNs(
      info.nsName,
      `iptables -A FORWARD -i ${info.vethNs} -o tap0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`,
      "namespace forward veth->tap (established)",
    );

    vmLogger.info(
      { vmId, nsName: info.nsName },
      "VM network namespace setup complete",
    );

    return info;
  } catch (err) {
    vmLogger.error({ vmId, err }, "VM network setup failed, cleaning up");
    try {
      teardownVmNetwork(info);
    } catch (cleanupErr) {
      vmLogger.warn({ vmId, cleanupErr }, "cleanup after failed network setup also failed");
    }
    throw err;
  }
}

export function teardownVmNetwork(info: VmNetworkInfo): void {
  vmLogger.info(
    { nsName: info.nsName, slot: info.slot },
    "tearing down VM network namespace",
  );

  try {
    run(`ip netns delete ${info.nsName}`, "delete namespace");
  } catch (err) {
    vmLogger.warn({ nsName: info.nsName, err }, "failed to delete namespace");
  }

  try {
    run(`ip link delete ${info.vethHost}`, "delete host veth");
  } catch {
  }

  releaseSlot(info.slot);

  vmLogger.info(
    { nsName: info.nsName, slot: info.slot },
    "VM network namespace teardown complete",
  );
}

export function ensureHostNetworkSetup(): void {
  vmLogger.info("verifying host network prerequisites");
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
    if (!existing.includes("10.0.0.0/16")) {
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
    if (!existing.includes("10.0.0.0/16")) {
      run(
        `iptables -A FORWARD -s 10.0.0.0/16 -j ACCEPT`,
        "add host FORWARD for VM subnets (outbound)",
      );
      run(
        `iptables -A FORWARD -d 10.0.0.0/16 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`,
        "add host FORWARD for VM subnets (return)",
      );
    }
  } catch (err) {
    vmLogger.warn({ err }, "could not verify/add host FORWARD rules");
  }
}
