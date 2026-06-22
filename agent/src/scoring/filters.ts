/**
 * filters.ts — HARD pre-filters that run BEFORE the heuristic/LLM scorer (design §2.3, plan §6.1).
 *
 * The candidate is on H-1B and REQUIRES visa sponsorship, so any posting that can be
 * read — from clear textual signals only — as citizenship-only, clearance-gated,
 * explicitly no-sponsorship, an excluded company, or obviously junior, is dropped at
 * this gate and never reaches scoring/tailoring/apply.
 *
 * Design philosophy: be CONSERVATIVE. A false negative here (dropping a good job) is
 * worse than a false positive (letting a borderline job through to scoring, which can
 * then down-rank it). Therefore an `unknown` sponsorship signal KEEPS the job, and any
 * ambiguous salary parse is treated as "not below floor".
 *
 * Everything operates on lowercased `title` + `jdText`, never on external lookups, so
 * the result is deterministic and cheap (this runs on every sourced posting).
 */

import type { JobRow, PrefilterResult, Profile, SourcedJob } from "../types.js";
import { SENIORITY_TOKENS } from "../config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Regex signals — kept as module constants so they compile once.
// Sources: design §2.3 disqualifier list + the candidate's dealbreakers.
// ─────────────────────────────────────────────────────────────────────────────

/** Postings that require US citizenship — an H-1B holder cannot satisfy these. */
const CITIZENSHIP_RE = /US citizen|U\.S\. citizen|must be a citizen|citizenship (is )?required/i;

/** Postings gated on a government security clearance. */
const CLEARANCE_RE = /security clearance|active clearance|TS\/SCI|secret clearance|polygraph/i;

/**
 * Explicit "we will NOT sponsor" language. Matching this is a hard fail.
 * Note `без` (Russian "without") is carried over from the design spec's signal list as a
 * defensive catch for occasional non-English boilerplate; harmless if it never fires.
 */
const NO_SPONSORSHIP_RE =
  /no (visa )?sponsorship|not (able|willing) to sponsor|unable to sponsor|sponsorship (is )?not (available|provided)|без|will not sponsor/i;

/** Positive sponsorship language (or an explicit H-1B mention) — informational boost only. */
const SPONSORS_RE =
  /sponsor(ship)? (available|provided|offered)|will sponsor|visa sponsorship( is)? available|h-?1b/i;

/** Clearly junior / non-senior titles — a hard fail for a senior/staff search. */
const JUNIOR_TITLE_RE = /intern|internship|junior|new grad|entry[- ]level|apprentice/i;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonicalize a company name for exclusion matching: lowercase, drop common corporate
 * suffixes and punctuation, collapse whitespace. So "Amazon", "Amazon.com, Inc." and
 * "AMAZON Web Services" all reduce to a stable core ("amazon" / "amazon web services").
 */
function canonicalCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|gmbh|plc|sa|ag|nv|the)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True if `company` canonical-matches any name in `excludeCompanies`. We treat it as a
 * match when either canonical name contains the other (so "Amazon" excludes "Amazon Web
 * Services", and a watchlist entry "Amazon Web Services" still excludes a bare "Amazon").
 */
function isExcludedCompany(company: string, excludeCompanies: string[]): boolean {
  const target = canonicalCompany(company);
  if (target === "") return false;
  return excludeCompanies.some((ex) => {
    const c = canonicalCompany(ex);
    if (c === "") return false;
    return target === c || target.includes(c) || c.includes(target);
  });
}

/** True if the title contains any seniority token (case-insensitive substring). */
function titleHasSeniority(title: string): boolean {
  const t = title.toLowerCase();
  // SENIORITY_TOKENS includes variants like "sr." and "sr " so we match raw substrings.
  return SENIORITY_TOKENS.some((tok) => t.includes(tok.toLowerCase()));
}

/**
 * Best-effort extraction of the *maximum* USD salary figure mentioned in the text.
 * Handles "$120,000", "$120k", "120k", "$95,000 - $120,000" (takes the upper bound) and
 * bare "$95000". Returns null when nothing salary-like is found — callers MUST treat null
 * as "no information" and never as zero (otherwise every JD would fail the floor).
 *
 * This is deliberately simple: if we cannot parse confidently we return null so the
 * conservative default (do not filter) applies.
 */
function parseMaxSalaryUSD(text: string): number | null {
  const values: number[] = [];

  // $120,000 / $120000 / $95,000.50 — dollar-anchored, with optional thousands separators.
  const dollarRe = /\$\s?(\d{1,3}(?:,\d{3})+|\d{4,7})(?:\.\d+)?/g;
  for (const m of text.matchAll(dollarRe)) {
    const digits = m[1];
    if (digits === undefined) continue;
    const n = Number.parseInt(digits.replace(/,/g, ""), 10);
    if (Number.isFinite(n)) values.push(n);
  }

  // "$120k" / "120K" / "$95k" — the "k" suffix multiplies by 1000. Require a $ or word
  // boundary before the number to avoid matching things like "401k".
  const kRe = /(?:\$\s?|\b)(\d{2,4})(?:\.(\d))?\s?[kK]\b/g;
  for (const m of text.matchAll(kRe)) {
    const whole = m[1];
    if (whole === undefined) continue;
    const base = Number.parseInt(whole, 10);
    if (!Number.isFinite(base)) continue;
    // 401k / 403k retirement-plan noise: a bare 2-3 digit "k" with no $ that looks like a
    // plan number is below any realistic salary floor, so it cannot trigger a false fail
    // (we only ever fail when a parsed MAX is clearly below the floor). Keep it simple.
    const frac = m[2] !== undefined ? Number.parseInt(m[2], 10) / 10 : 0;
    values.push(Math.round((base + frac) * 1000));
  }

  if (values.length === 0) return null;
  return Math.max(...values);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run all hard pre-filters against a posting.
 *
 * `pass` is true only when NONE of the disqualifiers tripped. Every disqualifier that
 * trips also appends a human-readable line to `reasons` so the tracker/UI can explain
 * why a job was dropped. Informational fields (sponsorshipSignal, seniorityMatch) are
 * always populated regardless of pass/fail so downstream scoring can use them.
 *
 * Accepts either a freshly-sourced posting (`SourcedJob`) or a stored `JobRow` — only the
 * shared `SourcedJob` fields (company, title, jdText) are read.
 */
export function prefilter(job: SourcedJob | JobRow, profile: Profile): PrefilterResult {
  const reasons: string[] = [];

  // The signal regexes are all case-insensitive (/i), so we match against the raw
  // title + jdText concatenation. Company exclusion is canonicalized separately.
  const title = job.title ?? "";
  const jd = job.jdText ?? "";
  const text = `${title}\n${jd}`;

  // ── 1. Excluded company ─────────────────────────────────────────────────────
  const excludedCompany = isExcludedCompany(job.company ?? "", profile.preferences.excludeCompanies);
  if (excludedCompany) {
    reasons.push(`Company "${job.company}" is on the exclude list.`);
  }

  // ── 2. Citizenship requirement (H-1B cannot meet) ───────────────────────────
  const citizenshipRequired = CITIZENSHIP_RE.test(text);
  if (citizenshipRequired) {
    reasons.push("Posting requires US citizenship (candidate is on H-1B).");
  }

  // ── 3. Security clearance requirement ───────────────────────────────────────
  const clearanceRequired = CLEARANCE_RE.test(text);
  if (clearanceRequired) {
    reasons.push("Posting requires a security clearance.");
  }

  // ── 4. Sponsorship signal ───────────────────────────────────────────────────
  // no_sponsorship takes precedence over sponsors: if a JD both mentions h-1b AND says
  // "we do not sponsor", the explicit refusal wins (common boilerplate pairing).
  let sponsorshipSignal: PrefilterResult["sponsorshipSignal"] = "unknown";
  if (NO_SPONSORSHIP_RE.test(text)) {
    sponsorshipSignal = "no_sponsorship";
    reasons.push("Posting explicitly states no visa sponsorship (candidate needs sponsorship).");
  } else if (SPONSORS_RE.test(text)) {
    sponsorshipSignal = "sponsors";
  }

  // ── 5. Seniority ─────────────────────────────────────────────────────────────
  // seniorityMatch is INFORMATIONAL — many senior titles omit the word ("ML Engineer III").
  // We only HARD-fail when the title clearly signals a junior/intern role.
  const seniorityMatch = titleHasSeniority(title);
  const clearlyJunior = JUNIOR_TITLE_RE.test(title);
  if (clearlyJunior) {
    reasons.push(`Title "${job.title}" indicates a junior/intern/entry-level role.`);
  }

  // ── 6. Salary floor ──────────────────────────────────────────────────────────
  // Only fail when a floor is configured AND a parsed MAXIMUM salary is clearly below it.
  // Unknown/unparseable salary → false (do not over-filter), per the conservative rule.
  const floor = profile.preferences.salaryFloorUSD;
  let salaryBelowFloor = false;
  if (floor != null) {
    const maxSalary = parseMaxSalaryUSD(text);
    if (maxSalary != null && maxSalary < floor) {
      salaryBelowFloor = true;
      reasons.push(
        `Stated maximum salary ($${maxSalary.toLocaleString("en-US")}) is below the floor ($${floor.toLocaleString("en-US")}).`,
      );
    }
  }

  // `pass` = none of the hard disqualifiers tripped. seniorityMatch does NOT affect pass.
  const pass =
    !excludedCompany &&
    !citizenshipRequired &&
    !clearanceRequired &&
    sponsorshipSignal !== "no_sponsorship" &&
    !clearlyJunior &&
    !salaryBelowFloor;

  return {
    pass,
    reasons,
    sponsorshipSignal,
    seniorityMatch,
    excludedCompany,
    clearanceRequired,
    citizenshipRequired,
    salaryBelowFloor,
  };
}
