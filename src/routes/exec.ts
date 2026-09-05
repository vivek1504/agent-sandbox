import { Router } from "express";
import { sendSessionMessage, ensureSession } from "../session/gateway.js";
import { destroySession, getSession, getAllSessions } from "../session/session.js";
import { listTemplates } from "../vm/templates.js";

const SAFE_SESSION_ID_REGEX = /^[A-Za-z0-9_-]+$/;

function validateSessionId(sessionId: string, res: any): boolean {
  if (!sessionId || !SAFE_SESSION_ID_REGEX.test(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId: must contain only alphanumeric characters, dashes, or underscores" });
    return false;
  }
  return true;
}

function mapErrorToStatus(err: any): number {
  if (err?.statusCode) return err.statusCode;
  const msg = err?.message || "";
  if (msg.includes("belongs to another") || msg.includes("Forbidden")) return 403;
  if (msg.includes("Path traversal") || msg.includes("Invalid")) return 400;
  if (msg.includes("not found") || msg.includes("Unknown template")) return 404;
  if (msg.includes("timeout") || msg.includes("Timeout")) return 504;
  return 500;
}

export const execRouter = Router();

execRouter.get("/templates", (_req, res) => {
  res.json({ templates: listTemplates() });
});

execRouter.post("/:sessionId/execute", async (req, res) => {
  const { sessionId } = req.params;
  if (!validateSessionId(sessionId, res)) return;

  const { command, args, cwd, env, timeout, template } = req.body;

  if (!command || typeof command !== "string" || !command.trim()) {
    return res.status(400).json({ error: "command is required and must be a non-empty string" });
  }
  if (command.length > 4096) {
    return res.status(400).json({ error: "command exceeds maximum length of 4096 characters" });
  }
  if (args !== undefined) {
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
      return res.status(400).json({ error: "args must be an array of strings" });
    }
    if (args.length > 100) {
      return res.status(400).json({ error: "args cannot contain more than 100 items" });
    }
    if (args.some((a) => a.length > 4096)) {
      return res.status(400).json({ error: "individual args cannot exceed 4096 characters" });
    }
  }
  if (cwd !== undefined) {
    if (typeof cwd !== "string") {
      return res.status(400).json({ error: "cwd must be a string" });
    }
    if (cwd.length > 512) {
      return res.status(400).json({ error: "cwd cannot exceed 512 characters" });
    }
  }
  if (env !== undefined) {
    if (typeof env !== "object" || env === null || Array.isArray(env)) {
      return res.status(400).json({ error: "env must be an object of key-value string pairs" });
    }
    const envEntries = Object.entries(env);
    if (envEntries.length > 64) {
      return res.status(400).json({ error: "too many environment variables (max 64)" });
    }
    for (const [k, v] of envEntries) {
      if (typeof v !== "string") {
        return res.status(400).json({ error: `env value for "${k}" must be a string` });
      }
      if (v.length > 8192) {
        return res.status(400).json({ error: `env value for "${k}" exceeds max length of 8192` });
      }
    }
  }
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)) {
    return res.status(400).json({ error: "timeout must be a positive number" });
  }
  if (typeof timeout === "number" && timeout > 300000) {
    return res.status(400).json({ error: "timeout cannot exceed 300000ms" });
  }
  if (template !== undefined && (typeof template !== "string" || template.length > 64)) {
    return res.status(400).json({ error: "template must be a string up to 64 characters" });
  }

  const execTimeout = typeof timeout === "number" && timeout > 0 ? timeout : 60000;

  const wantsNdjson =
    req.headers.accept === "application/x-ndjson" ||
    req.query.format === "ndjson";

  if (wantsNdjson) {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    try {
      const result = await sendSessionMessage(
        sessionId,
        { type: "execute", command, args, cwd, env, timeout: execTimeout },
        (chunk) => {
          res.write(JSON.stringify({ type: "stream", ...chunk, ts: Date.now() }) + "\n");
        },
        execTimeout,
        template,
        req.apiKey?.id,
      );

      res.write(JSON.stringify({ type: "result", ...result.data }) + "\n");
      res.end();
    } catch (err: any) {
      res.write(JSON.stringify({ type: "error", error: err.message }) + "\n");
      res.end();
    }
    return;
  }

  const output: { stream: string; data: string; ts: number }[] = [];

  try {
    const result = await sendSessionMessage(
      sessionId,
      { type: "execute", command, args, cwd, env, timeout: execTimeout },
      (chunk) => {
        output.push({ stream: chunk.stream, data: chunk.data, ts: Date.now() });
      },
      execTimeout,
      template,
      req.apiKey?.id,
    );

    res.json({
      exitCode: result.data?.exitCode,
      signal: result.data?.signal,
      duration: result.data?.duration,
      output,
    });
  } catch (err: any) {
    res.status(mapErrorToStatus(err)).json({ error: err.message });
  }
});


