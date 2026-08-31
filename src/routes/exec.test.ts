import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../session/gateway.js", () => ({
  sendSessionMessage: vi.fn(),
  ensureSession: vi.fn(),
}));

vi.mock("../session/session.js", () => ({
  destroySession: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  touchSession: vi.fn(),
  getAllSessions: vi.fn(() => []),
  startSessionReaper: vi.fn(),
}));

import supertest from "supertest";
import { app } from "../app.js";
import { sendSessionMessage } from "../session/gateway.js";
import { destroySession, getAllSessions } from "../session/session.js";

describe("Exec REST Routes (/exec/*)", () => {
  const originalAuth = process.env.AUTH_ENABLED;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_ENABLED = "false";
  });

  afterEach(() => {
    if (originalAuth !== undefined) {
      process.env.AUTH_ENABLED = originalAuth;
    } else {
      delete process.env.AUTH_ENABLED;
    }
  });

  describe("GET /exec/templates", () => {
    it("returns list of registered templates", async () => {
      const res = await supertest(app).get("/exec/templates");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("templates");
      expect(Array.isArray(res.body.templates)).toBe(true);
    });
  });

  describe("POST /exec/:sessionId/execute", () => {
    it("rejects invalid sessionId format with 400", async () => {
      const res = await supertest(app)
        .post("/exec/bad;session$id/execute")
        .send({ command: "echo" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid sessionId");
    });

    it("rejects missing or empty command with 400", async () => {
      const res = await supertest(app)
        .post("/exec/valid-session/execute")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("command is required");
    });

    it("rejects invalid args type with 400", async () => {
      const res = await supertest(app)
        .post("/exec/valid-session/execute")
        .send({ command: "echo", args: "not-an-array" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("args must be an array of strings");
    });

    it("rejects invalid cwd type with 400", async () => {
      const res = await supertest(app)
        .post("/exec/valid-session/execute")
        .send({ command: "echo", cwd: 12345 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("cwd must be a string");
    });

    it("rejects invalid timeout with 400", async () => {
      const res = await supertest(app)
        .post("/exec/valid-session/execute")
        .send({ command: "echo", timeout: -500 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("timeout must be a positive number");
    });

    it("executes command and returns buffered output", async () => {
      vi.mocked(sendSessionMessage).mockImplementation(
        async (_sid, _msg, onStream) => {
          onStream?.({ stream: "stdout", data: "hello world\n" });
          return {
            type: "response",
            data: { exitCode: 0, signal: undefined, duration: 42 },
          };
        },
      );

      const res = await supertest(app)
        .post("/exec/sess-1/execute")
        .send({ command: "echo", args: ["hello world"] });

      expect(res.status).toBe(200);
      expect(res.body.exitCode).toBe(0);
      expect(res.body.output).toHaveLength(1);
      expect(res.body.output[0].data).toBe("hello world\n");
    });

    it("streams NDJSON when requested via Accept header", async () => {
      vi.mocked(sendSessionMessage).mockImplementation(
        async (_sid, _msg, onStream) => {
          onStream?.({ stream: "stdout", data: "chunk1" });
          return {
            type: "response",
            data: { exitCode: 0 },
          };
        },
      );

      const res = await supertest(app)
        .post("/exec/sess-2/execute")
        .set("Accept", "application/x-ndjson")
        .send({ command: "echo" });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/x-ndjson");
      expect(res.text).toContain('"type":"stream"');
      expect(res.text).toContain('"type":"result"');
    });

    it("maps path traversal errors from gateway to 400", async () => {
      vi.mocked(sendSessionMessage).mockRejectedValue(
        new Error("Path traversal detected"),
      );

      const res = await supertest(app)
        .post("/exec/sess-1/execute")
        .send({ command: "cat", cwd: "../../etc" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Path traversal detected");
    });

    it("maps timeout errors to 504", async () => {
      vi.mocked(sendSessionMessage).mockRejectedValue(
        new Error("Function timeout"),
      );

      const res = await supertest(app)
        .post("/exec/sess-1/execute")
        .send({ command: "sleep", args: ["100"] });

      expect(res.status).toBe(504);
      expect(res.body.error).toContain("timeout");
    });
  });

  describe("POST /exec/:sessionId/write", () => {
    it("validates path and content", async () => {
      const res = await supertest(app)
        .post("/exec/sess-1/write")
        .send({ path: "test.txt" }); // missing content

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("path and content must be strings");
    });

    it("writes base64 encoded content to session gateway", async () => {
      vi.mocked(sendSessionMessage).mockResolvedValue({
        type: "response",
        data: { bytesWritten: 12 },
      });

      const res = await supertest(app)
        .post("/exec/sess-1/write")
        .send({ path: "file.txt", content: "hello world\n" });

      expect(res.status).toBe(200);
      expect(res.body.bytesWritten).toBe(12);

      const call = vi.mocked(sendSessionMessage).mock.calls[0]!;
      expect((call[1] as any).content).toBe(Buffer.from("hello world\n").toString("base64"));
    });
  });

  describe("GET /exec/:sessionId/read", () => {
    it("requires path query parameter", async () => {
      const res = await supertest(app).get("/exec/sess-1/read");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("path query param required");
    });

    it("reads and decodes file content from base64", async () => {
      vi.mocked(sendSessionMessage).mockResolvedValue({
        type: "response",
        data: {
          content: Buffer.from("contents of file").toString("base64"),
          size: 16,
        },
      });

      const res = await supertest(app).get("/exec/sess-1/read?path=file.txt");
      expect(res.status).toBe(200);
      expect(res.body.content).toBe("contents of file");
    });
  });

  describe("GET /exec/:sessionId/files", () => {
    it("lists files in session workspace", async () => {
      vi.mocked(sendSessionMessage).mockResolvedValue({
        type: "response",
        data: {
          files: [{ path: "app.js", type: "file", size: 100 }],
        },
      });

      const res = await supertest(app).get("/exec/sess-1/files");
      expect(res.status).toBe(200);
      expect(res.body.files).toHaveLength(1);
    });
  });

  describe("DELETE /exec/:sessionId", () => {
    it("destroys session and returns status", async () => {
      vi.mocked(destroySession).mockResolvedValue(true);

      const res = await supertest(app).delete("/exec/sess-1");
      expect(res.status).toBe(200);
      expect(res.body.destroyed).toBe(true);
      expect(destroySession).toHaveBeenCalledWith("sess-1");
    });
  });

  describe("GET /exec/", () => {
    it("lists all active sessions", async () => {
      vi.mocked(getAllSessions).mockReturnValue([
        {
          sessionId: "sess-1",
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          state: "active",
        },
      ]);

      const res = await supertest(app).get("/exec/");
      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(1);
    });
  });

  describe("Security & Error Middleware", () => {
    it("rejects unauthenticated requests with 401 when AUTH_ENABLED is true", async () => {
      process.env.AUTH_ENABLED = "true";
      const res = await supertest(app).get("/exec/templates");
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("API key required");
    });

    it("rejects malformed JSON payload with 400", async () => {
      const res = await supertest(app)
        .post("/exec/sess-1/execute")
        .set("Content-Type", "application/json")
        .send("{ bad json ");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Malformed JSON payload");
    });
  });
});
