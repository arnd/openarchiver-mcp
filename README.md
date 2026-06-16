# openarchiver-mcp

[![CI](https://github.com/arnd/openarchiver-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/arnd/openarchiver-mcp/actions/workflows/ci.yml)

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant (Claude Code, Claude
Desktop, …) search and read your [OpenArchiver](https://openarchiver.com) email archive.

It is a thin, typed wrapper around the OpenArchiver REST API and exposes three tools:

| Tool | What it does |
|------|--------------|
| `search_archive` | Full-text search across archived emails (subject, body, **and extracted attachment text**). Returns compact hits, each with an `id`. |
| `get_email` | Fetch one email by id: metadata, full body, and an attachment list (each with a `storagePath`). |
| `get_attachment` | Download an attachment by its `storagePath`. Default returns it inline (text → text, images → image content, other binaries → base64). With `mode: "file"` it saves the bytes to a server-managed temp file and returns only the path — handy for large binaries to keep base64 out of the context (path only usable when the server runs locally; the server picks the path, callers can't). |

All operations are **read-only**.

## Requirements

- **Node.js ≥ 26**
- An OpenArchiver instance and an **API key** with the permissions `search:archive` and `read:archive`
  (create one in OpenArchiver under *Settings → API keys*, or via `POST /api/v1/api-keys`).

> **OpenArchiver compatibility:** developed and tested against **OpenArchiver 0.5.0** (REST API `v1`).
> OpenArchiver has no stable public OpenAPI spec yet, so other versions may differ; 0.5.0 or newer is
> recommended.

## Install

The published package runs directly with `npx` — no checkout or build needed:

```bash
npx -y openarchiver-mcp
```

(It's normally launched by your MCP client, not by hand — see below.)

### From source

```bash
npm install
npm run build      # compiles TypeScript to dist/
npm test           # builds and runs the unit tests
npm run smoke      # launches the built server and verifies it speaks MCP (tools/list)
```

> `npm run smoke` needs no OpenArchiver instance: it uses dummy credentials and only lists tools,
> which never calls the API.

## Configuration

The server reads two environment variables:

| Variable | Required | Example |
|----------|----------|---------|
| `OPENARCHIVER_BASE_URL` | yes | `https://openarchiver.example.com` (the `/api/v1` suffix is added automatically) |
| `OPENARCHIVER_API_KEY` | yes | your API key |
| `OPENARCHIVER_TIMEOUT_MS` | no | request timeout, default `30000` |

For local runs you can keep these in a `.env` file (see `.env.example`) and start the server with
Node's built-in env-file support — no extra dependency required:

```bash
cp .env.example .env   # then fill in your values
node --env-file=.env dist/index.js
```

> The `.env` file is git-ignored. Never commit your API key.

## Use with Claude Code

```bash
claude mcp add openarchiver \
  --env OPENARCHIVER_BASE_URL=https://openarchiver.example.com \
  --env OPENARCHIVER_API_KEY=your-api-key \
  -- npx -y openarchiver-mcp
```

## Use with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "openarchiver": {
      "command": "npx",
      "args": ["-y", "openarchiver-mcp"],
      "env": {
        "OPENARCHIVER_BASE_URL": "https://openarchiver.example.com",
        "OPENARCHIVER_API_KEY": "your-api-key"
      }
    }
  }
}
```

> Running from a local checkout instead? Replace the command with
> `node /absolute/path/to/openarchiver-mcp/dist/index.js`.

## Inspect / debug

Run the official MCP Inspector against the built server:

```bash
npx @modelcontextprotocol/inspector node --env-file=.env dist/index.js
```

## How it works

- `src/config.ts` — reads and validates env vars; normalizes the base URL to `…/api/v1`.
- `src/client.ts` — `OpenArchiverClient` (`search`, `getEmail`, `download`); `fetch` is injectable for
  testing; maps HTTP errors (401/403/404/…) to actionable messages.
- `src/format.ts` — pure functions that render API responses into compact text for the model.
- `src/index.ts` — registers the three MCP tools and serves them over stdio. `get_email` parses the
  raw RFC822 message (returned by the API) with [`mailparser`](https://nodemailer.com/extras/mailparser/)
  to produce a readable body.

Tests live next to the code (`*.test.ts`) and run on Node's built-in test runner (`node:test`) — no
network access required (the HTTP layer is mocked).

## Notes & limitations

- OpenArchiver does not publish an official client SDK or a hosted OpenAPI spec, so this server talks to
  the REST endpoints directly.
- The storage download endpoint returns `application/octet-stream` for attachments, so `get_attachment`
  returns most binaries (e.g. PDFs) as base64. For **reading** PDF/Office content, prefer
  `search_archive` / `get_email`, which expose the server-side extracted text.
- Meilisearch caps `total` at 1000 by default; use `page`/`limit` to paginate.
