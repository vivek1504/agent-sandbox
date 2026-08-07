import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
