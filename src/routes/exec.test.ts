import { describe, it, expect, vi, beforeEach } from "vitest";
import supertest from "supertest";

vi.mock("../session/gateway.js", () => ({
  sendSessionMessage: vi.fn(),
  ensureSession: vi.fn(),
}));

vi.mock("../session/session.js", () => ({
  destroySession: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  touchSession: vi.fn(),
  getAllSessions: vi.fn(() => [
    { sessionId: "s1", ownerId: "key-1", state: "active" },
    { sessionId: "s2", ownerId: "key-2", state: "active" },
  ]),
  startSessionReaper: vi.fn(),
}));

import { app } from "../app.js";
import { sendSessionMessage } from "../session/gateway.js";
import { destroySession } from "../session/session.js";
import { createKey } from "../auth/key-store.js";

describe("Exec Routes", () => {
  let apiKey: string;
  let adminKey: string;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_ENABLED = "true";
    const userRes = createKey("test-user", ["exec"]);
    apiKey = userRes.rawKey;
    const adminRes = createKey("test-admin", ["exec", "admin", "metrics"]);
    adminKey = adminRes.rawKey;
  });

  describe("GET /exec/templates", () => {
    it("returns list of available templates", async () => {
      const res = await supertest(app)
        .get("/exec/templates")
        .set("Authorization", `Bearer ${apiKey}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("templates");
      expect(Array.isArray(res.body.templates)).toBe(true);
    });
  });

  describe("POST /exec/:sessionId/execute", () => {
    it("rejects request without command with 400", async () => {
      const res = await supertest(app)
        .post("/exec/test-session/execute")
        .set("Authorization", `Bearer ${apiKey}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("BAD_REQUEST");
    });

    it("executes command and returns JSON result", async () => {
      vi.mocked(sendSessionMessage).mockResolvedValue({
        data: { exitCode: 0, signal: undefined, duration: 42 },
      });

      const res = await supertest(app)
        .post("/exec/test-session/execute")
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ command: "echo", args: ["hello"] });

      expect(res.status).toBe(200);
      expect(res.body.exitCode).toBe(0);
      expect(res.body.duration).toBe(42);
      expect(sendSessionMessage).toHaveBeenCalled();
    });

    it("handles execution timeout with 504 status", async () => {
      vi.mocked(sendSessionMessage).mockRejectedValue(new Error("Function timeout"));

      const res = await supertest(app)
        .post("/exec/test-session/execute")
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ command: "sleep", args: ["100"] });

      expect(res.status).toBe(504);
      expect(res.body.code).toBe("GATEWAY_TIMEOUT");
    });
  });

  describe("POST /exec/:sessionId/write and GET /exec/:sessionId/read", () => {
    it("rejects write with missing path or content with 400", async () => {
      const res = await supertest(app)
        .post("/exec/test-session/write")
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ path: "test.txt" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("BAD_REQUEST");
    });

    it("writes file successfully", async () => {
      vi.mocked(sendSessionMessage).mockResolvedValue({
        data: { bytesWritten: 12 },
      });

      const res = await supertest(app)
        .post("/exec/test-session/write")
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ path: "hello.txt", content: "hello world\n" });

      expect(res.status).toBe(200);
      expect(res.body.bytesWritten).toBe(12);
    });

    it("reads file and decodes base64 content", async () => {
      const base64Content = Buffer.from("test file content").toString("base64");
      vi.mocked(sendSessionMessage).mockResolvedValue({
        data: { content: base64Content, size: 17 },
      });

      const res = await supertest(app)
        .get("/exec/test-session/read?path=hello.txt")
        .set("Authorization", `Bearer ${apiKey}`);

      expect(res.status).toBe(200);
      expect(res.body.content).toBe("test file content");
    });
  });

  describe("GET /exec/:sessionId/files", () => {
    it("returns directory listings", async () => {
      vi.mocked(sendSessionMessage).mockResolvedValue({
        data: {
          files: [{ path: "app.js", type: "file", size: 100 }],
        },
      });

      const res = await supertest(app)
        .get("/exec/test-session/files?recursive=true")
        .set("Authorization", `Bearer ${apiKey}`);

      expect(res.status).toBe(200);
      expect(res.body.files).toHaveLength(1);
    });
  });

  describe("DELETE /exec/:sessionId", () => {
    it("destroys session and returns status", async () => {
      vi.mocked(destroySession).mockResolvedValue(true);

      const res = await supertest(app)
        .delete("/exec/test-session")
        .set("Authorization", `Bearer ${apiKey}`);

      expect(res.status).toBe(200);
      expect(res.body.destroyed).toBe(true);
      expect(destroySession).toHaveBeenCalledWith("test-session", expect.any(String));
    });
  });

  describe("GET /exec/ (session listing)", () => {
    it("filters sessions by owner for non-admin keys", async () => {
      const res = await supertest(app)
        .get("/exec/")
        .set("Authorization", `Bearer ${apiKey}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
    });

    it("returns all sessions for admin keys", async () => {
      const res = await supertest(app)
        .get("/exec/")
        .set("Authorization", `Bearer ${adminKey}`);

      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(2);
    });
  });
});
