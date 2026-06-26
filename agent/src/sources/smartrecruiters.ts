/**
 * smartrecruiters.ts — the SmartRecruiters connector.
 *
 * SmartRecruiters exposes a public, read-only postings API per company (no auth):
 *   GET https://api.smartrecruiters.com/v1/companies/<handle>/postings?limit=<n>
 * Response envelope: { totalFound, content: [ { id, name, releasedDate, location, company } ] }.
 * The job TITLE is `name`; the public posting URL is jobs.smartrecruiters.com/<identifier>/<id>.
 *
 * The list endpoint omits the description, so jdText is left empty (the title prefilter still
 * applies, and the full JD is fetched later at tailoring time). A 404/400 (bad/unknown handle)
 * is treated as "no jobs"; other errors propagate for the orchestrator to log + retry.
 *
 * NOTE: SmartRecruiters apply forms are NOT a validated Playwright filler, so the guardrail
 * ATS allowlist (greenhouse/lever/ashby) blocks auto-submit — these are clean-SOURCE / attended-APPLY.
 *
 * Contract: implements `Connector` from ../types.js (company, opts) => Promise<SourcedJob[]>.
 */

import { fetchJson, titleMatchesKeywords, HttpError, DEFAULT_TIMEOUT_MS } from "./http.js";
import type { Connector, SourcedJob } from "../types.js";

interface SrLocation {
  city?: string;
  region?: string;
  country?: string;
  remote?: boolean;
  fullLocation?: string;
}
interface SrPosting {
  id?: string;
  name?: string;
  releasedDate?: string;
  location?: SrLocation;
  company?: { identifier?: string };
}
interface SrResponse {
  totalFound?: number;
  content?: SrPosting[];
}

function endpoint(handle: string, limit: number): string {
  return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(handle)}/postings?limit=${limit}&offset=0`;
}

function locStr(l?: SrLocation): string {
  if (!l) return "";
  if (l.fullLocation) return l.fullLocation;
  return [l.city, l.region, l.country].filter(Boolean).join(", ");
}

function toJob(p: SrPosting, handle: string, company: string): SourcedJob | null {
  const title = (p.name ?? "").trim();
  const id = p.id;
  if (!title || !id) return null;
  const ident = p.company?.identifier ?? handle;
  return {
    source: "smartrecruiters",
    ats: "smartrecruiters",
    company,
    title,
    location: locStr(p.location),
    remote: p.location?.remote === true ? true : p.location ? false : null,
    url: `https://jobs.smartrecruiters.com/${ident}/${id}`,
    jdText: "",
    postedAt: p.releasedDate ?? null,
  };
}

export const fetchSmartRecruiters: Connector = async (company, opts): Promise<SourcedJob[]> => {
  const handle = company.handle?.trim();
  if (!handle) return [];

  const limit = Math.max(1, Math.min(100, opts.limitPerCompany ?? 100));
  let body: SrResponse;
  try {
    body = await fetchJson<SrResponse>(endpoint(handle, limit), { timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 400)) return [];
    throw err;
  }

  const content = Array.isArray(body.content) ? body.content : [];
  const jobs: SourcedJob[] = [];
  for (const p of content) {
    const title = (p?.name ?? "").trim();
    if (!title || !titleMatchesKeywords(title, opts.titleKeywords)) continue;
    const job = toJob(p, handle, company.name);
    if (job) jobs.push(job);
  }
  return jobs;
};
