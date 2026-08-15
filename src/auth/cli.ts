import {
  createKey,
  listKeys,
  revokeKey,
  deleteKey,
  rotateKey,
  type Scope,
} from "./key-store.js";

function printHelp(): void {
  console.log(`
Agent Sandbox Key Management CLI

Usage:
  node dist/auth/cli.js create <name> [--scopes exec,admin,metrics] [--rate-limit 100]
  node dist/auth/cli.js list
  node dist/auth/cli.js revoke <key-id>
  node dist/auth/cli.js rotate <key-id>
  node dist/auth/cli.js delete <key-id>
  `);
}

export function runCli(args: string[]): void {
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "list") {
    const keys = listKeys();
    if (keys.length === 0) {
      console.log("No API keys found.");
      return;
    }
    console.log("\nAPI Keys:");
    console.table(
      keys.map((k) => ({
        ID: k.id,
        Name: k.name,
        Prefix: k.keyPrefix,
        Scopes: k.scopes.join(", "),
        "Rate Limit": k.rateLimit > 0 ? `${k.rateLimit}/min` : "Unlimited",
        Enabled: k.enabled,
        "Created At": new Date(k.createdAt).toISOString(),
        "Last Used": k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : "Never",
      })),
    );
    return;
  }

  if (command === "create") {
    const name = args[1];
    if (!name) {
      console.error("Error: Key name is required.");
      process.exit(1);
    }

    let scopes: Scope[] = ["exec"];
    let rateLimit = 0;

    for (let i = 2; i < args.length; i++) {
      const scopeVal = args[i + 1];
      if (args[i] === "--scopes" && scopeVal) {
        scopes = scopeVal.split(",") as Scope[];
        i++;
      } else if (args[i] === "--rate-limit" && scopeVal) {
        rateLimit = Number(scopeVal) || 0;
        i++;
      }
    }

    const { record, rawKey } = createKey(name, scopes, rateLimit);

    console.log(`\n✓ API key created successfully!`);
    console.log(`  Name:       ${record.name}`);
    console.log(`  Key ID:     ${record.id}`);
    console.log(`  Scopes:     ${record.scopes.join(", ")}`);
    console.log(`  Rate Limit: ${record.rateLimit > 0 ? `${record.rateLimit}/min` : "Unlimited"}`);
    console.log(`\n  API Key:    ${rawKey}`);
    console.log(`\n  ⚠ Save this API key now — it cannot be retrieved later!\n`);
    return;
  }

  if (command === "revoke") {
    const id = args[1];
    if (!id) {
      console.error("Error: Key ID is required.");
      process.exit(1);
    }
    const success = revokeKey(id);
    if (success) {
      console.log(`✓ API key '${id}' revoked.`);
    } else {
      console.error(`Error: API key '${id}' not found.`);
      process.exit(1);
    }
    return;
  }

  if (command === "rotate") {
    const id = args[1];
    if (!id) {
      console.error("Error: Key ID is required.");
      process.exit(1);
    }
    const result = rotateKey(id);
    if (result) {
      console.log(`\n✓ API key '${id}' rotated successfully!`);
      console.log(`  New Key ID: ${result.record.id}`);
      console.log(`  New Key:    ${result.rawKey}\n`);
    } else {
      console.error(`Error: API key '${id}' not found.`);
      process.exit(1);
    }
    return;
  }

  if (command === "delete") {
    const id = args[1];
    if (!id) {
      console.error("Error: Key ID is required.");
      process.exit(1);
    }
    const success = deleteKey(id);
    if (success) {
      console.log(`✓ API key '${id}' deleted.`);
    } else {
      console.error(`Error: API key '${id}' not found.`);
      process.exit(1);
    }
    return;
  }

  printHelp();
}

if (process.argv[1]?.endsWith("cli.js")) {
  runCli(process.argv.slice(2));
}
