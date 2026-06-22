/**
 * ashby.ts — the Ashby ATS connector.
 *
 * Ashby exposes a fully public, unauthenticated job-board posting API:
 *   GET https://api.ashbyhq.com/posting-api/job-board/{handle}?includeCompensation=true
 * where {handle} is the org slug (the same slug seen in jobs.ashbyhq.com/<handle>).
 *
 * The endpoint returns every posting for the board in one shot (no pagination), so the
 * connector simply fetches, filters and maps to the shared `SourcedJob` shape. A 404 means
 * the handle does not exist (or the board is private) → we return [] so the orchestrator can
 * move on rather than aborting the whole sourcing run.
 *
 * Implements the `Connector` contract from types.ts.
 */

import type {
  Connector,
  ConnectorOptions,
  SourcedJob,
  WatchlistCompany,
} from "../types.js";
import {
  DEFAULT_TIMEOUT_MS,
  HttpError,
  fetchJson,
  stripHtml,
  titleMatchesKeywords,
} from "./http.js";

/** Base URL for the public Ashby posting API. */
const ASHBY_API_BASE = "https://api.ashbyhq.com/posting-api/job-board";

/**
 * One posting as returned by the Ashby posting API. Every field is optional /
 * defensively typed because this is an external payload we do not control —
 * "noUncheckedIndexedAccess" + "strict" force us to narrow before use anyway.
 */
interface AshbyJob {
  id?: string;
  title?: string;
  location?: string;
  /** true=remote, false=onsite, null/absent=unknown. */
  isRemote?: boolean | null;
  employmentType?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  publishedAt?: string;
  /** Unlisted postings are hidden on the public board → we drop them. */
  isListed?: boolean;
  address?: unknown;
  secondaryLocations?: unknown[];
}

/** Top-level shape of the posting-api response. */
interface AshbyResponse {
  jobs?: AshbyJob[];
}

/**
 * Resolve the remote flag per spec:
 *   isRemote===true               → true
 *   else /remote/i in location    → true
 *   else                          → false
 * (Note: this deliberately never returns null — an absent/unknown isRemote that also lacks a
 * "remote" location token is treated as onsite=false, matching the build spec exactly.)
 */
function resolveRemote(isRemote: boolean | null | undefined, location: string): boolean {
  if (isRemote === true) return true;
  return /remote/i.test(location);
}

/** Map one raw Ashby posting to a normalized SourcedJob. Returns null if it has no usable URL. */
function mapJob(company: string, raw: AshbyJob): SourcedJob | null {
  const title = raw.title ?? "";
  const location = raw.location ?? "";
  // Canonical apply/posting URL: prefer the human-facing jobUrl, fall back to applyUrl.
  const url = raw.jobUrl || raw.applyUrl || "";
  if (!url) return null; // unusable without a destination — skip rather than store a blank.

  // Plain text is preferred; fall back to stripping the HTML body when absent.
  const jdText = raw.descriptionPlain || stripHtml(raw.descriptionHtml ?? "");

  return {
    source: "ashby",
    ats: "ashby",
    company,
    title,
    location,
    remote: resolveRemote(raw.isRemote, location),
    url,
    jdText,
    postedAt: raw.publishedAt || null,
  };
}

/**
 * fetchAshby — Connector implementation for Ashby boards.
 *
 * Behavior:
 *  - Requires `company.handle`; without it there is no board to query → [].
 *  - Fetches the full board, keeps only listed postings (isListed !== false).
 *  - Title-filters against opts.titleKeywords (case-insensitive substring).
 *  - Caps the result at opts.limitPerCompany when provided.
 *  - 404 (unknown/private board) → [] so the orchestrator skips gracefully.
 *  - Any other HTTP error or timeout propagates to the caller.
 */
export const fetchAshby: Connector = async (
  company: WatchlistCompany,
  opts: ConnectorOptions,
): Promise<SourcedJob[]> => {
  const handle = company.handle?.trim();
  if (!handle) return []; // no board slug configured → nothing to fetch.

  const url = `${ASHBY_API_BASE}/${encodeURIComponent(handle)}?includeCompensation=true`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let data: AshbyResponse;
  try {
    data = await fetchJson<AshbyResponse>(url, { timeoutMs });
  } catch (err) {
    // A missing/private board is an expected, non-fatal outcome — return [] for 404.
    if (err instanceof HttpError && err.status === 404) return [];
    throw err;
  }

  const rawJobs = Array.isArray(data.jobs) ? data.jobs : [];
  const out: SourcedJob[] = [];

  for (const raw of rawJobs) {
    // Drop explicitly unlisted postings (isListed === false). Absent/true are kept.
    if (raw.isListed === false) continue;

    // Title keyword gate (skip when no keywords were supplied).
    if (opts.titleKeywords.length > 0 && !titleMatchesKeywords(raw.title ?? "", opts.titleKeywords)) {
      continue;
    }

    const job = mapJob(company.name, raw);
    if (job === null) continue;

    out.push(job);

    // Politeness/perf cap — stop once we have enough for this company.
    if (opts.limitPerCompany !== undefined && out.length >= opts.limitPerCompany) break;
  }

  return out;
};
