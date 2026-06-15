export interface OpenArchiverConfig {
  /** Effective API base, e.g. https://host/api/v1 (no trailing slash). */
  apiBase: string;
  apiKey: string;
  /** Request timeout in milliseconds. */
  timeoutMs: number;
}

/**
 * Normalize a configured base URL to the effective API base.
 * - strips trailing slashes
 * - appends `/api/v1` unless an `/api/v<n>` suffix is already present
 */
export function normalizeApiBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("OPENARCHIVER_BASE_URL is empty");
  }
  return /\/api\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/api/v1`;
}

/**
 * Load and validate configuration from the environment.
 * Throws with an actionable message when something is missing.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): OpenArchiverConfig {
  const baseUrl = env.OPENARCHIVER_BASE_URL?.trim();
  const apiKey = env.OPENARCHIVER_API_KEY?.trim();

  if (!baseUrl) {
    throw new Error(
      "OPENARCHIVER_BASE_URL is not set. Set it to your OpenArchiver instance URL, e.g. https://openarchiver.example.com",
    );
  }
  if (!apiKey) {
    throw new Error(
      "OPENARCHIVER_API_KEY is not set. Create an API key in OpenArchiver with search:archive and read:archive permissions.",
    );
  }

  const timeoutMs = Number.parseInt(env.OPENARCHIVER_TIMEOUT_MS ?? "", 10);

  return {
    apiBase: normalizeApiBase(baseUrl),
    apiKey,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000,
  };
}
