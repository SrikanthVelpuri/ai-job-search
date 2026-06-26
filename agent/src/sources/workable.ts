/**
 * workable.ts — the Workable connector.
 *
 * Workable exposes a public board feed per company (no auth) via a POST:
 *   POST https://apply.workable.com/api/v3/accounts/<handle>/jobs   body: {}
 * Response: { total, results: [ { shortcode, title, remote, location:{country,city,region}, published } ] }.
 * Public posting URL: apply.workable.com/<handle>/j/<shortcode>/.
 *
 * The list endpoint omits the description, so jdText is left empty (title prefilter still applies;
 * full JD fetched later at tailoring). A non-2xx (bad/unknown handle) yields no jobs.
 *
 * NOTE: Workable apply forms are NOT a validated Playwright filler, so the guardrail ATS allowlist
 * (greenhouse/lever/ashby) blocks auto-submit — clean-SOURCE / attended-APPLY (e.g. Hugging Face).
 *
 * Contract: implements `Connector` from ../types.js (company, opts) => Promise<SourcedJob[]>.
 */

import { titleMatchesKeywords, DEFAULT_TIMEOUT_MS } from "./http.js";
import type { Connector, SourcedJob } from "../types.js";

const USER_AGENT = "ai-job-search/0.1 job-sourcing-bot";

interface WkLocation {
  country?: string;
  city?: string;
  region?: string;
}
interface WkJob {
  shortcode?: string;
  title?: string;
  remote?: boolean;
  location?: WkLocation;
  published?: string;
  state?: string;
}
interface WkResponse {
  total?: number;
  results?: WkJob[];
}

/** Workable's job list is a POST, so we can't use the GET-only http.ts spine. */
async function postJobs(handle: string, timeoutMs: number): Promise<WkResponse | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://apply.workable.com/api/v3/accounts/${encodeURIComponent(handle)}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT, Accept: "application/json" },
      body: JSON.stringify({ query: "", location: [], department: [], worktype: [], remote: [] }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as WkResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function locStr(l?: WkLocation): string {
  if (!l) return "";
  return [l.city, l.region, l.country].filter(Boolean).join(", ");
}

export const fetchWorkable: Connector = async (company, opts): Promise<SourcedJob[]> => {
  const handle = company.handle?.trim();
  if (!handle) return [];

  const body = await postJobs(handle, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const results = body && Array.isArray(body.results) ? body.results : [];
  const limit = opts.limitPerCompany ?? Infinity;

  const jobs: SourcedJob[] = [];
  for (const j of results) {
    if (jobs.length >= limit) break;
    const title = (j?.title ?? "").trim();
    const code = j?.shortcode;
    if (!title || !code || !titleMatchesKeywords(title, opts.titleKeywords)) continue;
    jobs.push({
      source: "workable",
      ats: "workable",
      company: company.name,
      title,
      location: locStr(j.location),
      remote: j.remote === true ? true : j.location ? false : null,
      url: `https://apply.workable.com/${handle}/j/${code}/`,
      jdText: "",
      postedAt: j.published ?? null,
    });
  }
  return jobs;
};
