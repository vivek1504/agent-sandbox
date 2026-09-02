import { Router } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer } from "./server.js";

export const mcpRouter = Router();

interface OwnedTransport {
  transport: SSEServerTransport;
  ownerId?: string | undefined;
}

const transports = new Map<string, OwnedTransport>();

mcpRouter.get("/", async (req, res) => {
  const mcpSessionId = req.id as string;
  const ownerId = req.apiKey?.id;

  const transport = new SSEServerTransport(`/mcp/messages?mcpSessionId=${mcpSessionId}`, res);
  transports.set(mcpSessionId, { transport, ownerId });

  const server = createMcpServer(ownerId);
  await server.connect(transport);

  req.on("close", () => {
    transports.delete(mcpSessionId);
    server.close().catch(console.error);
  });
});

mcpRouter.post("/messages", async (req, res) => {
  const mcpSessionId = req.query.mcpSessionId as string;
  const entry = transports.get(mcpSessionId);

  if (!entry) {
    res.status(404).json({ error: "Session not found or disconnected" });
    return;
  }

  if (entry.ownerId && req.apiKey?.id && entry.ownerId !== req.apiKey.id) {
    res.status(403).json({ error: "Session belongs to another user" });
    return;
  }

  await entry.transport.handlePostMessage(req, res);
});

