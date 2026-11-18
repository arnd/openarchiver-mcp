import { convert as htmlToText } from "html-to-text";

import type {
  EmailDetail,
  IntegrityCheckResult,
  SearchParams,
  SearchResponse,
  ThreadEmail,
} from "./client.js";

/** Format an epoch-millis number or ISO string as an ISO timestamp; fall back to the raw value. */
export function formatDate(value: string | number | undefined | null): string {
  if (value == null || value === "") return "unknown";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/** Collapse whitespace and truncate to `maxLength` characters. */
export function snippet(text: string | undefined, maxLength = 200): string {
  if (!text) return "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength)}…` : oneLine;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes == null) return "? B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Render search results as a compact, id-forward text block. */
/** One-line summary of the structured filters a search ran with, or "" when none were set.
 * Echoed above the results so the caller can see what the hit list is narrowed to. */
export function describeSearchFilters(params: SearchParams): string {
  const parts: string[] = [];
  const list = (label: string, values?: string[]) => {
    if (values?.length) parts.push(`${label} ${values.join(" | ")}`);
  };
  list("from", params.from);
  list("not from", params.notFrom);
  list("to", params.to);
  list("not to", params.notTo);
  list("mailbox", params.mailboxes);
  if (params.dateFrom || params.dateTo) {
    parts.push(`date ${params.dateFrom ?? "…"} – ${params.dateTo ?? "…"}`);
  }
  if (params.hasAttachments !== undefined) {
    parts.push(params.hasAttachments ? "with attachments" : "without attachments");
  }
  if (params.searchIn?.length) parts.push(`keywords in ${params.searchIn.join(", ")}`);
  if (params.sort) parts.push(`sorted ${params.sort}`);
  return parts.join("; ");
}

export function formatSearchResults(data: SearchResponse): string {
  const hits = data.hits ?? [];
  const limit = data.limit || hits.length || 1;
  const offset = ((data.page || 1) - 1) * limit;

  if (hits.length === 0) {
    return `No results (total ${data.total ?? 0}).`;
  }

  const header = `Results ${offset + 1}–${offset + hits.length} of ${data.total} (page ${data.page}/${data.totalPages}):`;

  const blocks = hits.map((hit, index) => {
    const attachments = (hit.attachments ?? [])
      .map((a) => a.filename)
      .filter((name): name is string => Boolean(name));
    const lines = [
      `${offset + index + 1}. ${hit.subject || "(no subject)"}`,
      `   id: ${hit.id}`,
      `   from: ${hit.from || "?"}  →  ${(hit.to ?? []).join(", ") || "?"}`,
      `   date: ${formatDate(hit.timestamp)}`,
    ];
    if (attachments.length > 0) {
      lines.push(`   attachments: ${attachments.join(", ")}`);
    }
    const preview = snippet(hit.body);
    if (preview) {
      lines.push(`   snippet: ${preview}`);
    }
    return lines.join("\n");
  });

  return `${header}\n\n${blocks.join("\n\n")}`;
}

/** Render a single email's metadata, attachment list, and body. */
export function formatEmail(detail: EmailDetail, body: string): string {
  const from = detail.senderName
    ? `${detail.senderName} <${detail.senderEmail ?? ""}>`
    : detail.senderEmail || "?";
  const to =
    (detail.recipients ?? [])
      .map((r) => (r.name ? `${r.name} <${r.email ?? ""}>` : r.email))
      .filter(Boolean)
      .join(", ") || "?";
  const tags = detail.tags && detail.tags.length > 0 ? detail.tags.join(", ") : "—";

  const lines = [
    `Subject: ${detail.subject || "(no subject)"}`,
    `From: ${from}`,
    `To: ${to}`,
    `Date: ${formatDate(detail.sentAt)}`,
    `Folder: ${detail.path || "?"}    Tags: ${tags}`,
    `Message-ID: ${detail.messageIdHeader || "?"}`,
    `Size: ${formatBytes(detail.sizeBytes)}`,
  ];

  const attachments = detail.attachments ?? [];
  if (attachments.length > 0) {
    lines.push("", `Attachments (${attachments.length}):`);
    attachments.forEach((a, index) => {
      lines.push(
        `  [${index}] ${a.filename || "(unnamed)"} — ${a.mimeType || "?"}, ${formatBytes(a.sizeBytes)}`,
        `      storagePath: ${a.storagePath ?? "?"}`,
      );
    });
  } else {
    lines.push("", "Attachments: none");
  }

  const thread = formatThread(detail.thread, detail.id, detail.subject);
  if (thread) lines.push("", thread);

  lines.push("", "--- Body ---", body.trim() || "(no text body)");
  return lines.join("\n");
}

/** Max thread members listed in get_email; longer threads show a window around the open email. */
export const THREAD_MAX_ENTRIES = 20;

const REPLY_PREFIX = /^\s*((re|aw|antw|fw|fwd|wg|sv|vs|tr)(\s*\[\d+\])?\s*:\s*)+/i;

/** Subject without reply/forward prefixes, whitespace-collapsed and lower-cased, for comparison. */
export function baseSubject(subject: string | null | undefined): string {
  return (subject ?? "").replace(REPLY_PREFIX, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function shortDate(value: string | null | undefined): string {
  if (!value) return "????-??-?? ??:??";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Compact thread overview for get_email: one line per member (date, sender, id), oldest first,
 * with the open email marked. References only -- bodies are one get_email call away, and fetching
 * them all would download every member's raw .eml. To keep the context cost small, the subject is
 * shown only where it differs from the open email's beyond Re:/AW:/Fwd: prefixes, and threads
 * longer than THREAD_MAX_ENTRIES show a window around the open email plus a count of the rest.
 * Returns "" for a single-message thread or when the API sent no thread.
 */
export function formatThread(
  thread: ThreadEmail[] | null | undefined,
  currentId: string,
  currentSubject?: string,
): string {
  if (!Array.isArray(thread) || thread.length <= 1) return "";
  const members = [...thread].sort((a, b) => (a.sentAt ?? "").localeCompare(b.sentAt ?? ""));
  const total = members.length;
  const current = Math.max(0, members.findIndex((m) => m.id === currentId));
  const start =
    total <= THREAD_MAX_ENTRIES
      ? 0
      : Math.min(Math.max(0, current - Math.floor(THREAD_MAX_ENTRIES / 2)), total - THREAD_MAX_ENTRIES);
  const end = Math.min(total, start + THREAD_MAX_ENTRIES);
  const base = baseSubject(currentSubject);

  const lines = [`Thread (${total} messages, oldest first; open one with get_email):`];
  if (start > 0) {
    lines.push(`    … ${start} earlier, oldest ${shortDate(members[0].sentAt).slice(0, 10)}`);
  }
  for (let i = start; i < end; i++) {
    const m = members[i];
    const marker = i === current ? "→" : " ";
    const sender = m.senderName?.trim() || m.senderEmail?.trim() || "?";
    const subject = baseSubject(m.subject) === base ? "" : `  "${m.subject?.trim() || "(no subject)"}"`;
    const self = i === current ? "  (this email)" : "";
    lines.push(`${marker} ${i + 1}. ${shortDate(m.sentAt)}  ${sender}${subject}  id: ${m.id}${self}`);
  }
  if (end < total) {
    lines.push(`    … ${total - end} later, newest ${shortDate(members[total - 1].sentAt).slice(0, 10)}`);
  }
  return lines.join("\n");
}

export type AttachmentKind = "text" | "image" | "blob" | "too_large";

/** Decide how an attachment should be returned over MCP based on type and size. */
export function classifyAttachment(
  mimeType: string,
  sizeBytes: number,
  maxBytes: number,
): AttachmentKind {
  if (sizeBytes > maxBytes) return "too_large";
  const mt = (mimeType || "").toLowerCase().split(";")[0].trim();
  if (mt.startsWith("image/")) return "image";
  if (isTextual(mt)) return "text";
  return "blob";
}

function isTextual(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "message/rfc822" ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml")
  );
}

/**
 * Reduce an attachment filename to a safe basename: drop any directory
 * components and characters that could enable path traversal, so the server can
 * never be tricked into writing outside its own managed temp directory.
 */
export function safeAttachmentFilename(name: string | undefined): string {
  const base = (name ?? "").split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, "_") // conservative charset
    .replace(/^[.]+/, "") // no leading dots (".." / hidden files)
    .slice(0, 200);
  return cleaned || "attachment";
}

/**
 * HTML-to-text fallback for emails that only have an HTML part. Delegates to the
 * well-tested `html-to-text` parser (already in our tree via mailparser) rather
 * than hand-rolled regexes, which can't safely handle HTML's many corner cases.
 */
export function stripHtml(html: string): string {
  return htmlToText(html, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "a", options: { ignoreHref: true } },
    ],
  })
    .replace(/ /g, " ") // normalize &nbsp; to a plain space
    .trim();
}

