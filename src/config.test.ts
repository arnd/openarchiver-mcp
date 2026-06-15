import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig, normalizeApiBase } from "./config.js";

describe("normalizeApiBase", () => {
  it("appends /api/v1 to a bare host", () => {
    assert.equal(normalizeApiBase("https://host.example.com"), "https://host.example.com/api/v1");
  });

  it("strips trailing slashes before appending", () => {
    assert.equal(normalizeApiBase("https://host.example.com///"), "https://host.example.com/api/v1");
  });

  it("leaves an existing /api/v1 suffix untouched", () => {
    assert.equal(normalizeApiBase("https://host.example.com/api/v1"), "https://host.example.com/api/v1");
  });

  it("accepts other api versions", () => {
    assert.equal(normalizeApiBase("https://host.example.com/api/v2/"), "https://host.example.com/api/v2");
  });

  it("throws on an empty value", () => {
    assert.throws(() => normalizeApiBase("   "), /empty/);
  });
});

describe("loadConfig", () => {
  it("returns a config when both env vars are present", () => {
    const config = loadConfig({
      OPENARCHIVER_BASE_URL: "https://host.example.com/",
      OPENARCHIVER_API_KEY: "secret",
    } as NodeJS.ProcessEnv);
    assert.deepEqual(config, {
      apiBase: "https://host.example.com/api/v1",
      apiKey: "secret",
      timeoutMs: 30_000,
    });
  });

  it("honours a custom timeout", () => {
    const config = loadConfig({
      OPENARCHIVER_BASE_URL: "https://host.example.com",
      OPENARCHIVER_API_KEY: "secret",
      OPENARCHIVER_TIMEOUT_MS: "5000",
    } as NodeJS.ProcessEnv);
    assert.equal(config.timeoutMs, 5000);
  });

  it("throws when the base URL is missing", () => {
    assert.throws(
      () => loadConfig({ OPENARCHIVER_API_KEY: "secret" } as NodeJS.ProcessEnv),
      /OPENARCHIVER_BASE_URL/,
    );
  });

  it("throws when the API key is missing", () => {
    assert.throws(
      () => loadConfig({ OPENARCHIVER_BASE_URL: "https://host" } as NodeJS.ProcessEnv),
      /OPENARCHIVER_API_KEY/,
    );
  });
});
