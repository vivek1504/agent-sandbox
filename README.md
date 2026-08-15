# Agent Sandbox

> An isolated execution environment for AI agents made with Firecracker microVMs.

Give any AI agent its own Linux machine. Execute code, install packages, manipulate files, run processes, and access the internet, all inside a isolated microVM that boots in milliseconds and destroyed when the session ends.

---

## Why This Exists

AI agents need to *do things*: write code and run it, install libraries, curl endpoints, spawn background processes, read and write files. But running agent generated code on your host machine is unpredictable, potentially destructive, and impossible to sandbox with containers alone(shared kernel problem).

**Agent Sandbox** solves this by giving each agent session a dedicated Firecracker microVM:

- **Hardware level isolation** - each session runs in its own Linux kernel. A misbehaving agent cannot escape to the host or affect other sessions.
- **Millisecond startup** - pre-snapshotted VM state restores in 1–5ms, so agents don't wait for environments to spin up.
- **Full Linux environment** - agents get a real filesystem, process table, and network stack.
- **Pre-built & Custom Templates** - provision sessions with pre-baked Node.js, Python, Go, or custom Dockerfile environments.
- **Ephemeral by design** - sessions are stateless, time-bounded, and automatically reaped.

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
│         ┌──────────────┐    ┌───────────────────────────┐   │
│         │   Session    │───►│    Template Registry      │   │
│         │   Gateway    │    │ (Node, Python, Go, etc.)  │   │
│         └──────┬───────┘    └───────────────────────────┘   │
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

1. **Session request arrives** via the REST API, MCP protocol or client SDK, specifying an optional `template` (e.g. `node`, `python`, `go`).
2. The **Session Gateway** looks up the pre-built snapshot artifacts from the **Template Registry** and lazily creates a VM by restoring a snapshotted Firecracker instance in about ~1–5ms.
3. Each VM is placed inside its own **Linux network namespace** with a dedicated veth pair, TAP device, and NAT rules - giving the guest full outbound internet access while remaining isolated from other VMs.
4. Commands are sent to the guest **runtime** over a **vsock** channel. The runtime executes processes, manipulates the filesystem, and streams results back.
5. When a session is idle for 30 minutes (configurable), the **session reaper** tears down the VM, jail directory, and network namespace.

---

## Capabilities

Each agent session provides:

| Capability | Details |
|---|---|
| **Multiple Environments** | Pre-built templates for Node.js, Python, Go, and custom Dockerfiles. |
| **Execute commands** | Run any binary - `node`, `python3`, `go`, `sh`, `curl`, etc. Stdout/stderr streamed in real-time. |
| **Filesystem access** | Read, write, and list files within an isolated `/workspace` (tmpfs). |
| **Install packages** | Full network access - `npm install`, `pip install`, `go get` all work. |
| **Process management** | Per-command timeouts, cancellation via `SIGTERM`/`SIGKILL`, exit code tracking. |
| **Network access** | Each VM has its own network stack with DNS, outbound HTTP/HTTPS, and NAT. |
| **Session persistence** | Workspace state persists across commands within a session. |

---

## Environment Templates & Custom Snapshots

Agent Sandbox supports pre-snapshotted environment templates. Environments boot in milliseconds with pre-installed runtimes and dependencies.

### Bundled Templates

- **`node`** (Default): Alpine 3.20 + Node.js 22 + npm + git + curl
- **`python`**: Alpine 3.20 + Python 3.12 + pip + git + curl
- **`go`**: Alpine 3.20 + Go 1.23 + git + curl

### Building Templates

Use the included build pipeline script to build pre-configured or custom templates:

```bash
# Build the Node.js template snapshot
sudo ./templates/build.sh node

# Build the Python template snapshot
sudo ./templates/build.sh python

# Build the Go template snapshot
sudo ./templates/build.sh go
```

### Creating Custom Environment Templates

You can define custom environment templates by creating a directory under `templates/<your-template-name>/` with a `Dockerfile`:

```dockerfile
FROM agent-sandbox-base:latest

# Install custom tools and runtimes
RUN apk add --no-cache ruby rust cargo postgresql-client

LABEL template.name="data-science" \
      template.displayName="Data Science & Rust" \
      template.tools="ruby,rustc,cargo,psql"
```

