#!/usr/bin/env node
// Smoke test: launch the built server over stdio with a real MCP client,
// run the initialize handshake and tools/list, and assert the expected tools.
// Runs deliberately WITHOUT credentials (no OPENARCHIVER_BASE_URL/API_KEY): the
// server must still start and list its tools, because tools/list never invokes a
// tool (and therefore never calls fetch). This guards the regression where eager
// config validation crashed the server before the handshake, so MCP directory
// validators saw zero tools ("does not provide at least one skill").
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED = ["search_archive", "get_email", "get_attachment"];

// Strip any inherited credentials so we truly exercise the no-config startup path.
const env = { ...process.env };
delete env.OPENARCHIVER_BASE_URL;
delete env.OPENARCHIVER_API_KEY;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env,
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
