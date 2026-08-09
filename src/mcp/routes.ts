import { Router } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer } from "./server.js";

export const mcpRouter = Router();

mcpRouter.use((req, res, next) => {
  const authToken = process.env.MCP_AUTH_TOKEN;

  if (!authToken) {
    res.status(503).json({ error: "MCP_AUTH_TOKEN not configured" });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${authToken}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
});

const transports = new Map<string, SSEServerTransport>();

mcpRouter.get("/", async (req, res) => {
  const mcpSessionId = req.id as string;

  const transport = new SSEServerTransport(`/mcp/messages?mcpSessionId=${mcpSessionId}`, res);
  transports.set(mcpSessionId, transport);

  const server = createMcpServer();
  await server.connect(transport);

  req.on("close", () => {
    transports.delete(mcpSessionId);
    server.close().catch(console.error);
  });
});

mcpRouter.post("/messages", async (req, res) => {
  const mcpSessionId = req.query.mcpSessionId as string;
  const transport = transports.get(mcpSessionId);

  if (!transport) {
    res.status(404).json({ error: "Session not found or disconnected" });
    return;
  }

  await transport.handlePostMessage(req, res);
});
