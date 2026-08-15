import { Router } from "express";
import { sendSessionMessage, ensureSession } from "../session/gateway.js";
import { destroySession, getSession, getAllSessions } from "../session/session.js";
import { listTemplates } from "../vm/templates.js";

export const execRouter = Router();

execRouter.get("/templates", (_req, res) => {
  res.json({ templates: listTemplates() });
});

execRouter.post("/:sessionId/execute", async (req, res) => {
  const { sessionId } = req.params;
  const { command, args, cwd, env, timeout, template } = req.body;

  if (!command) return res.status(400).json({ error: "command is required" });

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
    res.status(500).json({ error: err.message });
  }
});


execRouter.post("/:sessionId/write", async (req, res) => {
  const { sessionId } = req.params;
  const { path, content, mode } = req.body;

  if (!path || !content) return res.status(400).json({ error: "path and content required" });

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
    res.status(500).json({ error: err.message });
  }
});

execRouter.get("/:sessionId/read", async (req, res) => {
  const { sessionId } = req.params;
  const { path } = req.query;

  if (!path) return res.status(400).json({ error: "path query param required" });

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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

execRouter.delete("/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const destroyed = await destroySession(sessionId);
  res.json({ destroyed });
});

execRouter.get("/", (req, res) => {
  let sessions = getAllSessions();
  if (req.apiKey && !req.apiKey.scopes.includes("admin")) {
    sessions = sessions.filter((s) => !s.ownerId || s.ownerId === req.apiKey?.id);
  }
  res.json({ sessions });
});
