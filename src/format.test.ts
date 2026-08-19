import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EmailDetail, IntegrityCheckResult, SearchResponse } from "./client.js";
import {
  classifyAttachment,
  formatBytes,
  formatEmail,
  formatIntegrityResults,
  formatSearchResults,
  safeAttachmentFilename,
  snippet,
  stripHtml,
} from "./format.js";

describe("safeAttachmentFilename", () => {
  it("keeps a normal filename", () => {
    assert.equal(safeAttachmentFilename("invoice 2026.pdf"), "invoice_2026.pdf");
  });
  it("strips directory components and traversal", () => {
    assert.equal(safeAttachmentFilename("../../etc/passwd"), "passwd");
    assert.equal(safeAttachmentFilename("a/b/c\\d.txt"), "d.txt");
    assert.equal(safeAttachmentFilename(".."), "attachment");
  });
  it("drops leading dots and falls back for empty/missing", () => {
    assert.equal(safeAttachmentFilename(".env"), "env");
    assert.equal(safeAttachmentFilename(""), "attachment");
    assert.equal(safeAttachmentFilename(undefined), "attachment");
  });
});

describe("snippet", () => {
  it("collapses whitespace and truncates", () => {
    assert.equal(snippet("a\n\n  b   c", 4), "a b …");
    assert.equal(snippet("short"), "short");
    assert.equal(snippet(undefined), "");
  });
});

describe("formatBytes", () => {
  it("scales units", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(2048), "2.0 KB");
    assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
    assert.equal(formatBytes(undefined), "? B");
  });
});

describe("formatSearchResults", () => {
  const data: SearchResponse = {
    hits: [
      {
        id: "abc-123",
        from: "invoicing@aws.com",
        to: ["me@example.com"],
        subject: "AWS Invoice",
        body: "Greetings, your invoice is ready.",
        attachments: [{ filename: "invoice.pdf", content: "..." }],
        timestamp: 1_777_680_929_000,
      },
    ],
    total: 1000,
    page: 1,
    limit: 10,
    totalPages: 100,
    processingTimeMs: 9,
  };

  it("includes id, subject, attachments and a snippet", () => {
    const out = formatSearchResults(data);
    assert.match(out, /id: abc-123/);
    assert.match(out, /AWS Invoice/);
    assert.match(out, /attachments: invoice\.pdf/);
    assert.match(out, /snippet: Greetings/);
    assert.match(out, /of 1000/);
  });

  it("reports an empty result set", () => {
    const out = formatSearchResults({ ...data, hits: [], total: 0 });
    assert.match(out, /No results/);
  });
});

describe("formatEmail", () => {
  const detail: EmailDetail = {
    id: "abc-123",
    subject: "AWS Invoice",
    senderName: "AWS",
    senderEmail: "invoicing@aws.com",
    recipients: [{ name: "", email: "me@example.com" }],
    sentAt: "2026-05-02T00:15:29.000Z",
    messageIdHeader: "<msg@aws.com>",
    path: "INBOX",
    sizeBytes: 19_687,
    hasAttachments: true,
    attachments: [
      {
        id: "att-1",
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        sizeBytes: 74_611,
        storagePath: "open-archiver/x/attachments/invoice.pdf",
      },
    ],
  };

  it("renders metadata, attachment storagePath and body", () => {
    const out = formatEmail(detail, "Hello world");
    assert.match(out, /Subject: AWS Invoice/);
    assert.match(out, /From: AWS <invoicing@aws.com>/);
    assert.match(out, /storagePath: open-archiver\/x\/attachments\/invoice\.pdf/);
    assert.match(out, /--- Body ---\nHello world/);
  });

  it("handles a missing body", () => {
    const out = formatEmail({ ...detail, attachments: [] }, "");
    assert.match(out, /Attachments: none/);
    assert.match(out, /\(no text body\)/);
  });
});

describe("classifyAttachment", () => {
  const max = 1000;
  it("classifies by mime type", () => {
    assert.equal(classifyAttachment("image/png", 10, max), "image");
    assert.equal(classifyAttachment("text/plain; charset=utf-8", 10, max), "text");
    assert.equal(classifyAttachment("application/json", 10, max), "text");
    assert.equal(classifyAttachment("application/xhtml+xml", 10, max), "text");
    assert.equal(classifyAttachment("application/pdf", 10, max), "blob");
    assert.equal(classifyAttachment("application/octet-stream", 10, max), "blob");
  });

  it("flags oversize attachments regardless of type", () => {
    assert.equal(classifyAttachment("text/plain", 2000, max), "too_large");
    assert.equal(classifyAttachment("image/png", 2000, max), "too_large");
  });
});

describe("stripHtml", () => {
  it("removes tags and decodes basic entities", () => {
    const out = stripHtml("<p>Hello&nbsp;<b>world</b></p><script>bad()</script>");
    assert.match(out, /Hello world/);
    assert.doesNotMatch(out, /bad\(\)/);
    assert.doesNotMatch(out, /</);
  });

  it("strips script/style with malformed end tags browsers still accept", () => {
    for (const html of [
      "<script>bad()</script >",
      "<script>bad()</script\t\nfoo>",
      '<script>bad()</script foo="bar">',
      "<style>x{}</style bar>",
    ]) {
      const out = stripHtml(html);
      assert.doesNotMatch(out, /bad\(\)/, html);
      assert.doesNotMatch(out, /x\{\}/, html);
    }
  });
});

describe("formatIntegrityResults", () => {
  const passing: IntegrityCheckResult[] = [
    { type: "email", id: "e1", isValid: true, storedHash: "aa", computedHash: "aa" },
    {
      type: "attachment",
      id: "a1",
      filename: "invoice.pdf",
      isValid: true,
      storedHash: "bb",
      computedHash: "bb",
    },
  ];

  it("reports a clean run without spelling out hashes", () => {
    const out = formatIntegrityResults("e1", passing);
    assert.match(out, /PASSED — all 2 item\(s\)/);
    assert.match(out, /✓ email \[e1\]/);
    assert.match(out, /✓ attachment invoice\.pdf \[a1\]/);
    assert.doesNotMatch(out, /stored:/);
  });

  it("flags failures with reason and both hashes", () => {
    const out = formatIntegrityResults("e1", [
      passing[0],
      {
        type: "attachment",
        id: "a2",
        filename: "note.txt",
        isValid: false,
        reason: "Stored hash does not match current hash.",
        storedHash: "cc",
        computedHash: "dd",
      },
    ]);
    assert.match(out, /FAILED — 1 of 2 item\(s\)/);
    assert.match(out, /✗ attachment note\.txt \[a2\]/);
    assert.match(out, /reason:   Stored hash does not match/);
    assert.match(out, /stored:   cc/);
    assert.match(out, /computed: dd/);
  });

  it("marks an unreadable attachment (empty computed hash) explicitly", () => {
    const out = formatIntegrityResults("e1", [
      {
        type: "attachment",
        id: "a3",
        filename: "gone.bin",
        isValid: false,
        reason: "Could not read attachment file from storage.",
        storedHash: "ee",
        computedHash: "",
      },
    ]);
    assert.match(out, /computed: \(unreadable\)/);
  });

  it("handles an empty report", () => {
    assert.match(formatIntegrityResults("e1", []), /no items returned/);
  });
});
