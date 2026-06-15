import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OpenArchiverClient,
  OpenArchiverError,
  parseContentDispositionFilename,
} from "./client.js";

interface Recorded {
  url: string;
  headers: Record<string, string>;
}

/** Build a fetch stub that records the call and returns a canned response. */
function stubFetch(response: Response, recorded: Recorded[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    recorded.push({
      url: String(input),
      headers: Object.fromEntries(headers.entries()),
    });
    return response;
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("parseContentDispositionFilename", () => {
  it("parses a quoted filename", () => {
    assert.equal(
      parseContentDispositionFilename('attachment; filename="invoice.pdf"'),
      "invoice.pdf",
    );
  });

  it("parses an RFC 5987 filename*", () => {
    assert.equal(
      parseContentDispositionFilename("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"),
      "résumé.pdf",
    );
  });

  it("returns undefined when absent", () => {
    assert.equal(parseContentDispositionFilename(null), undefined);
  });
});

describe("OpenArchiverClient.search", () => {
  it("builds the search URL and sends the API key header", async () => {
    const recorded: Recorded[] = [];
    const client = new OpenArchiverClient(
      "https://host/api/v1",
      "secret-key",
      stubFetch(jsonResponse({ hits: [], total: 0, page: 1, limit: 10, totalPages: 0, processingTimeMs: 1 }), recorded),
    );

    await client.search({ keywords: "invoice 2026", page: 2, limit: 5, matchingStrategy: "all" });

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].headers["x-api-key"], "secret-key");
    const url = new URL(recorded[0].url);
    assert.equal(url.pathname, "/api/v1/search");
    assert.equal(url.searchParams.get("keywords"), "invoice 2026");
    assert.equal(url.searchParams.get("page"), "2");
    assert.equal(url.searchParams.get("limit"), "5");
    assert.equal(url.searchParams.get("matchingStrategy"), "all");
  });

  it("maps 401 to an actionable error", async () => {
    const client = new OpenArchiverClient(
      "https://host/api/v1",
      "bad",
      stubFetch(new Response("nope", { status: 401 })),
    );

    await assert.rejects(client.search({ keywords: "x" }), (err: unknown) => {
      assert.ok(err instanceof OpenArchiverError);
      assert.equal(err.status, 401);
      assert.match(err.message, /API_KEY/);
      return true;
    });
  });
});

describe("OpenArchiverClient.getEmail", () => {
  it("encodes the id into the path and maps 404", async () => {
    const recorded: Recorded[] = [];
    const client = new OpenArchiverClient(
      "https://host/api/v1",
      "secret",
      stubFetch(new Response("missing", { status: 404 }), recorded),
    );

    await assert.rejects(client.getEmail("a/b c"), (err: unknown) => {
      assert.ok(err instanceof OpenArchiverError);
      assert.equal(err.status, 404);
      return true;
    });
    assert.match(recorded[0].url, /\/api\/v1\/archived-emails\/a%2Fb%20c$/);
  });
});

describe("OpenArchiverClient.download", () => {
  it("returns bytes, content-type and the parsed filename", async () => {
    const payload = Buffer.from("PDFDATA");
    const response = new Response(payload, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="report.pdf"',
      },
    });
    const client = new OpenArchiverClient("https://host/api/v1", "secret", stubFetch(response));

    const result = await client.download("open-archiver/x/attachments/report.pdf");
    assert.equal(result.contentType, "application/pdf");
    assert.equal(result.filename, "report.pdf");
    assert.deepEqual(result.bytes, payload);
  });

  it("falls back to the last path segment when no header is present", async () => {
    const client = new OpenArchiverClient(
      "https://host/api/v1",
      "secret",
      stubFetch(new Response(Buffer.from("x"), { status: 200 })),
    );
    const result = await client.download("a/b/file.bin");
    assert.equal(result.filename, "file.bin");
  });
});
