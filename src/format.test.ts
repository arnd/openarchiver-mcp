import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EmailDetail, IntegrityCheckResult, SearchResponse } from "./client.js";
import {
  baseSubject,
  describeSearchFilters,
  classifyAttachment,
  formatBytes,
  formatEmail,
  formatIntegrityResults,
  formatSearchResults,
  formatThread,
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

describe("describeSearchFilters", () => {
  it("returns an empty string when no filter is set", () => {
    assert.equal(describeSearchFilters({ keywords: "x", page: 2 }), "");
  });

  it("summarises the filters in one line", () => {
    assert.equal(
      describeSearchFilters({
        from: ["*@telekom.de", "a@b.c"],
        dateFrom: "2025-01-01",
        hasAttachments: true,
        sort: "date_asc",
      }),
      "from *@telekom.de | a@b.c; date 2025-01-01 – …; with attachments; sorted date_asc",
    );
  });
});

describe("baseSubject", () => {
  it("strips stacked reply/forward prefixes in English and German", () => {
    assert.equal(baseSubject("Re: AW: Fwd:  Angebot   Dach"), "angebot dach");
    assert.equal(baseSubject("RE[2]: Angebot Dach"), "angebot dach");
    assert.equal(baseSubject("WG: Angebot Dach"), "angebot dach");
    assert.equal(baseSubject("Reminder: Angebot"), "reminder: angebot");
  });
});

describe("formatThread", () => {
  const member = (n: number, subject = "Angebot Dach", name = `Sender ${n}`) => ({
    id: `id-${n}`,
    subject: n === 1 ? subject : `Re: ${subject}`,
    sentAt: new Date(Date.UTC(2026, 2, n, 9, 30)).toISOString(),
    senderName: name,
    senderEmail: `s${n}@example.com`,
  });

  it("returns nothing for a missing or single-message thread", () => {
    assert.equal(formatThread(undefined, "id-1", "x"), "");
    assert.equal(formatThread(null, "id-1", "x"), "");
    assert.equal(formatThread([member(1)], "id-1", "Angebot Dach"), "");
  });

  it("lists every member, marks the open email and elides Re:-only subjects", () => {
    const out = formatThread([member(1), member(2), member(3)], "id-2", "Re: Angebot Dach");
    assert.equal(
      out,
      [
        "Thread (3 messages, oldest first; open one with get_email):",
        "  1. 2026-03-01 09:30  Sender 1  id: id-1",
        "→ 2. 2026-03-02 09:30  Sender 2  id: id-2  (this email)",
        "  3. 2026-03-03 09:30  Sender 3  id: id-3",
      ].join("\n"),
    );
  });

  it("shows the subject only where it really differs", () => {
    const changed = { ...member(2), subject: "Neues Thema" };
    const out = formatThread([member(1), changed], "id-1", "Angebot Dach");
    assert.match(out, /2\. 2026-03-02 09:30 {2}Sender 2 {2}"Neues Thema" {2}id: id-2$/m);
    assert.doesNotMatch(out, /Angebot Dach/);
  });

  it("falls back to the address when there is no sender name", () => {
    const anon = { ...member(2), senderName: null };
    assert.match(formatThread([member(1), anon], "id-1", "Angebot Dach"), /s2@example\.com {2}id: id-2/);
  });

  it("sorts by date even if the API order is off", () => {
    const out = formatThread([member(3), member(1), member(2)], "id-1", "Angebot Dach");
    assert.ok(out.indexOf("id-1") < out.indexOf("id-2") && out.indexOf("id-2") < out.indexOf("id-3"));
  });

  it("windows a long thread around the open email and counts the rest", () => {
    const thread = Array.from({ length: 28 }, (_, i) => member(i + 1));
    const out = formatThread(thread, "id-15", "Angebot Dach");
    const lines = out.split("\n");
    assert.equal(lines[0], "Thread (28 messages, oldest first; open one with get_email):");
    assert.equal(lines[1], "    … 4 earlier, oldest 2026-03-01");
    assert.match(lines[2], /^ {2}5\. /);
    assert.match(out, /^→ 15\. .*\(this email\)$/m);
    assert.match(lines[21], /^ {2}24\. /);
    assert.equal(lines[22], "    … 4 later, newest 2026-03-28");
    assert.equal(lines.length, 23);
  });

  it("keeps the window inside the thread at either end", () => {
    const thread = Array.from({ length: 28 }, (_, i) => member(i + 1));
    const first = formatThread(thread, "id-1", "Angebot Dach").split("\n");
    assert.match(first[1], /^→ 1\. /);
    assert.equal(first.at(-1), "    … 8 later, newest 2026-03-28");
    const last = formatThread(thread, "id-28", "Angebot Dach").split("\n");
    assert.equal(last[1], "    … 8 earlier, oldest 2026-03-01");
    assert.match(last.at(-1)!, /^→ 28\. /);
  });
});