Then generate the snapshot:

```bash
sudo ./templates/build.sh data-science
```

The build script will:
1. Build the Docker rootfs.
2. Extract the filesystem image into an ext4 rootfs.
3. Provision a Firecracker jail and boot the guest VM until `READY`.
4. Create the Firecracker snapshot state and write `template.json` metadata to `/var/lib/agent-sandbox/artifacts/templates/<name>/`.

---

## Interfaces

Agent Sandbox provides three integration layers - SDKs, REST API and MCP server.

### Client SDKs

Install a typed client library and start running code in two lines.

#### TypeScript / JavaScript

```bash
npm install @agent-sandbox/sdk
```

```ts
import { Sandbox } from "@agent-sandbox/sdk";

const sandbox = new Sandbox();
const session = sandbox.create({ template: "python" });

const result = await session.runCode("print(2 + 2)");
console.log(result.output[0].data);  // "4\n"

// Stream output in real-time
for await (const chunk of session.execStream("npm", { args: ["test"] })) {
  if (chunk.type === "stream") process.stdout.write(chunk.data!);
}

// Write + read files
await session.writeFile("data.json", JSON.stringify({ key: "value" }));
const { content } = await session.readFile("data.json");

await session.destroy();
```

Uses native `fetch` (Node 18+, Deno, Bun).
See [`sdk/typescript/README.md`](sdk/typescript/README.md) for the full API reference.

### REST API

HTTP endpoints for direct integration:

```bash
# List available environment templates
curl http://localhost:3000/exec/templates

# Execute a command in a session (specifying template)
curl -X POST http://localhost:3000/exec/session1/execute \
  -H "Content-Type: application/json" \
  -d '{"template":"python","command":"python3","args":["-c","print(\"hello from python template\")"]}'

# Write a file
curl -X POST http://localhost:3000/exec/session1/write \
  -H "Content-Type: application/json" \
  -d '{"path":"main.py","content":"print(\"hello\")"}'

# Read a file
curl http://localhost:3000/exec/session1/read?path=main.py

# List files
curl http://localhost:3000/exec/session1/files?recursive=true

# Destroy a session
curl -X DELETE http://localhost:3000/exec/session1

# List all sessions
curl http://localhost:3000/exec/
```

### MCP (Model Context Protocol)

An MCP server to connect any MCP-compatible AI agent (Claude, GPT, custom agents) directly:

| Tool | Description |
|---|---|
| `create_session` | Provision a new isolated environment (supports `template` parameter) |
| `list_templates` | List available environment templates (`node`, `python`, `go`, etc.) |
| `execute` | Run a command inside the session's VM |
| `write_file` | Write content to the session workspace |
| `read_file` | Read a file from the session workspace |
| `list_files` | List directory contents |
| `reset_session` | Destroy a session and release resources |

**Transports supported:**
- **SSE** - connect over HTTP with Bearer token auth (`/mcp` endpoint)
- **stdio** - run as a local MCP server via `npm run mcp`

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
| **Process** | Firecracker Jailer - chroot, UID/GID separation, `seccomp` |
| **Resources** | Configurable vCPU, memory, and file descriptor limits |
| **Lifecycle** | Automatic reaping of idle sessions (default: 30 min TTL) |
| **Security** | Path traversal prevention on all file operations |

---

## Authentication & Key Management

Agent Sandbox supports API key-based authentication with scope-based access control (`exec`, `admin`, `metrics`) and per-key rate limiting.

### Managing Keys via CLI

Use the key management CLI to create, list, rotate, or revoke API keys:

```bash
# Create a key with default 'exec' scope
npm run keys create "my-agent-key"

# Create an admin key with custom rate limit (100 req/min)
npm run keys create "admin-key" --scopes exec,admin,metrics --rate-limit 100

# List all keys
npm run keys list

# Rotate a key
npm run keys rotate <key-id>

# Revoke a key
npm run keys revoke <key-id>
```

### Authentication Usage

API keys can be supplied via HTTP headers, query parameters, or the SDK:

```bash
# Authorization Header
curl -H "Authorization: Bearer sk_test_..." http://localhost:3000/exec/templates

# X-API-Key Header
curl -H "X-API-Key: sk_test_..." http://localhost:3000/exec/templates
```

