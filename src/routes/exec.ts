import { Router } from "express";
import { sendSessionMessage, ensureSession } from "../session/gateway.js";
import { destroySession, getSession, getAllSessions } from "../session/session.js";

export const execRouter = Router();

execRouter.post("/:sessionId/execute", async (req, res) => {
  const { sessionId } = req.params;
  const { command, args, cwd, env, timeout } = req.body;

  if (!command) return res.status(400).json({ error: "command is required" });

  const output: { stream: string; data: string; ts: number }[] = [];

  try {
    const result = await sendSessionMessage(
      sessionId,
      { type: "execute", command, args, cwd, env, timeout },
      (chunk) => {
        output.push({ stream: chunk.stream, data: chunk.data, ts: Date.now() });
      },
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
    const result = await sendSessionMessage(sessionId, {
      type: "write_file", path, content, mode,
    });
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
    const result = await sendSessionMessage(sessionId, {
      type: "read_file", path,
    });
    res.json(result.data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

execRouter.get("/:sessionId/files", async (req, res) => {
  const { sessionId } = req.params;
  const { path, recursive } = req.query;

  try {
    const result = await sendSessionMessage(sessionId, {
      type: "list_files", path, recursive: recursive === "true",
    });
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

execRouter.get("/", (_req, res) => {
  res.json({ sessions: getAllSessions() });
});
