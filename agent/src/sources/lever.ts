/**
 * lever.ts — the Lever connector.
 *
 * Lever exposes a fully public, read-only postings feed per company:
 *   GET https://api.lever.co/v0/postings/<handle>?mode=json
 * The response is a flat ARRAY of posting objects (no envelope/pagination). We normalize
 * each posting into a `SourcedJob`, filter by the caller's title keywords, and cap the
 * result count for politeness/perf. A 404 (handle not on Lever) is treated as "no jobs";
 * any other transport/HTTP error propagates so the orchestrator can log + retry.
 *
 * Contract: implements `Connector` from ../types.js (company, opts) => Promise<SourcedJob[]>.
 */

import { fetchJson, stripHtml, titleMatchesKeywords, HttpError, DEFAULT_TIMEOUT_MS } from "./http.js";
import type { Connector, SourcedJob, WatchlistCompany, ConnectorOptions } from "../types.js";

/**
 * Shape of a single Lever posting (subset of fields we consume). Everything is optional
 * because the public feed is schemaless from our perspective — we narrow defensively.
 */
interface LeverPosting {
  id?: string;
  /** Lever stores the job TITLE in `text`, not a `title` field. */
  text?: string;
  categories?: {
    location?: string;
    team?: string;
    commitment?: string;
    allLocations?: string[];
  };
  hostedUrl?: string;
  applyUrl?: string;
  /** Plain-text description (preferred for jdText). */
  descriptionPlain?: string;
  /** HTML description (fallback, stripped if descriptionPlain is absent). */
  description?: string;
  /** Epoch milliseconds when the posting was created. */
  createdAt?: number;
  /** 'remote' | 'on-site' | 'hybrid' (observed live: also 'onsite'). */
  workplaceType?: string;
}

/** Build the public postings endpoint for a given Lever handle. */
function endpoint(handle: string): string {
  return `https://api.lever.co/v0/postings/${encodeURIComponent(handle)}?mode=json`;
}

/**
 * Derive the `remote` tri-state for a posting:
 *  - workplaceType === 'remote'           → true
 *  - workplaceType present but not remote  → false (on-site/hybrid)
 *  - workplaceType absent                  → infer from the location string (/remote/i), else null
 */
function deriveRemote(workplaceType: string | undefined, location: string): boolean | null {
  if (workplaceType === "remote") return true;
  if (workplaceType) return false;
  return /remote/i.test(location) ? true : null;
}

/** Convert one raw Lever posting into a normalized SourcedJob, or null if unusable. */
function toSourcedJob(p: LeverPosting, company: string): SourcedJob | null {
  const title = (p.text ?? "").trim();
  // A posting with no title or no apply/posting URL is not actionable downstream.
  const url = p.hostedUrl ?? p.applyUrl ?? "";
  if (!title || !url) return null;

  const location = p.categories?.location ?? "";
  // Prefer the plain-text description; fall back to stripping the HTML one.
  const jdText = p.descriptionPlain && p.descriptionPlain.trim().length > 0
    ? p.descriptionPlain
    : stripHtml(p.description ?? "");

  // createdAt is epoch ms; guard against missing/NaN before constructing a Date.
  const postedAt =
    typeof p.createdAt === "number" && Number.isFinite(p.createdAt)
      ? new Date(p.createdAt).toISOString()
      : null;

  return {
    source: "lever",
    ats: "lever",
    company,
    title,
    location,
    remote: deriveRemote(p.workplaceType, location),
    url,
    jdText,
    postedAt,
  };
}

/**
 * fetchLever — Connector for Lever-hosted boards.
 *
 * Fetches all postings for `company.handle`, keeps those whose title matches any of
 * `opts.titleKeywords`, and returns up to `opts.limitPerCompany` normalized jobs.
 * Returns [] when the handle is missing or 404s; rethrows other errors.
 */
export const fetchLever: Connector = async (
  company: WatchlistCompany,
  opts: ConnectorOptions,
): Promise<SourcedJob[]> => {
  const handle = company.handle?.trim();
  if (!handle) return []; // No Lever handle configured → nothing to fetch.

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let postings: LeverPosting[];
  try {
    postings = await fetchJson<LeverPosting[]>(endpoint(handle), { timeoutMs });
  } catch (err) {
    // A 404 means this org is not on Lever (or the slug is wrong) → treat as no jobs.
    if (err instanceof HttpError && err.status === 404) return [];
    throw err;
  }

  // The feed is a flat array; if a misconfigured handle yields a non-array, bail safely.
  if (!Array.isArray(postings)) return [];

  const limit = opts.limitPerCompany ?? Infinity;
  const jobs: SourcedJob[] = [];

  for (const p of postings) {
    if (jobs.length >= limit) break;
    // Filter on the raw title before normalizing (cheaper, same source field).
    const title = (p?.text ?? "").trim();
    if (!title || !titleMatchesKeywords(title, opts.titleKeywords)) continue;

    const job = toSourcedJob(p, company.name);
    if (job) jobs.push(job);
  }

  return jobs;
};
