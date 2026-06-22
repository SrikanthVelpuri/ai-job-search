/**
 * greenhouse.ts — the Greenhouse Job Board connector.
 *
 * Greenhouse exposes a fully public, read-only JSON board API (no auth):
 *
 *   https://boards-api.greenhouse.io/v1/boards/{handle}/jobs?content=true
 *
 * `{handle}` is the board token stored on a WatchlistCompany.handle. With `content=true`
 * the list response embeds each job's full description, so we usually need ONE request
 * per company. The catch: the embedded `content` is HTML that has itself been
 * HTML-entity-encoded (e.g. `&lt;p&gt;Hello&lt;/p&gt;`), so it must be entity-decoded
 * back into real markup BEFORE tag-stripping. A few boards omit content on the list
 * endpoint; for those we fall back to the per-job detail endpoint.
 *
 * This connector implements the shared `Connector` contract (types.ts §connector) and
 * leans on the http.ts spine for fetching + stripping. It does no scraping and respects
 * the politeness caps in ConnectorOptions.
 *
 * Design refs: design/design.md §2.2 (clean_ats tier), §2.3 (title prefilter).
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

// ── Raw API shapes ────────────────────────────────────────────────────────────
// Only the fields we consume are declared; everything is optional/loose because the
// payload is external and "noUncheckedIndexedAccess" means we must guard anyway.

interface GhOffice {
  name?: string | null;
}

interface GhDepartment {
  name?: string | null;
}

interface GhJob {
  id?: number | string;
  title?: string | null;
  location?: { name?: string | null } | null;
  absolute_url?: string | null;
  /** HTML, HTML-entity-encoded. May be absent/empty on some boards. */
  content?: string | null;
  updated_at?: string | null;
  first_published?: string | null;
  offices?: GhOffice[] | null;
  departments?: GhDepartment[] | null;
}

interface GhListResponse {
  jobs?: GhJob[] | null;
}

/** Base URL for a board's jobs listing (content embedded). */
function listUrl(handle: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(handle)}/jobs?content=true`;
}

/** Base URL for a single job's detail (used only when list content is empty). */
function detailUrl(handle: string, id: number | string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(handle)}/jobs/${encodeURIComponent(String(id))}`;
}

/**
 * Decode the named + numeric HTML entities that wrap Greenhouse `content`.
 * The payload is entity-encoded HTML (`&lt;p&gt;` etc.), so we reverse that one layer
 * to recover real tags; stripHtml() then removes the tags and tidies whitespace.
 * `&amp;` is decoded LAST so a literal `&amp;lt;` does not collapse into `<`.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/gi, "&");
}

/** True when a location string looks remote. */
function isRemote(loc: string): boolean {
  return /remote/i.test(loc);
}

/** Resolve a job's display location: location.name → first office name → "". */
function resolveLocation(job: GhJob): string {
  const locName = job.location?.name?.trim();
  if (locName) return locName;
  const offices = job.offices ?? [];
  const first = offices[0]; // guarded: noUncheckedIndexedAccess
  const officeName = first?.name?.trim();
  return officeName ?? "";
}

/** First non-empty ISO date among first_published / updated_at, else null. */
function resolvePostedAt(job: GhJob): string | null {
  const fp = job.first_published?.trim();
  if (fp) return fp;
  const ua = job.updated_at?.trim();
  return ua && ua.length > 0 ? ua : null;
}

/**
 * Turn list `content` (entity-encoded HTML) into plain text. If empty, fetch the
 * per-job detail endpoint (same encoding) as a fallback. Returns "" if still empty.
 */
async function resolveJdText(
  handle: string,
  job: GhJob,
  timeoutMs: number,
): Promise<string> {
  const raw = job.content?.trim();
  if (raw) return stripHtml(decodeEntities(raw));

  // Fallback: some boards do not embed content on the list endpoint.
  const id = job.id;
  if (id === undefined || id === null) return "";
  try {
    const detail = await fetchJson<GhJob>(detailUrl(handle, id), { timeoutMs });
    const detailContent = detail.content?.trim();
    return detailContent ? stripHtml(decodeEntities(detailContent)) : "";
  } catch {
    // Detail fetch is best-effort; a missing JD must not abort the whole company.
    return "";
  }
}

/**
 * fetchGreenhouse — fetch + normalize + title-filter a single company's Greenhouse board.
 *
 * Behaviour:
 *  - One GET to the list endpoint (content embedded).
 *  - Keep only jobs whose title matches opts.titleKeywords (titleMatchesKeywords).
 *  - Normalize each kept job into a SourcedJob (source/ats = "greenhouse").
 *  - Honour opts.limitPerCompany (cap AFTER filtering) and opts.timeoutMs.
 *  - HttpError 404 (bad/unknown handle) → return [] (do NOT throw). Every other
 *    error (network, 5xx, JSON parse) propagates so the caller can log/retry.
 */
export const fetchGreenhouse: Connector = async (
  company: WatchlistCompany,
  opts: ConnectorOptions,
): Promise<SourcedJob[]> => {
  const handle = company.handle?.trim();
  // No handle → nothing we can fetch. Treat like an empty board rather than throwing.
  if (!handle) return [];

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let data: GhListResponse;
  try {
    data = await fetchJson<GhListResponse>(listUrl(handle), { timeoutMs });
  } catch (err) {
    // A 404 means the board token does not exist — expected for stale handles.
    if (err instanceof HttpError && err.status === 404) return [];
    throw err; // network / 5xx / parse errors are real failures the caller handles.
  }

  const jobs = data.jobs ?? [];
  const limit = opts.limitPerCompany;
  const out: SourcedJob[] = [];

  for (const job of jobs) {
    const title = job.title?.trim();
    if (!title) continue; // can't dedup/score a titleless row.
    if (!titleMatchesKeywords(title, opts.titleKeywords)) continue;

    const url = job.absolute_url?.trim();
    if (!url) continue; // without an apply URL the row is useless downstream.

    const location = resolveLocation(job);
    const jdText = await resolveJdText(handle, job, timeoutMs);

    out.push({
      source: "greenhouse",
      ats: "greenhouse",
      company: company.name,
      title,
      location,
      remote: isRemote(location) ? true : null,
      url,
      jdText,
      postedAt: resolvePostedAt(job),
    });

    // Cap AFTER filtering so the limit counts relevant jobs, not raw board size.
    if (limit !== undefined && out.length >= limit) break;
  }

  return out;
};
