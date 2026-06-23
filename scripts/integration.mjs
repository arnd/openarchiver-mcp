#!/usr/bin/env node
// End-to-end integration test: bring up a throwaway OpenArchiver stack with docker
// compose, bootstrap it (auto-create admin -> login -> API key -> mbox ingestion
// source), wait for the import + search index to populate, then drive the *built*
// MCP server (dist/index.js) over stdio against that instance and assert that
// search_archive, get_email and get_attachment all work against the real REST API.
//
// Requires Docker + `docker compose` v2. Creates and (in `finally`) destroys the
// stack with `down -v`, so each run starts from zero users — which lets
// ADMIN_EMAIL/ADMIN_PASSWORD auto-create the admin via GET /api/v1/auth/status.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_FILE = join(repoRoot, "test/integration/docker-compose.test.yml");

// Which OpenArchiver image to test against. Default v0.5.0; override via the
// OA_IMAGE_TAG env var or the first CLI arg, e.g.
//   OA_IMAGE_TAG=v0.4.2 npm run test:integration
//   npm run test:integration -- v0.4.2
// Only OSS semver tags (v0.1.1 … v0.5.0) are freely pullable; v1.x exist only as
// `-enterprise` images (license required), e.g. OA_IMAGE_TAG=v1.4.2-enterprise.
const OA_IMAGE_TAG = process.env.OA_IMAGE_TAG || process.argv[2] || "v0.5.0";
// Per-tag compose project keeps containers/volumes isolated between versions.
const PROJECT = `oa-int-${OA_IMAGE_TAG.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
const COMPOSE = ["compose", "-p", PROJECT, "-f", COMPOSE_FILE];

const BASE_URL = "http://localhost:3000";
const API = `${BASE_URL}/api/v1`;
// Must match test/integration/test.env (ADMIN_EMAIL / ADMIN_PASSWORD).
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "integration-test-password";
const NEEDLE = "MCPINTEGRATIONNEEDLE";
const MBOX_PATH = "/fixtures/test.mbox"; // path inside the open-archiver container
const READY_TIMEOUT_MS = 180_000;
const INDEX_TIMEOUT_MS = 180_000;

function dc(args, opts = {}) {
  // OA_IMAGE_TAG is read by docker compose for ${OA_IMAGE_TAG} interpolation in the compose file.
  const env = { ...process.env, OA_IMAGE_TAG, ...opts.env };
  const res = spawnSync("docker", [...COMPOSE, ...args], { stdio: "inherit", ...opts, env });
  if (res.error) throw res.error;
  return res.status ?? 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollUntil(label, timeoutMs, fn) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result !== undefined) return result;
    } catch (err) {
      lastErr = err;
    }
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs} ms` + (lastErr ? `: ${lastErr.message}` : ""));
}

async function bootstrap() {
  // GET /auth/status both reports setup state and (with ADMIN_* env set on a fresh
  // db) auto-creates the admin user. Polling it also serves as our readiness check.
  await pollUntil("OpenArchiver to become ready", READY_TIMEOUT_MS, async () => {
    const res = await fetch(`${API}/auth/status`);
    if (res.ok) return true;
    return undefined;
  });

  const loginRes = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!loginRes.ok) throw new Error(`login failed (${loginRes.status}): ${await loginRes.text()}`);
  const { accessToken } = await loginRes.json();
  assert.ok(accessToken, "login response had no accessToken");
  const bearer = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };

  const keyRes = await fetch(`${API}/api-keys`, {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({ name: "integration-test", expiresInDays: 1 }),
  });
  if (!keyRes.ok) throw new Error(`api-key creation failed (${keyRes.status}): ${await keyRes.text()}`);
  const { key } = await keyRes.json();
  assert.ok(key, "api-key response had no key");

  const sourceRes = await fetch(`${API}/ingestion-sources`, {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({
      name: "integration-mbox",
      provider: "mbox_import",
      providerConfig: { type: "mbox_import", localFilePath: MBOX_PATH },
    }),
  });
  if (!sourceRes.ok) {
    throw new Error(`ingestion source creation failed (${sourceRes.status}): ${await sourceRes.text()}`);
  }
  // Creation runs testConnection() and, on success, flips status to auth_success,
  // which auto-triggers the initial mbox import (no explicit /import call needed).

  // Wait until the imported emails are searchable (import + Meili/Tika indexing is async).
  await pollUntil("emails to be indexed", INDEX_TIMEOUT_MS, async () => {
    const res = await fetch(`${API}/search?keywords=${NEEDLE}&limit=10`, {
      headers: { "X-API-KEY": key },
    });
    if (!res.ok) return undefined;
    const data = await res.json();
    if ((data.total ?? 0) > 0 && (data.hits?.length ?? 0) > 0) return true;
    return undefined;
  });

  return key;
}

