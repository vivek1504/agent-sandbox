# @agent-sandbox/sdk

> TypeScript/JavaScript client SDK for [Agent Sandbox](https://github.com/vivek1504/agent-sandbox) to run code in isolated Firecracker microVMs.

Uses native `fetch` (Node 18+, Deno, Bun, browsers).

## Install

```bash
npm install @agent-sandbox/sdk
```

## Quick Start

```ts
import { Sandbox } from "@agent-sandbox/sdk";

const sandbox = new Sandbox();

// Create a session with a random ID
const session = sandbox.create({ template: "python" });

// Run code directly
const result = await session.runCode("print(2 + 2)");
console.log(result.output[0].data); // "4\n"

// Clean up
await session.destroy();
```

## Usage

### Create a Client

```ts
import { Sandbox } from "@agent-sandbox/sdk";

// Defaults to http://localhost:3000
const sandbox = new Sandbox();

// Or point at a remote server
const sandbox = new Sandbox({
  baseUrl: "https://sandbox.example.com",
  headers: { Authorization: "Bearer sk-..." },
  defaultTemplate: "node",
  defaultTimeout: 60_000,
});
```

### Sessions

Sessions are handles to a running Firecracker microVM. They're lazy — the VM is only provisioned on first use.

```ts
// Named session (deterministic ID)
const session = sandbox.session("build-123", { template: "node" });

// Auto-generated session ID
const session = sandbox.create({ template: "python" });
```

### Execute Commands

```ts
// Run any binary
const result = await session.exec("node", {
  args: ["-e", "console.log('hello')"],
  timeout: 10_000,
});

console.log(result.exitCode);  // 0
console.log(result.output);    // [{ stream: "stdout", data: "hello\n", ts: ... }]

// Run a shell command
const result = await session.run("echo hello && ls -la");

// Run code using the session's default runtime
const result = await session.runCode("print('hello')");  // python template
const result = await session.runCode("console.log(42)");  // node template
```

### Stream Output

For long-running commands, stream output as it arrives:

```ts
for await (const chunk of session.execStream("npm", { args: ["test"] })) {
  if (chunk.type === "stream") {
    process.stdout.write(chunk.data!);
  } else if (chunk.type === "result") {
    console.log("Exit code:", chunk.exitCode);
  }
}
```

### Filesystem

```ts
// Write a file
await session.writeFile("index.js", 'console.log("hello")');

// Read a file
const { content } = await session.readFile("index.js");

// List files
const { files } = await session.listFiles(".", { recursive: true });
```

### Templates

```ts
// List available templates
const templates = await sandbox.templates();
// [{ name: "node", displayName: "Node.js 22", tools: ["node","npm","sh"] }]

// List active sessions
const sessions = await sandbox.sessions();

// Health check
const ok = await sandbox.healthy();
```

### Session Lifecycle

```ts
// Destroy a session and its VM
await session.destroy();
```

## Error Handling

All errors throw `SandboxError` with the HTTP status code:

```ts
import { SandboxError } from "@agent-sandbox/sdk";

try {
  await session.exec("nonexistent-binary");
} catch (err) {
  if (err instanceof SandboxError) {
    console.error(err.statusCode, err.message);
  }
}
```

## API Reference

### `Sandbox`

| Method | Description |
|---|---|
| `session(id, opts?)` | Get a session handle by ID |
| `create(opts?)` | Create a session with a random ID |
| `templates()` | List available VM templates |
| `sessions()` | List all active sessions |
| `healthy()` | Health check the server |

### `Session`

| Method | Description |
|---|---|
| `exec(command, opts?)` | Execute a command |
| `execStream(command, opts?)` | Execute with streaming output |
| `run(shellCommand, opts?)` | Run a shell command via `sh -c` |
| `runCode(code, opts?)` | Run code using the session's runtime |
| `writeFile(path, content)` | Write a file to `/workspace` |
| `readFile(path)` | Read a file from `/workspace` |
| `listFiles(path?, opts?)` | List files in `/workspace` |
| `destroy()` | Destroy session and release resources |

## License

MIT