execRouter.post("/:sessionId/write", async (req, res) => {
  const { sessionId } = req.params;
  if (!validateSessionId(sessionId, res)) return;

  const { path: filePath, content, mode } = req.body;

  if (!filePath || typeof filePath !== "string" || content === undefined || typeof content !== "string") {
    return res.status(400).json({ error: "path and content must be strings" });
  }
  if (filePath.length > 1024) {
    return res.status(400).json({ error: "path cannot exceed 1024 characters" });
  }
  if (content.length > 10 * 1024 * 1024) {
    return res.status(400).json({ error: "content exceeds maximum allowed size of 10MB" });
  }

  try {
    const contentBase64 = Buffer.from(content, "utf8").toString("base64");
    const result = await sendSessionMessage(
      sessionId,
      { type: "write_file", path: filePath, content: contentBase64, mode },
      undefined,
      60000,
      undefined,
      req.apiKey?.id,
    );
    res.json(result.data);
  } catch (err: any) {
    res.status(mapErrorToStatus(err)).json({ error: err.message });
  }
});

execRouter.get("/:sessionId/read", async (req, res) => {
  const { sessionId } = req.params;
  if (!validateSessionId(sessionId, res)) return;

  const { path: filePath } = req.query;

  if (!filePath || typeof filePath !== "string") {
    return res.status(400).json({ error: "path query param required and must be a string" });
  }
  if (filePath.length > 1024) {
    return res.status(400).json({ error: "path cannot exceed 1024 characters" });
  }

  try {
    const result = await sendSessionMessage(
      sessionId,
      { type: "read_file", path: filePath },
      undefined,
      60000,
      undefined,
      req.apiKey?.id,
    );
    const data = result.data;
    res.json({
      ...data,
      content: Buffer.from(data.content, "base64").toString("utf8"),
    });
  } catch (err: any) {
    res.status(mapErrorToStatus(err)).json({ error: err.message });
  }
});

execRouter.get("/:sessionId/files", async (req, res) => {
  const { sessionId } = req.params;
  if (!validateSessionId(sessionId, res)) return;

  const { path: dirPath, recursive } = req.query;
  if (dirPath !== undefined && typeof dirPath !== "string") {
    return res.status(400).json({ error: "path must be a string" });
  }

  try {
    const result = await sendSessionMessage(
      sessionId,
      { type: "list_files", path: dirPath, recursive: recursive === "true" },
      undefined,
      60000,
      undefined,
      req.apiKey?.id,
    );
    res.json(result.data);
  } catch (err: any) {
    res.status(mapErrorToStatus(err)).json({ error: err.message });
  }
});

execRouter.delete("/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  if (!validateSessionId(sessionId, res)) return;

  try {
    const ownerId = req.apiKey?.scopes.includes("admin") ? undefined : req.apiKey?.id;
    const destroyed = ownerId ? await destroySession(sessionId, ownerId) : await destroySession(sessionId);
    res.json({ destroyed });
  } catch (err: any) {
    res.status(mapErrorToStatus(err)).json({ error: err.message });
  }
});

execRouter.get("/", (req, res) => {
  let sessions = getAllSessions();
  if (req.apiKey && !req.apiKey.scopes.includes("admin")) {
    sessions = sessions.filter((s) => !s.ownerId || s.ownerId === req.apiKey?.id);
  }
  res.json({ sessions });
});