function toolText(result) {
  assert.ok(!result.isError, `tool returned an error: ${JSON.stringify(result.content)}`);
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

async function runMcpAssertions(apiKey) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, "dist/index.js")],
    env: {
      ...process.env,
      OPENARCHIVER_BASE_URL: BASE_URL,
      OPENARCHIVER_API_KEY: apiKey,
    },
  });
  const client = new Client({ name: "integration-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    // 1. search_archive finds our needle emails.
    const search = toolText(await client.callTool({ name: "search_archive", arguments: { keywords: NEEDLE } }));
    assert.match(search, new RegExp(NEEDLE), "search_archive output did not contain the needle subject");
    const id = search.match(/^\s*id:\s*(\S+)/m)?.[1];
    assert.ok(id, `could not extract an email id from search_archive output:\n${search}`);
    console.log(`  search_archive ok (found id ${id})`);

    // 2. get_email returns metadata + body for that id.
    const email = toolText(await client.callTool({ name: "get_email", arguments: { id } }));
    assert.match(email, new RegExp(NEEDLE), "get_email output did not contain the needle");

    // 3. get_email on the attachment message, then get_attachment on note.txt.
    //    Find a hit that actually carries the note.txt attachment.
    let storagePath;
    for (const hitId of [...search.matchAll(/^\s*id:\s*(\S+)/gm)].map((m) => m[1])) {
      const detail = toolText(await client.callTool({ name: "get_email", arguments: { id: hitId } }));
      const path = detail.match(/storagePath:\s*(\S+)/)?.[1];
      if (path && path !== "?") {
        storagePath = path;
        break;
      }
    }
    assert.ok(storagePath, "no attachment storagePath found across the needle emails");
    console.log(`  get_email ok (attachment storagePath ${storagePath})`);

    const attachment = toolText(await client.callTool({ name: "get_attachment", arguments: { path: storagePath } }));
    // OpenArchiver's /storage/download always serves application/octet-stream, so the
    // MCP classifies even note.txt as a binary "blob" and returns base64. Accept either
    // the raw text (if a future version sets a text content-type) or the decoded base64.
    const b64 = attachment.split("Base64-encoded content:")[1]?.trim() ?? "";
    const decoded = b64 ? Buffer.from(b64, "base64").toString("utf8") : "";
    assert.ok(
      /ATTACHMENT-NEEDLE-CONTENT/.test(attachment) || /ATTACHMENT-NEEDLE-CONTENT/.test(decoded),
      `get_attachment did not return the note.txt content:\n${attachment.slice(0, 300)}`,
    );
    console.log("  get_attachment ok (note.txt content returned)");

    // 4. Robustness: an unknown id surfaces a clean error, not a crash.
    const missing = await client.callTool({ name: "get_email", arguments: { id: "does-not-exist" } });
    assert.ok(missing.isError, "get_email with an unknown id should return isError");
    console.log("  get_email(unknown id) ok (clean error)");
  } finally {
    await client.close();
  }
}

async function main() {
  // Start from a clean slate in case a previous run left containers/volumes around.
  dc(["down", "-v", "--remove-orphans"]);
  let failed = false;
  try {
    console.log(`Testing against OpenArchiver image tag: ${OA_IMAGE_TAG}`);
    console.log("Starting OpenArchiver test stack…");
    const up = dc(["up", "-d"]);
    assert.equal(up, 0, "docker compose up failed");

    console.log("Bootstrapping (admin → API key → mbox import → index)…");
    const apiKey = await bootstrap();

    console.log("Running MCP assertions against the live instance…");
    await runMcpAssertions(apiKey);

    console.log("\nintegration ok: MCP works end-to-end against OpenArchiver");
  } catch (err) {
    failed = true;
    console.error(`\nintegration FAILED: ${err instanceof Error ? err.stack : err}`);
    console.error("\n--- open-archiver logs ---");
    dc(["logs", "--no-color", "--tail", "200", "open-archiver"]);
  } finally {
    console.log("\nTearing down test stack…");
    dc(["down", "-v", "--remove-orphans"]);
  }
  process.exit(failed ? 1 : 0);
}

main();
