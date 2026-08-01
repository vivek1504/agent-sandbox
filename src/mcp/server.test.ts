import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../exec/gateway.js", () => ({
  sendSessionMessage: vi.fn(),
}));

vi.mock("../exec/session.js", () => ({
  destroySession: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  touchSession: vi.fn(),
  startSessionReaper: vi.fn(),
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./server.js";
import { sendSessionMessage } from "../exec/gateway.js";
import { destroySession } from "../exec/session.js";

async function createTestClient() {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: any): string {
  return result.content?.find((c: any) => c.type === "text")?.text ?? "";
}

function mockSendSession(response: any, streamChunks?: any[]) {
  return vi.fn(async (_sessionId: string, _message: any, onStream?: (chunk: any) => void) => {
    for (const chunk of streamChunks || []) {
      onStream?.(chunk);
    }
    return response;
  });
}


describe("MCP Server Tools", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const ctx = await createTestClient();
    client = ctx.client;
    cleanup = ctx.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });


  describe("listTools", () => {
    it("lists all 5 tools with correct names", async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "execute",
        "list_files",
        "read_file",
        "reset_session",
        "write_file",
      ]);
    });

    it("every tool has a description and inputSchema", async () => {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
      }
    });

    it("execute tool schema requires sessionId and command", async () => {
      const { tools } = await client.listTools();
      const execute = tools.find((t) => t.name === "execute")!;
      expect(execute.inputSchema.required).toContain("sessionId");
      expect(execute.inputSchema.required).toContain("command");
    });
  });

  describe("execute", () => {
    it("calls sendSessionMessage with correct payload and returns formatted output", async () => {
      vi.mocked(sendSessionMessage).mockImplementation(
        mockSendSession(
          { type: "response", data: { exitCode: 0, duration: 150 } },
          [{ stream: "stdout", data: "hello\n" }],
        ),
      );

      const result = await client.callTool({
        name: "execute",
        arguments: {
          sessionId: "s1",
          command: "echo",
          args: ["hello"],
        },
      });

      expect(sendSessionMessage).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({
          type: "execute",
          command: "echo",
          args: ["hello"],
        }),
        expect.any(Function),
      );

      const text = textOf(result);
      expect(text).toContain("[stdout] hello\n");
      expect(text).toContain("exit code: 0");
      expect(result.isError).toBe(false);
    });

    it("returns isError=true for non-zero exit code", async () => {
      vi.mocked(sendSessionMessage).mockImplementation(
        mockSendSession({ type: "response", data: { exitCode: 1 } }),
      );

      const result = await client.callTool({
        name: "execute",
        arguments: { sessionId: "s1", command: "false" },
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("exit code: 1");
    });

    it("includes stderr stream in output", async () => {
      vi.mocked(sendSessionMessage).mockImplementation(
        mockSendSession(
          { type: "response", data: { exitCode: 0 } },
          [
            { stream: "stdout", data: "out\n" },
            { stream: "stderr", data: "err\n" },
          ],
        ),
      );

      const result = await client.callTool({
        name: "execute",
        arguments: { sessionId: "s1", command: "sh" },
      });

      const text = textOf(result);
      expect(text).toContain("[stdout] out\n");
      expect(text).toContain("[stderr] err\n");
    });

    it("passes optional cwd and timeout to gateway", async () => {
      vi.mocked(sendSessionMessage).mockImplementation(
        mockSendSession({ type: "response", data: { exitCode: 0 } }),
      );

      await client.callTool({
        name: "execute",
        arguments: {
          sessionId: "s1",
          command: "ls",
          cwd: "subdir",
          timeout: 5000,
        },
      });

      expect(sendSessionMessage).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ cwd: "subdir", timeout: 5000 }),
        expect.any(Function),
      );
    });

    it("handles missing exitCode gracefully", async () => {
      vi.mocked(sendSessionMessage).mockImplementation(
        mockSendSession({ type: "response", data: {} }),
      );

      const result = await client.callTool({
        name: "execute",
        arguments: { sessionId: "s1", command: "echo" },
      });

      expect(textOf(result)).toContain("exit code: -1");
      expect(result.isError).toBe(true);
    });
  });


  describe("write_file", () => {
    it("base64-encodes content and sends write_file message", async () => {
      vi.mocked(sendSessionMessage).mockImplementation(
        mockSendSession({ type: "response", data: { bytesWritten: 12 } }),
      );

      const result = await client.callTool({
        name: "write_file",
        arguments: {
          sessionId: "s1",
          path: "test.js",
          content: "hello world\n",
        },
      });

      const call = vi.mocked(sendSessionMessage).mock.calls[0]!;
      expect(call[0]).toBe("s1");

      const message = call[1] as Record<string, any>;
      expect(message.type).toBe("write_file");
      expect(message.path).toBe("test.js");

      const decoded = Buffer.from(message.content, "base64").toString("utf-8");
      expect(decoded).toBe("hello world\n");

      expect(textOf(result)).toBe("Wrote 12 bytes to test.js");
    });

    it("handles unicode content encoding", async () => {
      vi.mocked(sendSessionMessage).mockImplementation(
        mockSendSession({ type: "response", data: { bytesWritten: 15 } }),
      );

      await client.callTool({
        name: "write_file",
        arguments: {
          sessionId: "s1",
          path: "emoji.txt",
          content: "hello 🌍",
        },
      });

      const message = vi.mocked(sendSessionMessage).mock.calls[0]![1] as Record<string, any>;
      const decoded = Buffer.from(message.content, "base64").toString("utf-8");
      expect(decoded).toBe("hello 🌍");
    });
  });

  describe("read_file", () => {
    it("decodes base64 response into plaintext", async () => {
      const content = Buffer.from("console.log('hi')").toString("base64");
      vi.mocked(sendSessionMessage).mockImplementation(
        mockSendSession({ type: "response", data: { content, size: 17 } }),
      );

      const result = await client.callTool({
        name: "read_file",
        arguments: { sessionId: "s1", path: "test.js" },
      });

      expect(textOf(result)).toBe("console.log('hi')");
    });

    it("returns empty string for missing content", async () => {
      vi.mocked(sendSessionMessage).mockImplementation(
        mockSendSession({ type: "response", data: { content: "" } }),
      );

      const result = await client.callTool({
        name: "read_file",
        arguments: { sessionId: "s1", path: "empty.txt" },
      });

      expect(textOf(result)).toBe("");
    });

    it("sends read_file message with correct path", async () => {
      vi.mocked(sendSessionMessage).mockImplementation(
        mockSendSession({ type: "response", data: { content: "" } }),
      );

      await client.callTool({
        name: "read_file",
        arguments: { sessionId: "s1", path: "deep/nested/file.js" },
      });

      expect(sendSessionMessage).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ type: "read_file", path: "deep/nested/file.js" }),
      );
    });
  });

  describe("list_files", () => {
    it("formats file listing with emoji indicators", async () => {
      vi.mocked(sendSessionMessage).mockImplementation(
        mockSendSession({
          type: "response",
          data: {
            files: [
              { path: "src", type: "dir", size: 0 },
              { path: "index.js", type: "file", size: 128 },
            ],
          },
        }),
      );

      const result = await client.callTool({
        name: "list_files",
        arguments: { sessionId: "s1" },
      });

      const text = textOf(result);
      expect(text).toContain("📁 src (0b)");
      expect(text).toContain("📄 index.js (128b)");
    });

    it("returns '(empty)' for empty directory", async () => {
      vi.mocked(sendSessionMessage).mockImplementation(
        mockSendSession({ type: "response", data: { files: [] } }),
      );

      const result = await client.callTool({
        name: "list_files",
        arguments: { sessionId: "s1" },
      });

      expect(textOf(result)).toBe("(empty)");
    });

    it("passes recursive flag to gateway", async () => {
      vi.mocked(sendSessionMessage).mockImplementation(
        mockSendSession({ type: "response", data: { files: [] } }),
      );

      await client.callTool({
        name: "list_files",
        arguments: { sessionId: "s1", path: "src", recursive: true },
      });

      expect(sendSessionMessage).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ type: "list_files", path: "src", recursive: true }),
      );
    });
  });

  describe("reset_session", () => {
    it("calls destroySession and reports success", async () => {
      vi.mocked(destroySession).mockResolvedValue(true);

      const result = await client.callTool({
        name: "reset_session",
        arguments: { sessionId: "s1" },
      });

      expect(destroySession).toHaveBeenCalledWith("s1");
      expect(textOf(result)).toBe("Session destroyed.");
    });

    it("reports when session not found", async () => {
      vi.mocked(destroySession).mockResolvedValue(false);

      const result = await client.callTool({
        name: "reset_session",
        arguments: { sessionId: "nonexistent" },
      });

      expect(textOf(result)).toBe("No active session found.");
    });
  });
});
