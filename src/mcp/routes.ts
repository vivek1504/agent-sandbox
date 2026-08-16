import { Router } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer } from "./server.js";

export const mcpRouter = Router();

const transports = new Map<string, SSEServerTransport>();

mcpRouter.get("/", async (req, res) => {
  const mcpSessionId = req.id as string;
  const ownerId = req.apiKey?.id;

  const transport = new SSEServerTransport(`/mcp/messages?mcpSessionId=${mcpSessionId}`, res);
  transports.set(mcpSessionId, transport);

  const server = createMcpServer(ownerId);
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

