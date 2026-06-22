import type { EmailDetail, SearchResponse } from "./client.js";

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

  lines.push("", "--- Body ---", body.trim() || "(no text body)");
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

/** Minimal HTML-to-text fallback for emails that only have an HTML part. */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style[^>]*>/gi, " ")
    .replace(/<script[\s\S]*?<\/script[^>]*>/gi, " ")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&") // unescape ampersand last to avoid double-unescaping
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
