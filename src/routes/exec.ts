import { Router } from "express";
import { sendSessionMessage, ensureSession } from "../session/gateway.js";
import { destroySession, getSession, getAllSessions } from "../session/session.js";
import { listTemplates } from "../vm/templates.js";

export const execRouter = Router();

execRouter.get("/templates", (_req, res) => {
  res.json({ templates: listTemplates() });
});

function handleRouteError(res: any, err: any) {
  const msg = err?.message || "Internal server error";
  if (msg.includes("timeout") || msg.includes("Timeout")) {
    return res.status(504).json({ error: msg, code: "GATEWAY_TIMEOUT" });
  }
  if (msg.includes("traversal") || msg.includes("required") || msg.includes("invalid") || msg.includes("Unknown template")) {
    return res.status(400).json({ error: msg, code: "BAD_REQUEST" });
  }
  return res.status(500).json({ error: msg, code: "INTERNAL_ERROR" });
}

execRouter.post("/:sessionId/execute", async (req, res) => {
  const { sessionId } = req.params;
  const { command, args, cwd, env, timeout, template } = req.body;

  if (!command || typeof command !== "string") {
    return res.status(400).json({ error: "command is required and must be a string", code: "BAD_REQUEST" });
  }

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
        { type: "execute", command, args, cwd, env, timeout },
        (chunk) => {
          res.write(JSON.stringify({ type: "stream", ...chunk, ts: Date.now() }) + "\n");
        },
        60000,
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
      { type: "execute", command, args, cwd, env, timeout },
      (chunk) => {
        output.push({ stream: chunk.stream, data: chunk.data, ts: Date.now() });
      },
      60000,
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
    handleRouteError(res, err);
  }
});

execRouter.post("/:sessionId/write", async (req, res) => {
  const { sessionId } = req.params;
  const { path, content, mode } = req.body;

  if (!path || typeof path !== "string" || content === undefined || typeof content !== "string") {
    return res.status(400).json({ error: "path and content required and must be strings", code: "BAD_REQUEST" });
  }

  try {
    const contentBase64 = Buffer.from(content, "utf8").toString("base64");
    const result = await sendSessionMessage(
      sessionId,
      { type: "write_file", path, content: contentBase64, mode },
      undefined,
      60000,
      undefined,
      req.apiKey?.id,
    );
    res.json(result.data);
  } catch (err: any) {
    handleRouteError(res, err);
  }
});

execRouter.get("/:sessionId/read", async (req, res) => {
  const { sessionId } = req.params;
  const { path } = req.query;

  if (!path || typeof path !== "string") {
    return res.status(400).json({ error: "path query param required and must be a string", code: "BAD_REQUEST" });
  }

  try {
    const result = await sendSessionMessage(
      sessionId,
      { type: "read_file", path },
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
    handleRouteError(res, err);
  }
});

execRouter.get("/:sessionId/files", async (req, res) => {
  const { sessionId } = req.params;
  const { path, recursive } = req.query;

  try {
    const result = await sendSessionMessage(
      sessionId,
      { type: "list_files", path, recursive: recursive === "true" },
      undefined,
      60000,
      undefined,
      req.apiKey?.id,
    );
    res.json(result.data);
  } catch (err: any) {
    handleRouteError(res, err);
  }
});

execRouter.delete("/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const ownerId = req.apiKey?.scopes.includes("admin") ? undefined : req.apiKey?.id;
  try {
    const destroyed = await destroySession(sessionId, ownerId);
    res.json({ destroyed });
  } catch (err: any) {
    handleRouteError(res, err);
  }
});

execRouter.get("/", (req, res) => {
  let sessions = getAllSessions();
  if (req.apiKey && !req.apiKey.scopes.includes("admin")) {
    sessions = sessions.filter((s) => !s.ownerId || s.ownerId === req.apiKey?.id);
  }
  res.json({ sessions });
});