```ts
import { Sandbox } from "@agent-sandbox/sdk";

const sandbox = new Sandbox({
  // AUTH_KEY_PREFIX e.g. 'sk_test_' is read from environment variables
  apiKey: `${process.env.AUTH_KEY_PREFIX}example-key`,
});
```

---

## Getting Started

### Prerequisites

- **Linux host** with KVM support (`/dev/kvm` must be accessible)
- [**Firecracker**](https://github.com/firecracker-microvm/firecracker) and **Jailer** binaries installed
- **Node.js** v18+
- **Docker** (required for template build pipeline)
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
git clone https://github.com/vivek1504/agent-sandbox.git
cd agent-sandbox
npm install
```

### Prepare Kernel Artifact

Download the guest kernel image:

```bash
sudo mkdir -p /var/lib/agent-sandbox/artifacts
wget https://github.com/vivek1504/agent-sandbox/releases/download/Beta/vmlinux
sudo mv vmlinux /var/lib/agent-sandbox/artifacts/
sudo chown -R root:firecracker /var/lib/agent-sandbox/artifacts
sudo chmod 750 /var/lib/agent-sandbox/artifacts
```

### Build Template Snapshots

Build the default environment templates (`node`, `python`, `go`):

```bash
# Build Node.js template
sudo ./templates/build.sh node

# Build Python template
sudo ./templates/build.sh python

# Build Go template
sudo ./templates/build.sh go
```

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

# List loaded templates
curl http://localhost:3000/exec/templates

# Run a command in a new Python session
curl -X POST http://localhost:3000/exec/test-session/execute \
  -H "Content-Type: application/json" \
  -d '{ "template": "python", "command": "python3", "args": ["--version"] }'
```

---

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `LOG_LEVEL` | `debug` | Pino log level |
| `MCP_AUTH_TOKEN` | *(Required)* | Bearer token for MCP SSE endpoint |
| `FIRECRACKER_BIN` | `/usr/local/bin/firecracker` | Path to Firecracker binary |
| `FIRECRACKER_JAILER_BIN` | `/usr/local/bin/jailer` | Path to Jailer binary |
| `FIRECRACKER_JAIL_BASE` | `/var/lib/agent-sandbox/jailer` | Base directory for Jailer chroots |
| `FIRECRACKER_ARTIFACTS_DIR` | `/var/lib/agent-sandbox/artifacts` | Snapshot, memory, kernel, and template storage |
| `FIRECRACKER_UID` | `997` | UID for the Firecracker process |
| `FIRECRACKER_GID` | `982` | GID for the Firecracker process |
| `VM_VCPU_COUNT` | `1` | Number of guest vCPUs configured for the VM |
| `VM_MEM_SIZE_MIB` | `128` | Guest RAM size in MiB (must match the snapshot configuration) |
| `VM_CPU_QUOTA_US` | `50000` | CPU quota in microseconds for cgroups (bandwidth limit) |
| `VM_CPU_PERIOD_US` | `100000` | CPU period in microseconds for cgroups |
| `VM_MEMORY_LIMIT_BYTES` | `134217728` (128 MiB) | Host-side cgroup memory limit in bytes |
| `VM_NOFILE_LIMIT` | `1024` | Maximum number of open file descriptors for the VM process |
| `VM_DISK_LIMIT_BYTES` | `536870912` (512 MiB) | Host-side cgroup disk quota limit in bytes |
| `VM_DNS_MODE` | `none` | Per-VM DNS filtering mode (`none`, `allow`, `deny`) |
| `VM_DNS_DOMAINS` | `""` | Comma-separated domain filter list (e.g. `*.npmjs.org,github.com`) |
| `VM_DNS_UPSTREAM` | `8.8.8.8,1.1.1.1` | Comma-separated upstream DNS servers |
| `VM_DEST_MODE` | `none` | Per-VM IP/Port destination filtering mode (`none`, `allow`, `deny`) |
| `VM_DEST_RULES` | `""` | Destination CIDR/port rules (e.g. `169.254.169.254/32,10.0.0.0/8:443/tcp`) |
| `VM_BW_ENABLED` | `false` | Enable TC bandwidth throttling per VM (`true`, `false`) |
| `VM_BW_RATE_KBIT` | `10240` | Rate limit in kbit/s (10240 = 10 Mbit/s) |
| `VM_BW_BURST_KBIT` | `1024` | Burst limit in kbit |

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
| `vm_resource_config` | Gauge | Configured host resource limits per VM (labels: `resource`) |
| `vm_egress_policy_applied_total` | Counter | Applied VM network egress policies (labels: `dns_mode`, `dest_mode`, `bw_enabled`) |

Additional endpoints:

- `GET /health` - basic liveness check
- `GET /ready` - readiness probe (memory threshold)

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

Tests cover the session gateway, VM protocol, jailer path handling, cleanup lifecycle, network setup, egress policies, template registry, and MCP tool integration using [Vitest](https://vitest.dev/) and [Supertest](https://github.com/ladjs/supertest).

---

## Project Structure

```
src/
├── server.ts                # Entrypoint - HTTP server + host network setup
├── app.ts                   # Express app - routes, middleware, metrics
├── logger.ts                # Structured logging (Pino) with redaction
├── metrics.ts               # Prometheus metrics definitions
├── create_snapshot.ts       # One-shot script to create VM template snapshots
├── session/
│   ├── session.ts           # Session state machine + reaper
│   └── gateway.ts           # Lazy VM creation + message dispatch
├── vm/
│   ├── vm-manager.ts        # VM lifecycle - create, restore, teardown
│   ├── jailer.ts            # Jailer integration - chroot, hardlinks, paths
│   ├── templates.ts         # Template registry - discovery, validation & metadata
│   ├── networking.ts        # Per-VM network namespace & egress controls
│   ├── egress-policy.ts     # Config parser for DNS, IP/Port & TC egress policies
│   ├── egress-policy.test.ts # Unit tests for egress policies
│   ├── protocol.ts          # Vsock response parsing + streaming
│   ├── transport.ts         # Vsock connection management
│   └── cleanup.ts           # Idempotent VM cleanup
├── routes/
│   └── exec.ts              # REST API for session execution
└── mcp/
    ├── server.ts            # MCP tool definitions
    ├── routes.ts            # SSE transport + auth middleware
    └── stdio.ts             # Stdio transport for local MCP

templates/
├── build.sh                 # Template build pipeline script (Docker -> ext4 -> snapshot)
├── base/
│   └── Dockerfile           # Minimal guest base image (socat, node, runtime, start.sh)
├── node/
│   └── Dockerfile           # Node.js environment template
├── python/
│   └── Dockerfile           # Python 3.12 environment template
└── go/
    └── Dockerfile           # Go 1.23 environment template

sdk/
├── typescript/              # @agent-sandbox/sdk - TypeScript/JS client (zero deps)
    ├── src/
    │   ├── index.ts         # Barrel export
    │   ├── client.ts        # Sandbox client - session factory + admin
    │   ├── session.ts       # Session handle - exec, runCode, filesystem
    │   └── types.ts         # All type definitions
    ├── package.json
    └── README.md


minimal-rootfs/
├── start.sh                 # Guest init - networking, runtime, socat bridge
└── runtime/
    └── runtime.js           # Guest-side agent runtime (execute, fs, cancel)
```

---

## Tech Stack

| Component | Technology |
|---|---|
| Execution engine | [Firecracker](https://github.com/firecracker-microvm/firecracker) microVMs |
| Process isolation | [Jailer](https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md) (chroot + seccomp + UID separation) |
| Network isolation | Linux network namespaces, veth pairs, TAP, iptables NAT, `dnsmasq`, `tc` |
| Host ↔ VM IPC | vsock + socat bridge |
| Agent protocol | [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) |
| API framework | Express 5 (Node.js) |
| Client SDKs | TypeScript |
| Observability | Pino (structured logs) + prom-client (Prometheus metrics) |
| Testing | Vitest + Supertest |

---

## Roadmap

- [x] Pre-built environment snapshots (Node.js, Python, Go, Custom Dockerfiles)
- [x] Typed client SDKs (TypeScript)
- [x] Per-session resource limits (CPU, memory, disk, network bandwidth)
- [ ] Persistent workspace volumes across sessions
- [ ] Multi-host execution with session routing
- [x] streaming for real-time output

---

## Author

**Vivek Jadhav** - [github.com/vivek1504](https://github.com/vivek1504)
