/**
 * sources/index.ts — sourcing orchestration (plan Phase 1, design §2.2).
 *
 * Walks the watchlist, dispatches each enabled company to the right ATS connector, applies the
 * hard pre-filter (H-1B sponsorship / citizenship / clearance / exclude-list — design §2.3),
 * and dedup-inserts survivors into the tracker. Adzuna runs as an optional cross-company
 * supplement when a key is configured.
 */

import type {
  AppConfig,
  Connector,
  Profile,
  SourcedJob,
  Watchlist,
  WatchlistCompany,
} from "../types.js";
import type { Tracker } from "../tracker/db.js";
import { DEFAULT_TITLE_KEYWORDS } from "../config.js";
import { prefilter } from "../scoring/filters.js";
import { fetchGreenhouse } from "./greenhouse.js";
import { fetchLever } from "./lever.js";
import { fetchAshby } from "./ashby.js";
import { fetchSmartRecruiters } from "./smartrecruiters.js";
import { fetchWorkable } from "./workable.js";
import { fetchAdzuna } from "./adzuna.js";

/**
 * ATS → connector. Greenhouse/Lever/Ashby/SmartRecruiters/Workable all expose public board
 * APIs we can source from. (SmartRecruiters/Workable have no validated apply filler yet, so the
 * guardrail allowlist blocks auto-submit — clean-source / attended-apply.) Workday / custom-site
 * (`other`) have no clean API connector in v1.
 */
const CONNECTORS: Partial<Record<string, Connector>> = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  smartrecruiters: fetchSmartRecruiters,
  workable: fetchWorkable,
};

export interface CompanySourceResult {
  company: string;
  ats: string;
  fetched: number;
  inserted: number;
  duplicates: number;
  prefilteredOut: number;
  error?: string;
}

export interface SourceRunResult {
  companies: CompanySourceResult[];
  adzuna?: { queries: string[]; fetched: number; inserted: number; prefilteredOut: number; error?: string };
  totals: { fetched: number; inserted: number; duplicates: number; prefilteredOut: number; errors: number };
}

export interface SourceOptions {
  titleKeywords?: string[];
  limitPerCompany?: number;
  timeoutMs?: number;
  /** Run the Adzuna supplement if a key is configured. */
  includeAdzuna?: boolean;
  /** Free-text queries for Adzuna; defaults to the profile's target titles. */
  adzunaQueries?: string[];
}

/** Insert one connector's jobs into the tracker, applying the hard pre-filter first. */
function ingestJobs(tracker: Tracker, profile: Profile, jobs: SourcedJob[]): { inserted: number; duplicates: number; prefilteredOut: number } {
  let inserted = 0;
  let duplicates = 0;
  let prefilteredOut = 0;
  for (const job of jobs) {
    const pf = prefilter(job, profile);
    if (!pf.pass) {
      prefilteredOut++;
      continue;
    }
    const res = tracker.upsertJob(job);
    if (res.inserted) inserted++;
    else duplicates++;
  }
  return { inserted, duplicates, prefilteredOut };
}

/**
 * Source every enabled watchlist company + optional Adzuna. Connector errors are caught
 * per-company so one bad endpoint never aborts the run.
 */
export async function sourceAll(
  tracker: Tracker,
  watchlist: Watchlist,
  profile: Profile,
  config: AppConfig,
  opts: SourceOptions = {},
): Promise<SourceRunResult> {
  const titleKeywords = opts.titleKeywords ?? DEFAULT_TITLE_KEYWORDS;
  const connectorOpts = {
    titleKeywords,
    limitPerCompany: opts.limitPerCompany ?? 50,
    timeoutMs: opts.timeoutMs,
  };

  const companies: CompanySourceResult[] = [];
  for (const company of watchlist.companies) {
    if (!company.enabled) continue;
    const connector = CONNECTORS[company.ats];
    if (!connector) continue; // workday / custom_site sourced via Adzuna or attended
    const row: CompanySourceResult = {
      company: company.name,
      ats: company.ats,
      fetched: 0,
      inserted: 0,
      duplicates: 0,
      prefilteredOut: 0,
    };
    try {
      const jobs = await connector(company as WatchlistCompany, connectorOpts);
      row.fetched = jobs.length;
      const ing = ingestJobs(tracker, profile, jobs);
      row.inserted = ing.inserted;
      row.duplicates = ing.duplicates;
      row.prefilteredOut = ing.prefilteredOut;
      tracker.logEvent("info", `sourced ${company.name} (${company.ats}): ${ing.inserted} new / ${row.fetched} fetched`, "custom");
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
      tracker.logEvent("warn", `source error for ${company.name}: ${row.error}`, "custom");
    }
    companies.push(row);
  }

  // Optional Adzuna cross-company supplement (design §2.2).
  let adzuna: SourceRunResult["adzuna"];
  if (opts.includeAdzuna && config.adzunaAppId && config.adzunaAppKey) {
    const queries = opts.adzunaQueries ?? profile.preferences.titles.slice(0, 5);
    adzuna = { queries, fetched: 0, inserted: 0, prefilteredOut: 0 };
    try {
      for (const q of queries) {
        const jobs = await fetchAdzuna(q, {
          titleKeywords,
          adzunaAppId: config.adzunaAppId,
          adzunaAppKey: config.adzunaAppKey,
          resultsPerPage: 50,
          timeoutMs: opts.timeoutMs,
        });
        adzuna.fetched += jobs.length;
        const ing = ingestJobs(tracker, profile, jobs);
        adzuna.inserted += ing.inserted;
        adzuna.prefilteredOut += ing.prefilteredOut;
      }
      tracker.logEvent("info", `adzuna: ${adzuna.inserted} new across ${queries.length} queries`, "custom");
    } catch (err) {
      adzuna.error = err instanceof Error ? err.message : String(err);
      tracker.logEvent("warn", `adzuna error: ${adzuna.error}`, "custom");
    }
  }

  const totals = companies.reduce(
    (acc, c) => ({
      fetched: acc.fetched + c.fetched,
      inserted: acc.inserted + c.inserted,
      duplicates: acc.duplicates + c.duplicates,
      prefilteredOut: acc.prefilteredOut + c.prefilteredOut,
      errors: acc.errors + (c.error ? 1 : 0),
    }),
    { fetched: 0, inserted: 0, duplicates: 0, prefilteredOut: 0, errors: 0 },
  );
  if (adzuna) {
    totals.fetched += adzuna.fetched;
    totals.inserted += adzuna.inserted;
    totals.prefilteredOut += adzuna.prefilteredOut;
    if (adzuna.error) totals.errors++;
  }

  tracker.touchLane("custom");
  return { companies, adzuna, totals };
}
