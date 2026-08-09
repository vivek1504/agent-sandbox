# Agent Sandbox

> An isolated execution environment for AI agents — powered by Firecracker microVMs.

Give any AI agent its own ephemeral Linux machine. Execute code, install packages, manipulate files, run processes, and access the internet — all inside a hardware-isolated microVM that boots in milliseconds and vanishes when the session ends.

---

## Why This Exists

AI agents need to *do things*: write code and run it, install libraries, curl endpoints, spawn background processes, read and write files. But running agent-generated code on your host machine is a non-starter — it's unpredictable, potentially destructive, and impossible to sandbox with containers alone.

**Agent Sandbox** solves this by giving each agent session a dedicated Firecracker microVM:

- **Hardware-level isolation** — each session runs in its own Linux kernel. A misbehaving agent cannot escape to the host or affect other sessions.
- **Millisecond startup** — pre-snapshotted VM state restores in 1–5ms, so agents don't wait for environments to spin up.
- **Full Linux environment** — agents get a real filesystem, process table, and network stack. If it runs on Linux, it runs here.
- **Ephemeral by design** — sessions are stateless, time-bounded, and automatically reaped. No cleanup, no drift.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Host (Linux + KVM)                   │
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │  Express API  │    │  MCP Server  │    │   Metrics    │   │
│  │  /exec/*      │    │  stdio / SSE │    │  /metrics    │   │
│  └──────┬───────┘    └──────┬───────┘    └──────────────┘   │
│         │                   │                               │
│         └───────┬───────────┘                               │
│                 ▼                                           │
│         ┌──────────────┐                                    │
│         │   Session    │  create / touch / reap / destroy   │
│         │   Gateway    │                                    │
│         └──────┬───────┘                                    │
│                ▼                                            │
│    ┌───────────────────────┐                                │
│    │     VM Manager        │                                │
│    │  jailer + snapshot    │                                │
│    │  restore + lifecycle  │                                │
│    └───────────┬───────────┘                                │
│                │                                            │
│    ┌───────────┴───────────────────────────────┐            │
│    │        Per-VM Network Namespace           │            │
│    │  veth pair ── TAP ── NAT / iptables       │            │
│    └───────────┬───────────────────────────────┘            │
│                │ vsock                                      │
│    ╔═══════════╧═══════════════════════════════╗            │
│    ║        Firecracker microVM                ║            │
│    ║                                           ║            │
│    ║   ┌─────────────┐     ┌──────────────┐    ║            │
│    ║   │  runtime.js  │───│  /workspace   │    ║            │
│    ║   │  (Node.js)   │    │  (tmpfs)      │    ║            │
│    ║   └─────────────┘     └──────────────┘    ║            │
│    ║         │                                 ║            │
│    ║   socat ◄──► vsock:5000                   ║            │
│    ╚═══════════════════════════════════════════╝            │
└─────────────────────────────────────────────────────────────┘
```

### How It Works

1. **Session request arrives** via the REST API or MCP protocol.
2. The **Session Gateway** lazily creates a VM — restoring a pre-snapshotted Firecracker instance via the Jailer in ~1–5ms.
3. Each VM is placed inside its own **Linux network namespace** with a dedicated veth pair, TAP device, and NAT rules — giving the guest full outbound internet access while remaining isolated from other VMs.
4. Commands are sent to the guest **runtime** over a **vsock** channel. The runtime executes processes, manipulates the filesystem, and streams results back.
5. When a session is idle for 30 minutes (configurable), the **session reaper** tears down the VM, jail directory, and network namespace.

---

## Capabilities

Each agent session provides:

| Capability | Details |
|---|---|
| **Execute commands** | Run any binary — `node`, `sh`, `curl`, etc. Stdout/stderr streamed in real-time.
| **Filesystem access** | Read, write, and list files within an isolated `/workspace` (tmpfs). |
| **Install packages** | Full network access — `npm install`, `apt-get` all work. |
| **Process management** | Per-command timeouts, cancellation via `SIGTERM`/`SIGKILL`, exit code tracking. |
| **Network access** | Each VM has its own network stack with DNS, outbound HTTP/HTTPS, and NAT. |
| **Session persistence** | Workspace state persists across commands within a session. |

---

## Interfaces

Agent Sandbox exposes two interfaces — pick whichever fits your integration:

### REST API

Session-scoped HTTP endpoints for direct integration:

```bash
# Execute a command
curl -X POST http://localhost:3000/exec/session1/execute \
  -H "Content-Type: application/json" \
  -d '{"command":"node","args":["-e","console.log(\"hello from the sandbox\")"]}'

# Write a file
curl -X POST http://localhost:3000/exec/session1/write \
  -H "Content-Type: application/json" \
  -d '{"path":"main.js","content":"console.log(\"hello\")"}'

# Read a file
curl http://localhost:3000/exec/session1/read?path=main.js

# List files
curl http://localhost:3000/exec/session1/files?recursive=true

# Destroy a session
curl -X DELETE http://localhost:3000/exec/session1

# List all sessions
curl http://localhost:3000/exec/
```

### MCP (Model Context Protocol)

A first-class MCP server — connect any MCP-compatible AI agent (Claude, GPT, custom agents) directly:

| Tool | Description |
|---|---|
| `create_session` | Provision a new isolated environment |
| `execute` | Run a command inside the session's VM |
| `write_file` | Write content to the session workspace |
| `read_file` | Read a file from the session workspace |
| `list_files` | List directory contents |
| `reset_session` | Destroy a session and release resources |

**Transports supported:**
- **SSE** — connect over HTTP with Bearer token auth (`/mcp` endpoint)
- **stdio** — run as a local MCP server via `npm run mcp`

```json
{
  "mcpServers": {
    "agent-sandbox": {
      "command": "node",
      "args": ["dist/mcp/stdio.js"]
    }
  }
}
```

---

## Isolation Model

Every session gets defense-in-depth isolation:

| Layer | Mechanism |
|---|---|
| **Compute** | Dedicated Firecracker microVM with its own Linux kernel |
| **Filesystem** | Read-only rootfs + ephemeral tmpfs workspace |
| **Network** | Per-VM Linux network namespace (veth + TAP + NAT) |
| **Process** | Firecracker Jailer — chroot, UID/GID separation, `seccomp` |
| **Resources** | Configurable vCPU, memory, and file descriptor limits |
| **Lifecycle** | Automatic reaping of idle sessions (default: 30 min TTL) |
| **Security** | Path traversal prevention on all file operations |

---

## Getting Started

### Prerequisites

- **Linux host** with KVM support (`/dev/kvm` must be accessible)
- [**Firecracker**](https://github.com/firecracker-microvm/firecracker) and **Jailer** binaries installed
- **Node.js** v18+
- **Root access** (required for Jailer, network namespaces, and iptables)

#### Install Firecracker & Jailer

Download the latest release from [firecracker-microvm/firecracker](https://github.com/firecracker-microvm/firecracker/releases) and place both binaries in `/usr/local/bin/`:

```bash
# Example for v1.16.0 (check for the latest version)
ARCH="$(uname -m)"
release_url="https://github.com/firecracker-microvm/firecracker/releases"
latest=$(basename $(curl -fsSLI -o /dev/null -w %{url_effective} ${release_url}/latest))

curl -L ${release_url}/download/${latest}/firecracker-${latest}-${ARCH}.tgz | tar -xz

sudo mv release-${latest}-${ARCH}/firecracker-${latest}-${ARCH} /usr/local/bin/firecracker
sudo mv release-${latest}-${ARCH}/jailer-${latest}-${ARCH} /usr/local/bin/jailer
rm -rf release-${latest}-${ARCH}

# Verify
firecracker --version
```

#### Create a Firecracker System User

The Jailer runs Firecracker processes under a dedicated unprivileged user. Create the group and user if they don't already exist:

```bash
sudo groupadd -g 982 firecracker 2>/dev/null || true
sudo useradd -u 997 -g 982 -M -s /usr/sbin/nologin firecracker 2>/dev/null || true
```

> **Note:** The default UID/GID (997/982) can be overridden via the `FIRECRACKER_UID` and `FIRECRACKER_GID` environment variables.

#### Enable IP Forwarding

VMs need outbound internet access. Enable kernel IP forwarding:

```bash
# Enable now
sudo sysctl -w net.ipv4.ip_forward=1

# Persist across reboots
echo "net.ipv4.ip_forward = 1" | sudo tee /etc/sysctl.d/99-ip-forward.conf
```

### Install

```bash
git clone https://github.com/vivek1504/lambda.git
cd lambda
npm install
```

### Prepare Artifacts

Download the pre-built kernel and rootfs from the [releases page](https://github.com/vivek1504/lambda/releases):

```bash
# Download kernel and rootfs
wget https://github.com/vivek1504/lambda/releases/download/Beta/vmlinux
wget https://github.com/vivek1504/lambda/releases/download/Beta/rootfs.ext4.gz
gunzip rootfs.ext4.gz
```

Place them where the Jailer expects them, with the correct ownership:

```bash
sudo mkdir -p /var/lib/lambda/artifacts
sudo cp vmlinux rootfs.ext4 /var/lib/lambda/artifacts/
sudo chown -R root:firecracker /var/lib/lambda/artifacts
sudo chmod 750 /var/lib/lambda/artifacts
```

### Create the Base Snapshot

The system restores VMs from a pre-initialized snapshot. Create it once:

```bash
# Build the TypeScript
npx tsc -b

# Create the snapshot (requires root for networking + jailer)
sudo node dist/create_snapshot.js
```

This boots a fresh VM, waits for the guest runtime to signal `READY`, pauses it, and saves the snapshot + memory state to `/var/lib/lambda/artifacts/`. The process takes about 5–10 seconds.

### Start the Server

The server requires root to manage network namespaces, iptables rules, and the Jailer:

```bash
sudo npm start
# → listening on http://localhost:3000
```

### Verify

```bash
# Health check
curl http://localhost:3000/health

# Run a command in a new session
curl -X POST http://localhost:3000/exec/test-session/execute \
  -H "Content-Type: application/json" \
  -d '{ "command": "uname", "args": ["-a"] }'
```

You should see the guest kernel info from inside the microVM:

```json
{
  "exitCode": 0,
  "duration": 4,
  "output": [
    { "stream": "stdout", "data": "Linux (none) 6.1.155 ... x86_64 GNU/Linux\n" }
  ]
}
```

---

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `LOG_LEVEL` | `debug` | Pino log level |
| `MCP_AUTH_TOKEN` | `test-secret-123` | Bearer token for MCP SSE endpoint |
| `FIRECRACKER_BIN` | `/usr/local/bin/firecracker` | Path to Firecracker binary |
| `FIRECRACKER_JAILER_BIN` | `/usr/local/bin/jailer` | Path to Jailer binary |
| `FIRECRACKER_JAIL_BASE` | `/var/lib/lambda/jailer` | Base directory for Jailer chroots |
| `FIRECRACKER_ARTIFACTS_DIR` | `/var/lib/lambda/artifacts` | Snapshot, memory, kernel, and rootfs storage |
| `FIRECRACKER_UID` | `997` | UID for the Firecracker process |
| `FIRECRACKER_GID` | `982` | GID for the Firecracker process |

---

## Observability

Built-in Prometheus metrics at `/metrics`:

| Metric | Type | Description |
|---|---|---|
| `active_vm_count` | Gauge | Currently running VMs by state |
| `vm_creation_time` | Histogram | Snapshot restore latency |
| `exec_sessions_active` | Gauge | Active agent sessions |
| `exec_session_duration_seconds` | Histogram | Session lifetimes |
| `exec_message_total` | Counter | Messages by type (execute, write_file, etc.) |
| `exec_message_duration_seconds` | Histogram | Command round-trip time |
| `vsock_connection_time` | Histogram | Host ↔ VM connection latency |
| `vsock_errors_total` | Counter | Connection/parse/timeout errors |

Additional endpoints:

- `GET /health` — basic liveness check
- `GET /ready` — readiness probe (memory threshold)

---

## Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

Tests cover the session gateway, VM protocol, jailer path handling, cleanup lifecycle, network setup, and MCP tool integration using [Vitest](https://vitest.dev/) and [Supertest](https://github.com/ladjs/supertest).

---

## Project Structure

```
src/
├── server.ts                # Entrypoint — HTTP server + host network setup
├── app.ts                   # Express app — routes, middleware, metrics
├── logger.ts                # Structured logging (Pino) with redaction
├── metrics.ts               # Prometheus metrics definitions
├── create_snapshot.ts       # One-shot script to create the base VM snapshot
├── session/
│   ├── session.ts           # Session state machine + reaper
│   └── gateway.ts           # Lazy VM creation + message dispatch
├── vm/
│   ├── vm-manager.ts        # VM lifecycle — create, restore, teardown
│   ├── jailer.ts            # Jailer integration — chroot, hardlinks, paths
│   ├── networking.ts        # Per-VM network namespace setup/teardown
│   ├── protocol.ts          # Vsock response parsing + streaming
│   ├── transport.ts         # Vsock connection management
│   └── cleanup.ts           # Idempotent VM cleanup
├── routes/
│   └── exec.ts              # REST API for session execution
└── mcp/
    ├── server.ts            # MCP tool definitions
    ├── routes.ts            # SSE transport + auth middleware
    └── stdio.ts             # Stdio transport for local MCP

minimal-rootfs/
├── start.sh                 # Guest init — networking, runtime, socat bridge
└── runtime/
    └── runtime.js           # Guest-side agent runtime (execute, fs, cancel)
```

---

## Tech Stack

| Component | Technology |
|---|---|
| Execution engine | [Firecracker](https://github.com/firecracker-microvm/firecracker) microVMs |
| Process isolation | [Jailer](https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md) (chroot + seccomp + UID separation) |
| Network isolation | Linux network namespaces, veth pairs, TAP, iptables NAT |
| Host ↔ VM IPC | vsock + socat bridge |
| Agent protocol | [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) |
| API framework | Express 5 (Node.js) |
| Observability | Pino (structured logs) + prom-client (Prometheus metrics) |
| Testing | Vitest + Supertest |

---

## Roadmap

- [ ] Per-session resource limits (CPU, memory, disk, network bandwidth)
- [ ] Persistent workspace volumes across sessions
- [ ] Multi-host execution with session routing
- [ ] WebSocket streaming for real-time output
- [ ] Pre-built environment snapshots (Python, Rust, Go, etc.)

---

## Author

**Vivek Jadhav** — [github.com/vivek1504](https://github.com/vivek1504)
