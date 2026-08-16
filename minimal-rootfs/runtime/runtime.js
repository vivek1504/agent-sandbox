const net = require("net");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const WORKSPACE = "/workspace";
const WORKSPACE_PREFIX = WORKSPACE + path.sep;
const activeProcesses = new Map();

function isInsideWorkspace(absPath) {
  return absPath === WORKSPACE || absPath.startsWith(WORKSPACE_PREFIX);
}

const handlers = {
  execute: handleExecute,
  write_file: handleWriteFile,
  read_file: handleReadFile,
  list_files: handleListFiles,
  cancel: handleCancel,
};

const server = net.createServer((socket) => {
  let buffer = "";

  socket.on("data", async (chunk) => {
    buffer += chunk.toString();

    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!raw) continue;

      try {
        const msg = JSON.parse(raw);

        const handler = handlers[msg.type];
        if (handler) {
          handler(socket, msg);
          continue;
        }

        sendError(
          socket,
          msg.id || "unknown",
          `Unknown message type: ${msg.type}`,
          -1,
        );
      } catch (err) {
        socket.write(
          JSON.stringify({ type: "error", error: err.message }) + "\n",
        );
      }
    }
  });

  socket.on("error", (err) => {
    console.error("Socket error:", err);
  });
});

server.listen("/tmp/runtime.sock", () => {
  console.log("Runtime ready");
});

function handleExecute(socket, msg) {
  const { id, command, args = [], cwd = ".", env = {}, timeout = 30000 } = msg;

  const workDir = path.resolve(WORKSPACE, cwd);

  if (!isInsideWorkspace(workDir)) {
    return sendError(socket, id, "Path traversal detected", -1);
  }

  const proc = spawn(command, args, {
    cwd: workDir,
    env: { ...process.env, HOME: WORKSPACE, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  activeProcesses.set(id, proc);
  const startTime = Date.now();

  proc.stdout.on("data", (chunk) => {
    socket.write(
      JSON.stringify({
        type: "stream",
        id,
        stream: "stdout",
        data: chunk.toString(),
      }) + "\n",
    );
  });

  proc.stderr.on("data", (chunk) => {
    socket.write(
      JSON.stringify({
        type: "stream",
        id,
        stream: "stderr",
        data: chunk.toString(),
      }) + "\n",
    );
  });

  const timer = setTimeout(() => {
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 5000);
  }, timeout);

  proc.on("close", (exitCode, signal) => {
    clearTimeout(timer);
    activeProcesses.delete(id);

    socket.write(
      JSON.stringify({
        type: "response",
        id,
        data: {
          exitCode: exitCode ?? -1,
          signal: signal || undefined,
          duration: Date.now() - startTime,
        },
      }) + "\n",
    );
  });

  proc.on("error", (err) => {
    clearTimeout(timer);
    activeProcesses.delete(id);
    sendError(socket, id, err.message, -1);
  });
}

function handleWriteFile(socket, msg) {
  const { id, path: filePath, content } = msg;

  const absPath = path.resolve(WORKSPACE, filePath);
  if (!isInsideWorkspace(absPath)) {
    return sendError(socket, id, "Path traversal detected", -1);
  }

  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });

    const decoded = Buffer.from(content, "base64");
    fs.writeFileSync(absPath, decoded);
    const bytesWritten = decoded.length;

    socket.write(
      JSON.stringify({
        type: "response",
        id,
        data: { bytesWritten },
      }) + "\n",
    );
  } catch (err) {
    sendError(socket, id, err.message, -1);
  }
}

function handleReadFile(socket, msg) {
  const { id, path: filePath } = msg;

  const absPath = path.resolve(WORKSPACE, filePath);
  if (!isInsideWorkspace(absPath)) {
    return sendError(socket, id, "Path traversal detected", -1);
  }

  try {
    const raw = fs.readFileSync(absPath);
    const content = raw.toString("base64");
    socket.write(
      JSON.stringify({
        type: "response",
        id,
        data: {
          content,
          size: raw.length,
        },
      }) + "\n",
    );
  } catch (err) {
    sendError(socket, id, err.message, -1);
  }
}

function handleListFiles(socket, msg) {
  const { id, path: dirPath = ".", recursive = false } = msg;

  const absPath = path.resolve(WORKSPACE, dirPath);
  if (!isInsideWorkspace(absPath)) {
    return sendError(socket, id, "Path traversal detected", -1);
  }

  try {
    const files = [];
    listDir(absPath, WORKSPACE, recursive, files);

    socket.write(
      JSON.stringify({
        type: "response",
        id,
        data: { files },
      }) + "\n",
    );
  } catch (err) {
    sendError(socket, id, err.message, -1);
  }
}

function listDir(dir, root, recursive, result) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(root, fullPath);

    if (entry.isDirectory()) {
      result.push({ path: relPath, type: "dir", size: 0 });
      if (recursive) listDir(fullPath, root, recursive, result);
    } else {
      const stat = fs.statSync(fullPath);
      result.push({ path: relPath, type: "file", size: stat.size });
    }
  }
}

function handleCancel(socket, msg) {
  const { id } = msg;
  const proc = activeProcesses.get(id);

  if (!proc) {
    return sendError(socket, id, "No running process with this id", -1);
  }

  proc.kill("SIGTERM");
  setTimeout(() => {
    if (!proc.killed) proc.kill("SIGKILL");
  }, 5000);
}

function sendError(socket, id, error, code) {
  socket.write(JSON.stringify({ type: "error", id, error, code }) + "\n");
}
