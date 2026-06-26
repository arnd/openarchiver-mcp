#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { simpleParser } from "mailparser";
import { z } from "zod";
import { OpenArchiverClient, OpenArchiverError } from "./client.js";
import { loadConfig } from "./config.js";
import {
  classifyAttachment,
  formatEmail,
  formatSearchResults,
  safeAttachmentFilename,
  stripHtml,
} from "./format.js";

const DEFAULT_MAX_ATTACHMENT_BYTES = 5_000_000;

type ToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
};

function errorResult(err: unknown): ToolResult {
  const message =
    err instanceof OpenArchiverError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

async function main(): Promise<void> {
  // Build the client lazily so the server can start and answer tools/list even
  // when OPENARCHIVER_BASE_URL/OPENARCHIVER_API_KEY are not set — e.g. when an MCP
  // directory or client validates the package by listing its tools. Config is
  // validated on the first actual tool call (a missing var then surfaces as a
  // normal tool error instead of crashing the server before the MCP handshake).
  let client: OpenArchiverClient | undefined;
  const getClient = (): OpenArchiverClient => {
    if (!client) {
      const config = loadConfig();
      client = new OpenArchiverClient(config.apiBase, config.apiKey, fetch, config.timeoutMs);
    }
    return client;
  };

  const server = new McpServer({ name: "openarchiver-mcp", version: "0.1.0" });

  server.registerTool(
    "search_archive",
    {
      title: "Search the email archive",
      description:
        "Full-text search across archived emails — matches subject, body and extracted attachment text. " +
        "Returns compact hits, each with an `id`. Use `get_email` with that id to read the full message.",
      inputSchema: {
        keywords: z.string().min(1).describe("Search query, e.g. 'invoice 2026' or a sender name."),
        page: z.number().int().min(1).optional().describe("Page number (default 1)."),
        limit: z.number().int().min(1).max(50).optional().describe("Results per page (default 10)."),
        matchingStrategy: z
          .enum(["last", "all", "frequency"])
          .optional()
          .describe(
            "Meilisearch strategy: 'last' = at least one keyword (default), 'all' = every keyword, 'frequency' = rank by frequency.",
          ),
      },
    },
    async (args) => {
      try {
        const data = await getClient().search(args);
        return text(formatSearchResults(data));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_email",
    {
      title: "Read a full archived email",
      description:
        "Fetch a single archived email by id: metadata, full body text, and the list of attachments " +
        "(each with a `storagePath` you can pass to `get_attachment`).",
      inputSchema: {
        id: z.string().min(1).describe("The archived email id, as returned by search_archive."),
      },
    },
    async ({ id }) => {
      try {
        const detail = await getClient().getEmail(id);
        let body = "";
        if (detail.raw?.data?.length) {
          const parsed = await simpleParser(Buffer.from(detail.raw.data));
          if (parsed.text) {
            body = parsed.text;
          } else if (parsed.html) {
            body = stripHtml(parsed.html);
          }
        }
        return text(formatEmail(detail, body));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_attachment",
    {
      title: "Download an attachment",
      description:
        "Download an attachment by its `storagePath` (from get_email). " +
        "mode 'inline' (default): text files are returned as text, images as image content, " +
        "other binaries (PDF, Office, …) as base64. " +
        "mode 'file': write the bytes to a server-managed temp file and return only its path — " +
        "use this for large binaries to avoid huge base64 in the context. The returned path is only " +
        "usable when this server runs on the same machine as the client (local stdio); the server " +
        "chooses the path itself, so callers cannot point it at arbitrary files. " +
        "Tip: for PDFs, the extracted text is also searchable and shown via search_archive/get_email.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("The attachment's storagePath, e.g. 'open-archiver/.../attachments/xyz.pdf'."),
        mode: z
          .enum(["inline", "file"])
          .optional()
          .describe("'inline' (default) returns content in the response; 'file' saves to a temp file and returns its path."),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`Max bytes to return inline (default ${DEFAULT_MAX_ATTACHMENT_BYTES}); ignored for mode 'file'.`),
      },
    },
    async ({ path, mode, maxBytes }) => {
      try {
        const { bytes, contentType, filename } = await getClient().download(path);

        if (mode === "file") {
          const dir = join(tmpdir(), "openarchiver-mcp");
          await mkdir(dir, { recursive: true });
          // Server-generated path inside our own dir: a random prefix guarantees
          // uniqueness, and the sanitized basename can't escape `dir`.
          const target = join(dir, `${randomUUID()}-${safeAttachmentFilename(filename)}`);
          await writeFile(target, bytes, { flag: "wx" });
          return text(
            `Saved "${filename || "attachment"}" (${contentType}, ${bytes.length} bytes) to:\n${target}`,
          );
        }

        const max = maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
        const kind = classifyAttachment(contentType, bytes.length, max);

        switch (kind) {
          case "too_large":
            return text(
              `Attachment "${filename}" is ${bytes.length} bytes which exceeds maxBytes (${max}). ` +
                `Re-run with a larger maxBytes to fetch it. mimeType=${contentType}`,
            );
          case "image":
            return { content: [{ type: "image", data: bytes.toString("base64"), mimeType: contentType }] };
          case "text":
            return text(`# ${filename} (${contentType})\n\n${bytes.toString("utf8")}`);
          case "blob":
            return text(
              `# ${filename} (${contentType}, ${bytes.length} bytes)\n` +
                `Base64-encoded content:\n\n${bytes.toString("base64")}`,
            );
        }
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logging; stdout is reserved for the MCP protocol.
  console.error("openarchiver-mcp connected (stdio)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
