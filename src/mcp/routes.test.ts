import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./server.js", () => ({
  createMcpServer: vi.fn(() => ({
    connect: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/server/sse.js", () => {
  return {
    SSEServerTransport: vi.fn().mockImplementation((_path: string, _res: any) => ({
      handlePostMessage: vi.fn(async (_req: any, res: any) => {
        res.status(200).json({ ok: true });
      }),
    })),
  };
});

vi.mock("../session/session.js", () => ({
  destroySession: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  touchSession: vi.fn(),
  getAllSessions: vi.fn(() => []),
  startSessionReaper: vi.fn(),
}));

vi.mock("../session/gateway.js", () => ({
  sendSessionMessage: vi.fn(),
  ensureSession: vi.fn(),
}));

vi.mock("../auth/key-store.js", () => ({
  verifyKey: vi.fn((key: string) => {
    if (key === "valid-mcp-key") {
      return {
        id: "key-mcp-1",
        name: "MCP Key",
        scopes: ["exec"],
        rateLimit: 100,
      };
    }
    return null;
  }),
  touchKey: vi.fn(),
}));

import supertest from "supertest";
import { app } from "../app.js";

describe("MCP Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("authentication", () => {
    it("rejects requests without Authorization header with 401", async () => {
      const res = await supertest(app).get("/mcp/");
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("API key required");
    });

    it("rejects requests with wrong Bearer token with 401", async () => {
      const res = await supertest(app)
        .get("/mcp/")
        .set("Authorization", "Bearer wrong-token");
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Invalid API key");
    });

    it("rejects requests with malformed authorization header", async () => {
      const res = await supertest(app)
        .get("/mcp/")
        .set("Authorization", "Basic dXNlcjpwYXNz");
      expect(res.status).toBe(401);
    });

    it("rejects requests using x-api-key header with 401", async () => {
      const res = await supertest(app)
        .get("/mcp/")
        .set("x-api-key", "valid-mcp-key");
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("API key required");
    });

    it("authenticates requests with valid Bearer token", async () => {
      const res = await supertest(app)
        .post("/mcp/messages?mcpSessionId=nonexistent")
        .set("Authorization", "Bearer valid-mcp-key")
        .send({});
      // Authenticated successfully, routed to handler which returns 404 for unknown session
      expect(res.status).toBe(404);
    });
  });

  describe("POST /mcp/messages", () => {
    it("returns 404 when mcpSessionId not found in transports map", async () => {
      const res = await supertest(app)
        .post("/mcp/messages?mcpSessionId=nonexistent")
        .set("Authorization", "Bearer valid-mcp-key")
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });
  });
});

