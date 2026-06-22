/**
 * http.ts — tiny shared fetch + HTML helpers for connectors.
 *
 * Connectors hit *public* job-board JSON endpoints (read-only GET). No auth, no scraping
 * of bot-hostile sites. A polite User-Agent + timeout is all that's needed.
 */

export const DEFAULT_TIMEOUT_MS = 15_000;

const USER_AGENT =
  "ai-job-search/0.1 (+https://github.com/SrikanthVelpuri/ai-job-search) job-sourcing-bot";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

async function request(url: string, timeoutMs: number, accept: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: accept },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new HttpError(`HTTP ${res.status} for ${url}`, res.status, url);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** GET a URL and parse JSON. Throws HttpError on non-2xx, AbortError on timeout. */
export async function fetchJson<T = unknown>(
  url: string,
  opts: { timeoutMs?: number; accept?: string } = {},
): Promise<T> {
  const res = await request(url, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.accept ?? "application/json");
  return (await res.json()) as T;
}

/** GET a URL and return raw text. */
export async function fetchText(url: string, opts: { timeoutMs?: number } = {}): Promise<string> {
  const res = await request(url, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, "text/html,application/json,*/*");
  return await res.text();
}

/** Strip HTML tags + decode the handful of entities ATS descriptions actually use. */
export function stripHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True if a normalized title contains any of the given keyword substrings (case-insensitive). */
export function titleMatchesKeywords(title: string, keywords: string[]): boolean {
  const t = title.toLowerCase();
  return keywords.some((k) => t.includes(k.toLowerCase()));
}
