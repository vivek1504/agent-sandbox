import { Router } from "express";
import { z } from "zod";
import { sendSessionMessage, ensureSession } from "../session/gateway.js";
import { destroySession, getSession, getAllSessions } from "../session/session.js";
import { listTemplates } from "../vm/templates.js";

export const execRouter = Router();

const executeSchema = z.object({
  command: z.string().min(1, "command is required and must be a string").max(4096),
  args: z.array(z.string().max(4096)).max(100).optional(),
  cwd: z.string().max(512).optional(),
  env: z
    .record(z.string().max(8192))
    .optional()
    .refine((e) => !e || Object.keys(e).length <= 64, "Too many environment variables"),
  timeout: z.number().int().min(1).max(300_000).optional(),
  template: z.string().max(64).optional(),
});

const writeFileSchema = z.object({
  path: z.string().min(1, "path and content required and must be strings").max(1024),
  content: z.string().max(10_485_760),
  mode: z.number().int().optional(),
});

const readFileSchema = z.object({
  path: z.string().min(1, "path query param required and must be a string").max(1024),
});

const listFilesSchema = z.object({
  path: z.string().max(1024).optional(),
  recursive: z.enum(["true", "false"]).optional(),
});

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
  const parsed = executeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.issues[0]?.message || "command is required and must be a string",
      details: parsed.error.issues,
      code: "BAD_REQUEST",
    });
  }
  const { command, args, cwd, env, timeout, template } = parsed.data;

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
  const parsed = writeFileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.issues[0]?.message || "path and content required and must be strings",
      details: parsed.error.issues,
      code: "BAD_REQUEST",
    });
  }
  const { path, content, mode } = parsed.data;

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
  const parsed = readFileSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.issues[0]?.message || "path query param required and must be a string",
      details: parsed.error.issues,
      code: "BAD_REQUEST",
    });
  }
  const { path } = parsed.data;

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
  const parsed = listFilesSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.issues[0]?.message || "invalid query parameters",
      details: parsed.error.issues,
      code: "BAD_REQUEST",
    });
  }
  const { path, recursive } = parsed.data;

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