/**
 * Render an integrity report. The verdict goes first — that is the whole point of
 * the call — and full hashes are only spelled out for items that failed, so a
 * clean report stays short.
 */
export function formatIntegrityResults(id: string, results: IntegrityCheckResult[]): string {
  if (results.length === 0) {
    return `Integrity check for ${id}: no items returned by OpenArchiver.`;
  }

  const failed = results.filter((r) => !r.isValid);
  const verdict =
    failed.length === 0
      ? `PASSED — all ${results.length} item(s) match their archived SHA-256 hash.`
      : `FAILED — ${failed.length} of ${results.length} item(s) do not match their archived SHA-256 hash.`;

  const lines = [`Integrity check for ${id}: ${verdict}`, ""];

  for (const result of results) {
    const label =
      result.type === "attachment"
        ? `attachment ${result.filename || "(unnamed)"} [${result.id}]`
        : `email [${result.id}]`;
    lines.push(`  ${result.isValid ? "✓" : "✗"} ${label}`);
    if (!result.isValid) {
      lines.push(
        `      reason:   ${result.reason || "unknown"}`,
        `      stored:   ${result.storedHash || "(none)"}`,
        `      computed: ${result.computedHash || "(unreadable)"}`,
      );
    }
  }

  return lines.join("\n");
}
