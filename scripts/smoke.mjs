#!/usr/bin/env node
// Smoke test: launch the built server over stdio with a real MCP client,
// run the initialize handshake and tools/list, and assert the expected tools.
// Uses dummy credentials only — no OpenArchiver instance or network is required,
// because tools/list never invokes a tool (and therefore never calls fetch).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED = ["search_archive", "get_email", "get_attachment"];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: {
    ...process.env,
    OPENARCHIVER_BASE_URL: "https://example.invalid",
    OPENARCHIVER_API_KEY: "dummy-smoke-key",
  },
});

const client = new Client({ name: "smoke-test", version: "0.0.0" });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const missing = EXPECTED.filter((n) => !names.includes(n));
  if (missing.length > 0) {
    throw new Error(`missing tools: ${missing.join(", ")} (got: ${names.join(", ")})`);
  }
  console.log(`smoke ok: server started and exposes [${names.join(", ")}]`);
} finally {
  await client.close();
}
