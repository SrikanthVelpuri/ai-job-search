/**
 * adzuna.ts — the Adzuna cross-company aggregator connector (design §2.2 supplement).
 *
 * Unlike the per-company ATS connectors (greenhouse/lever/ashby) which take a
 * `WatchlistCompany`, Adzuna is a *cross-company* search aggregator: it takes a
 * free-text query and returns matching postings from many employers at once.
 * Hence it implements `AggregatorConnector` (types.ts), not `Connector`.
 *
 * Endpoint (public, API key required — read-only GET):
 *   https://api.adzuna.com/v1/api/jobs/us/search/1
 *     ?app_id={id}&app_key={key}&what={query}
 *     &results_per_page={n}&content-type=application/json
 *
 * Docs: https://developer.adzuna.com/docs/search
 *
 * The key is *required*. Per the build contract the orchestrator catches and skips
 * a missing-key throw, so we fail fast (and clearly) rather than hitting the network
 * without credentials.
 */

import { fetchJson, stripHtml, titleMatchesKeywords, DEFAULT_TIMEOUT_MS } from "./http.js";
import type { AggregatorConnector, SourcedJob } from "../types.js";

/** US search endpoint, page 1. We only ever pull the first page (one polite request). */
const ADZUNA_BASE = "https://api.adzuna.com/v1/api/jobs/us/search/1";

/** Adzuna hard-caps and we politely cap `results_per_page` at this value. */
const RESULTS_PER_PAGE_CAP = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Response shape (only the fields we consume; everything is optional/unknown-safe
// because Adzuna omits empty fields and noUncheckedIndexedAccess is on).
// ─────────────────────────────────────────────────────────────────────────────

interface AdzunaCompany {
  display_name?: string;
}

interface AdzunaLocation {
  display_name?: string;
  area?: string[];
}

interface AdzunaResult {
  title?: string;
  company?: AdzunaCompany;
  location?: AdzunaLocation;
  redirect_url?: string;
  description?: string;
  /** ISO 8601 timestamp. */
  created?: string;
  salary_min?: number;
  salary_max?: number;
  contract_time?: string;
}

interface AdzunaResponse {
  results?: AdzunaResult[];
}

/**
 * fetchAdzuna — query Adzuna's US search API and normalize hits into `SourcedJob`s.
 *
 * @param query  free-text search term (e.g. "machine learning engineer"); URL-encoded here.
 * @param opts   ConnectorOptions plus the required Adzuna credentials and optional resultsPerPage.
 * @throws Error if the API key id/key is missing or empty (no network call is made).
 */
export const fetchAdzuna: AggregatorConnector = async (query, opts): Promise<SourcedJob[]> => {
  const { adzunaAppId, adzunaAppKey, titleKeywords, timeoutMs } = opts;

  // Hard guard: never touch the network without credentials. The orchestrator
  // catches this and skips the Adzuna lane gracefully.
  if (!adzunaAppId?.trim() || !adzunaAppKey?.trim()) {
    throw new Error("Adzuna API key not configured (set ADZUNA_APP_ID / ADZUNA_APP_KEY)");
  }

  // Clamp results_per_page to [1, 50]; Adzuna rejects/ignores larger values.
  const requested = opts.resultsPerPage ?? RESULTS_PER_PAGE_CAP;
  const resultsPerPage = Math.max(1, Math.min(RESULTS_PER_PAGE_CAP, Math.trunc(requested)));

  // Build the URL with every value URL-encoded (the query especially).
  const params = new URLSearchParams({
    app_id: adzunaAppId.trim(),
    app_key: adzunaAppKey.trim(),
    what: query,
    results_per_page: String(resultsPerPage),
    "content-type": "application/json",
  });
  const url = `${ADZUNA_BASE}?${params.toString()}`;

  const body = await fetchJson<AdzunaResponse>(url, {
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  const results = body.results ?? [];
  const jobs: SourcedJob[] = [];

  for (const r of results) {
    // Adzuna sometimes returns sparse rows; skip anything with no usable title/url.
    const title = r.title?.trim();
    const url2 = r.redirect_url?.trim();
    if (!title || !url2) continue;

    // Keyword prefilter on the title (case-insensitive substring match).
    if (titleKeywords.length > 0 && !titleMatchesKeywords(title, titleKeywords)) continue;

    const location = r.location?.display_name?.trim() ?? "";
    const company = r.company?.display_name?.trim() || "Unknown";

    // Remote heuristic: "remote" appearing in the title or location text.
    const remote = /remote/i.test(`${title} ${location}`) ? true : null;

    jobs.push({
      source: "adzuna",
      ats: "other",
      company,
      title,
      location,
      remote,
      url: url2,
      jdText: stripHtml(r.description ?? ""),
      // Adzuna `created` is already ISO 8601; null when absent.
      postedAt: r.created?.trim() || null,
    });
  }

  return jobs;
};
