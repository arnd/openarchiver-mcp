export type FetchLike = typeof fetch;

export type MatchingStrategy = "last" | "all" | "frequency";

export interface SearchParams {
  keywords: string;
  page?: number;
  limit?: number;
  matchingStrategy?: MatchingStrategy;
}

export interface SearchAttachment {
  filename?: string;
  content?: string;
}

export interface SearchHit {
  id: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  attachments?: SearchAttachment[];
  timestamp?: number;
}

export interface SearchResponse {
  hits: SearchHit[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  processingTimeMs: number;
}

export interface EmailAttachment {
  id?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  storagePath?: string;
}

export interface EmailDetail {
  id: string;
  subject?: string;
  senderName?: string;
  senderEmail?: string;
  recipients?: { name?: string; email?: string }[];
  sentAt?: string;
  messageIdHeader?: string;
  path?: string;
  tags?: string[] | null;
  sizeBytes?: number;
  hasAttachments?: boolean;
  storagePath?: string;
  attachments?: EmailAttachment[];
  /** Raw RFC822 message, serialized as a Node Buffer (`{ type: "Buffer", data: number[] }`). */
  raw?: { type: "Buffer"; data: number[] } | null;
}

export interface DownloadResult {
  bytes: Buffer;
  contentType: string;
  filename: string;
}

export class OpenArchiverError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "OpenArchiverError";
  }
}

/** Extract `filename` from a Content-Disposition header value. */
export function parseContentDispositionFilename(value: string | null): string | undefined {
  if (!value) return undefined;
  const star = value.match(/filename\*=(?:UTF-8'')?"?([^";]+)"?/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return star[1];
    }
  }
  const plain = value.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : undefined;
}

function mapStatusToMessage(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return `Authentication failed (${status}). Check OPENARCHIVER_API_KEY and that it has the required permissions (search:archive, read:archive).`;
  }
  if (status === 404) {
    return "Not found (404). The email id or storage path does not exist.";
  }
  const detail = body.trim().slice(0, 300);
  return `OpenArchiver request failed (${status})${detail ? `: ${detail}` : ""}`;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Thin client over the OpenArchiver REST API. `fetch` is injectable for testing. */
export class OpenArchiverClient {
  constructor(
    private readonly apiBase: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  async search(params: SearchParams): Promise<SearchResponse> {
    const query = new URLSearchParams();
    query.set("keywords", params.keywords);
    if (params.page != null) query.set("page", String(params.page));
    if (params.limit != null) query.set("limit", String(params.limit));
    if (params.matchingStrategy) query.set("matchingStrategy", params.matchingStrategy);
    const res = await this.request(`/search?${query.toString()}`);
    return (await res.json()) as SearchResponse;
  }

  async getEmail(id: string): Promise<EmailDetail> {
    const res = await this.request(`/archived-emails/${encodeURIComponent(id)}`);
    return (await res.json()) as EmailDetail;
  }

  async download(path: string): Promise<DownloadResult> {
    const res = await this.request(`/storage/download?path=${encodeURIComponent(path)}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const filename =
      parseContentDispositionFilename(res.headers.get("content-disposition")) ??
      path.split("/").pop() ??
      "download";
    return {
      bytes,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      filename,
    };
  }

  private async request(pathAndQuery: string): Promise<Response> {
    const url = `${this.apiBase}${pathAndQuery}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { "X-API-KEY": this.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new OpenArchiverError(`Request to OpenArchiver failed: ${reason}`);
    }
    if (!res.ok) {
      throw new OpenArchiverError(mapStatusToMessage(res.status, await safeText(res)), res.status);
    }
    return res;
  }
}
