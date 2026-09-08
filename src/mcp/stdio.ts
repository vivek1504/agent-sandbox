import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

// Stdio transport: trusted transport boundary (local process execution).
// Authentication is not required because the caller (IDE, CLI) has already
// authenticated by virtue of spawning this process on the host machine.
// ownerId is undefined — all sessions created via stdio are unowned.
async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
