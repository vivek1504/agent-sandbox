import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import supertest from "supertest";
import { app } from "../app.js";

describe("MCP Routes", () => {
  const savedEnv = process.env.MCP_AUTH_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MCP_AUTH_TOKEN = "test-secret-123";
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.MCP_AUTH_TOKEN = savedEnv;
    } else {
      delete process.env.MCP_AUTH_TOKEN;
    }
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

    it("uses MCP_AUTH_TOKEN env var for validation", async () => {
      process.env.MCP_AUTH_TOKEN = "custom-secret";

      const resFail = await supertest(app)
        .get("/mcp/")
        .set("Authorization", "Bearer test-secret-123");
      expect(resFail.status).toBe(401);
      const resPass = await supertest(app)
        .post("/mcp/messages?mcpSessionId=test")
        .set("Authorization", "Bearer custom-secret")
        .send({});
      expect(resPass.status).not.toBe(401);
    });
  });


  describe("POST /mcp/messages", () => {
    it("returns 404 when mcpSessionId not found in transports map", async () => {
      const res = await supertest(app)
        .post("/mcp/messages?mcpSessionId=nonexistent")
        .set("Authorization", "Bearer test-secret-123")
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });
  });
});
