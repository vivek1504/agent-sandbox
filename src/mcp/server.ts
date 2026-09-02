import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendSessionMessage } from "../session/gateway.js";
import { destroySession } from "../session/session.js";
import { listTemplates } from "../vm/templates.js";

export function createMcpServer(ownerId?: string): McpServer {
  const server = new McpServer({
    name: "firecracker-sandbox",
    version: "1.0.0",
  });

  server.tool(
    "create_session",
    "Create a new session",
    {
      template: z
        .string()
        .optional()
        .describe("Environment template (e.g., node, python, go)"),
    },
    ({ template }) => {
      const sessionId = crypto.randomUUID();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              sessionId,
              template: template ?? "node",
              status: "active",
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "execute",
    "Execute a command inside an isolated Firecracker microVM. " +
    "The workspace persists across calls within the same sessionId.",
    {
      sessionId: z
        .string()
        .describe("Session identifier for workspace persistence"),
      command: z.string().describe("Command to run: node, python3, bash, etc."),
      args: z.array(z.string()).optional().describe("Command arguments"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory relative to /workspace"),
      timeout: z
        .number()
        .optional()
        .describe("Timeout in milliseconds (default 30000)"),
      template: z
        .string()
        .optional()
        .describe("Environment template (used on first call for a session)"),
    },
    async ({ sessionId, command, args, cwd, timeout, template }) => {
      const parts: string[] = [];

      const result = await sendSessionMessage(
        sessionId,
        { type: "execute", command, args, cwd, timeout },
        (chunk) => {
          parts.push(`[${chunk.stream}] ${chunk.data}`);
        },
        60000,
        template,
        ownerId,
      );

      const exitCode = result.data?.exitCode ?? -1;
      parts.push(`\n--- exit code: ${exitCode} ---`);

      return {
        content: [{ type: "text", text: parts.join("") }],
        isError: exitCode !== 0,
      };
    },
  );

  server.tool(
    "list_templates",
    "List available VM environment templates.",
    {},
    async () => {
      const templates = listTemplates();
      const listing = templates
        .map((t) => `• ${t.name} — ${t.displayName}: ${t.tools.join(", ")}`)
        .join("\n");
      return {
        content: [{ type: "text", text: listing || "(no templates available)" }],
      };
    },
  );



  server.tool(
    "write_file",
    "Write a file to the session workspace.",
    {
      sessionId: z.string(),
      path: z.string().describe("File path relative to /workspace"),
      content: z
        .string()
        .describe("File content (will be base64-encoded automatically)"),
    },
    async ({ sessionId, path, content }) => {
      const encoded = Buffer.from(content).toString("base64");
      const result = await sendSessionMessage(
        sessionId,
        { type: "write_file", path, content: encoded },
        undefined,
        60000,
        undefined,
        ownerId,
      );
      return {
        content: [
          {
            type: "text",
            text: `Wrote ${result.data?.bytesWritten} bytes to ${path}`,
          },
        ],
      };
    },
  );

  server.tool(
    "read_file",
    "Read a file from the session workspace.",
    {
      sessionId: z.string(),
      path: z.string().describe("File path relative to /workspace"),
    },
    async ({ sessionId, path }) => {
      const result = await sendSessionMessage(
        sessionId,
        { type: "read_file", path },
        undefined,
        60000,
        undefined,
        ownerId,
      );
      const content = Buffer.from(
        result.data?.content || "",
        "base64",
      ).toString("utf-8");
      return {
        content: [{ type: "text", text: content }],
      };
    },
  );

  server.tool(
    "list_files",
    "List files in the session workspace.",
    {
      sessionId: z.string(),
      path: z
        .string()
        .optional()
        .describe("Directory path relative to /workspace"),
      recursive: z.boolean().optional().describe("List recursively"),
    },
    async ({ sessionId, path, recursive }) => {
      const result = await sendSessionMessage(
        sessionId,
        { type: "list_files", path, recursive },
        undefined,
        60000,
        undefined,
        ownerId,
      );
      const listing = (result.data?.files || [])
        .map(
          (f: any) =>
            `${f.type === "dir" ? "📁" : "📄"} ${f.path} (${f.size}b)`,
        )
        .join("\n");
      return {
        content: [{ type: "text", text: listing || "(empty)" }],
      };
    },
  );

  server.tool(
    "ping",
    "Ping",
    {},
    async () => ({
      content: [
        {
          type: "text",
          text: "pong"
        }
      ]
    })
  );

  server.tool(
    "reset_session",
    "Destroy a session and its VM. The workspace is lost.",
    { sessionId: z.string() },
    async ({ sessionId }) => {
      try {
        const destroyed = ownerId ? await destroySession(sessionId, ownerId) : await destroySession(sessionId);
        return {
          content: [
            {
              type: "text",
              text: destroyed ? "Session destroyed." : "No active session found.",
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to destroy session: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

