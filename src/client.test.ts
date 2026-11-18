import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  encodeEmailId,
  OpenArchiverClient,
  OpenArchiverError,
  parseContentDispositionFilename,
  readBounded,
} from "./client.js";

interface Recorded {
  url: string;
  headers: Record<string, string>;
  redirect?: RequestRedirect;
}

/** Build a fetch stub that records the call and returns a canned response. */
function stubFetch(response: Response, recorded: Recorded[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    recorded.push({
      url: String(input),
      headers: Object.fromEntries(headers.entries()),
      redirect: init?.redirect,
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
      assert.match(err.message, /No archived email with this id/);
      return true;
    });
    assert.match(recorded[0].url, /\/api\/v1\/archived-emails\/a%2Fb%20c$/);
  });
});

describe("OpenArchiverClient.checkIntegrity", () => {
  it("encodes the id into the integrity path and returns the report array", async () => {
    const recorded: Recorded[] = [];
    const report = [
      { type: "email", id: "abc", isValid: true, storedHash: "aa", computedHash: "aa" },
    ];
    const client = new OpenArchiverClient(
      "https://host/api/v1",
      "secret",
      stubFetch(jsonResponse(report), recorded),
    );

    const result = await client.checkIntegrity("a/b c");
    assert.deepEqual(result, report);
    assert.match(recorded[0].url, /\/api\/v1\/integrity\/a%2Fb%20c$/);
    assert.equal(recorded[0].headers["x-api-key"], "secret");
  });

  it("maps 404 to an actionable error", async () => {
    const client = new OpenArchiverClient(
      "https://host/api/v1",
      "secret",
      stubFetch(new Response("missing", { status: 404 })),
    );
    await assert.rejects(client.checkIntegrity("nope"), (err: unknown) => {
      assert.ok(err instanceof OpenArchiverError);
      assert.equal(err.status, 404);
      return true;
    });
  });

  it("rejects a non-array payload instead of passing it on", async () => {
    const client = new OpenArchiverClient(
      "https://host/api/v1",
      "secret",
      stubFetch(jsonResponse({ message: "something else" })),
    );
    await assert.rejects(client.checkIntegrity("abc"), (err: unknown) => {
      assert.ok(err instanceof OpenArchiverError);
      assert.match(err.message, /expected a list of results/);
      return true;
    });
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

  it("explains a 404 as a possible permission scope, not just a wrong path", async () => {
    const client = new OpenArchiverClient(
      "https://host/api/v1",
      "secret",
      stubFetch(new Response("nope", { status: 404 })),
    );
    await assert.rejects(client.download("open-archiver/x/attachments/y.pdf"), (err: unknown) => {
      assert.ok(err instanceof OpenArchiverError);
      assert.equal(err.status, 404);
      assert.match(err.message, /role does not cover/);
      return true;
    });
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

describe("OpenArchiverClient redirects", () => {
  it("never lets fetch follow a redirect", async () => {
    const recorded: Recorded[] = [];
    const client = new OpenArchiverClient("https://host/api/v1", "secret", stubFetch(jsonResponse([]), recorded));
    await client.checkIntegrity("abc");
    assert.equal(recorded[0].redirect, "manual");
  });

  it("turns a 3xx into an actionable error naming the target", async () => {
    const redirect = new Response(null, { status: 301, headers: { location: "https://elsewhere.example/api/v1/search" } });
    const client = new OpenArchiverClient("http://host/api/v1", "secret", stubFetch(redirect));
    await assert.rejects(client.search({ keywords: "x" }), (err: unknown) => {
      assert.ok(err instanceof OpenArchiverError);
      assert.equal(err.status, 301);
      assert.match(err.message, /redirect \(301\) to https:\/\/elsewhere\.example/);
      assert.match(err.message, /OPENARCHIVER_BASE_URL/);
      return true;
    });
  });
});

describe("encodeEmailId", () => {
  it("encodes a normal id as a single path segment", () => {
    assert.equal(encodeEmailId("0b6c1d2e-aaaa-4bbb-8ccc-123456789abc"), "0b6c1d2e-aaaa-4bbb-8ccc-123456789abc");
    assert.equal(encodeEmailId("a/../b"), "a%2F..%2Fb");
    assert.equal(encodeEmailId("%2e%2e"), "%252e%252e");
  });

  for (const bad of ["", "   ", ".", "..", "abc\n", "a\u0000b"]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => encodeEmailId(bad), OpenArchiverError);
    });
  }

  it("rejects a dot-segment id before any request is sent", async () => {
    const recorded: Recorded[] = [];
    const client = new OpenArchiverClient("https://host/api/v1", "secret", stubFetch(jsonResponse({}), recorded));
    await assert.rejects(client.getEmail(".."), /Invalid email id/);
    await assert.rejects(client.checkIntegrity("."), /Invalid email id/);
    assert.equal(recorded.length, 0);
  });
});

/** A body streamed in chunks without a Content-Length header. */
function streamedResponse(chunks: number, chunkSize: number, init?: ResponseInit): Response {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent++ < chunks) controller.enqueue(new Uint8Array(chunkSize).fill(0x61));
      else controller.close();
    },
  });
  return new Response(stream, init);
}

describe("readBounded", () => {
  it("returns a body within the limit", async () => {
    const bytes = await readBounded(streamedResponse(3, 10), 30);
    assert.equal(bytes.length, 30);
  });

  it("rejects up front when Content-Length exceeds the limit", async () => {
    const res = new Response("x".repeat(100), { headers: { "content-length": "100" } });
    await assert.rejects(readBounded(res, 50), /exceeds the 50-byte limit/);
  });

  it("aborts a streamed body without Content-Length once it passes the limit", async () => {
    await assert.rejects(readBounded(streamedResponse(1000, 1024), 4096), /exceeds the 4096-byte limit/);
  });
});

describe("OpenArchiverClient response size limit", () => {
  it("applies the configured limit to JSON responses", async () => {
    const big = jsonResponse({ hits: [], filler: "x".repeat(2000) });
    const client = new OpenArchiverClient("https://host/api/v1", "secret", stubFetch(big), 30_000, 1000);
    await assert.rejects(client.search({ keywords: "x" }), (err: unknown) => {
      assert.ok(err instanceof OpenArchiverError);
      assert.match(err.message, /OPENARCHIVER_MAX_RESPONSE_BYTES/);
      return true;
    });
  });

  it("applies the configured limit to downloads", async () => {
    const res = streamedResponse(10, 1024, { headers: { "content-type": "application/pdf" } });
    const client = new OpenArchiverClient("https://host/api/v1", "secret", stubFetch(res), 30_000, 5000);
    await assert.rejects(client.download("a/b.pdf"), /exceeds the 5000-byte limit/);
  });

  it("reports invalid JSON as an OpenArchiverError", async () => {
    const res = new Response("<html>proxy error</html>", { status: 200 });
    const client = new OpenArchiverClient("https://host/api/v1", "secret", stubFetch(res));
    await assert.rejects(client.getEmail("abc"), /not valid JSON/);
  });

  it("keeps only a bounded error body for the message", async () => {
    const res = streamedResponse(10_000, 1024, { status: 500 });
    const client = new OpenArchiverClient("https://host/api/v1", "secret", stubFetch(res));
    await assert.rejects(client.search({ keywords: "x" }), (err: unknown) => {
      assert.ok(err instanceof OpenArchiverError);
      assert.equal(err.status, 500);
      // body exceeds the error-body cap, so it is dropped rather than buffered
      assert.equal(err.message, "OpenArchiver request failed (500)");
      return true;
    });
  });
});
