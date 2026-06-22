/**
 * jobright.ts — Lane C ingester (plan Phase 5, design §4).
 *
 * Jobright has no public API, so the user manually exports their Jobright MATCH
 * LIST to CSV and we ingest it here. Unlike AIApply (an application *log*), a
 * Jobright export is a list of *matches the user has NOT yet applied to*. So each
 * ingested row becomes:
 *   - a `jobs` row (source 'jobright', ats inferred from the URL host), deduped on
 *     the cross-lane hash, and
 *   - an `applications` row in lane 'jobright' with status 'sourced' (a match — not
 *     a submitted application), carrying Jobright's match score as fitScore.
 *
 * ROUTING NOTE: these 'sourced' jobright rows are candidates for re-scoring and
 * promotion into Lane A (custom apply). That routing decision belongs to the
 * ORCHESTRATOR, not this ingester. This file only records the match faithfully;
 * it never scores, tailors, or applies.
 *
 * As with the AIApply lane, the CSV is user-exported and messy, so we use a small
 * self-contained RFC4180-ish parser (no csv dependency), match headers
 * case-insensitively with synonyms, tolerate missing/extra columns, and collect
 * malformed rows into `IngestResult.errors`.
 */

import fs from "node:fs";
import type { AtsKind, IngestResult, SourcedJob } from "../types.js";
import type { Tracker } from "../tracker/db.js";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal RFC4180-ish CSV parser (self-contained — kept local so this file does
// not depend on the AIApply lane). Handles quoted fields, embedded commas/newlines,
// doubled "" escapes, and CRLF/LF line endings.
// ─────────────────────────────────────────────────────────────────────────────

/** Parse CSV text into an array of string-cell rows. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  // Strip a leading UTF-8 BOM if the export tool added one.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  const pushField = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushRow();
    } else if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      pushRow();
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Header mapping — tolerant, case-insensitive synonym match.
// ─────────────────────────────────────────────────────────────────────────────

/** Logical columns we look for, each with its accepted header synonyms (lowercased). */
const HEADER_SYNONYMS: Record<string, string[]> = {
  company: ["company", "employer", "organization", "org"],
  title: ["title", "role", "position", "job title", "job"],
  location: ["location", "city", "place", "where"],
  url: ["url", "link", "job_url", "job url", "job link", "posting url", "apply url"],
  score: ["match_score", "match score", "score", "match", "fit", "fit_score", "match %", "matchscore"],
  date: ["date", "matched_at", "matched at", "matched", "date matched", "found", "found_at"],
};

/** Build a map from logical column name → header index using the synonym table. */
function mapHeaders(header: string[]): Record<string, number> {
  const norm = header.map((h) => h.trim().toLowerCase());
  const out: Record<string, number> = {};
  for (const [logical, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    for (let idx = 0; idx < norm.length; idx++) {
      const cellVal = norm[idx];
      if (cellVal !== undefined && synonyms.includes(cellVal)) {
        out[logical] = idx;
        break;
      }
    }
  }
  return out;
}

/** Safe ragged-row cell read (noUncheckedIndexedAccess: index may be out of range). */
function cell(row: string[], idx: number | undefined): string {
  if (idx === undefined) return "";
  const v = row[idx];
  return v === undefined ? "" : v.trim();
}

/**
 * Parse a Jobright match score into a 0-100 number, or null when absent/unparseable.
 * Tolerates "%" suffixes ("87%") and fractional scores ("0.87" → 87).
 */
function parseScore(raw: string): number | null {
  const s = raw.trim().replace(/%$/, "");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  // A fraction in [0,1] is interpreted as a percentage (0.87 → 87).
  const pct = n > 0 && n <= 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, pct));
}

/** Remote heuristic: the word "remote" appearing in title or location text. */
function inferRemote(title: string, location: string): boolean | null {
  return /\bremote\b/i.test(`${title} ${location}`) ? true : null;
}

/**
 * Infer the ATS from a posting URL's host/path. Jobright links often point straight
 * at the underlying board, which lets later stages route clean-ATS rows into Lane A.
 * Falls back to 'other' when the host is unrecognized or the URL is missing/invalid.
 */
function inferAts(url: string): AtsKind {
  const u = url.toLowerCase();
  if (!u) return "other";
  if (u.includes("greenhouse.io") || u.includes("boards.greenhouse")) return "greenhouse";
  if (u.includes("lever.co")) return "lever";
  if (u.includes("ashbyhq.com")) return "ashby";
  if (u.includes("myworkdayjobs.com") || u.includes("workday")) return "workday";
  return "other";
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ingestJobrightCsv — read a Jobright match-list CSV and fold it into the tracker.
 *
 * For each data row:
 *   1. upsert a Job (source 'jobright', ats inferred from the URL). upsertJob dedups
 *      on the cross-lane hash, so a match that Lane A already sourced shares its job_id.
 *   2. if the job already had an active application in ANY lane
 *      (tracker.hasApplicationForHash, checked BEFORE we add ours), count a
 *      cross-lane duplicate but still record the jobright match faithfully.
 *   3. create an application: lane 'jobright', status 'sourced' (a match, not an
 *      application), fitScore = parsed match score (or null), notes carry provenance.
 *
 * Promotion of these 'sourced' rows into the custom apply lane is the orchestrator's
 * job, not this ingester's.
 *
 * @param csvPath  path to the user-exported Jobright CSV.
 * @param tracker  an opened+inited Tracker (see openTracker).
 */
export function ingestJobrightCsv(csvPath: string, tracker: Tracker): IngestResult {
  const result: IngestResult = {
    lane: "jobright",
    rowsRead: 0,
    jobsUpserted: 0,
    applicationsCreated: 0,
    duplicatesSkipped: 0,
    errors: [],
  };

  let text: string;
  try {
    text = fs.readFileSync(csvPath, "utf8");
  } catch (err) {
    result.errors.push(`failed to read ${csvPath}: ${(err as Error).message}`);
    return result;
  }

  const rows = parseCsv(text);
  if (rows.length === 0) {
    result.errors.push("CSV is empty (no header row)");
    return result;
  }

  const header = rows[0] ?? [];
  const cols = mapHeaders(header);

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row === undefined) continue;
    if (row.length === 0 || (row.length === 1 && (row[0] ?? "").trim() === "")) continue;

    result.rowsRead++;

    const company = cell(row, cols.company);
    const title = cell(row, cols.title);
    if (!company && !title) {
      result.errors.push(`row ${r + 1}: missing both company and title`);
      continue;
    }

    const location = cell(row, cols.location);
    const url = cell(row, cols.url);
    const scoreRaw = cell(row, cols.score);

    const job: SourcedJob = {
      source: "jobright",
      ats: inferAts(url),
      company: company || "Unknown",
      title: title || "Unknown",
      location,
      remote: inferRemote(title, location),
      url: url || "",
      jdText: "",
      postedAt: null,
    };

    let upsert;
    try {
      upsert = tracker.upsertJob(job);
    } catch (err) {
      result.errors.push(`row ${r + 1}: upsertJob failed: ${(err as Error).message}`);
      continue;
    }
    if (upsert.inserted) result.jobsUpserted++;

    // Cross-lane dedup probe BEFORE we add our row.
    if (tracker.hasApplicationForHash(upsert.dedupHash)) {
      result.duplicatesSkipped++;
    }

    const fitScore = parseScore(scoreRaw);
    try {
      tracker.createApplication({
        jobId: upsert.id,
        lane: "jobright",
        status: "sourced", // A Jobright match — not yet applied. Orchestrator may promote.
        fitScore,
        notes: `Ingested from Jobright match list${fitScore !== null ? ` (match score: ${fitScore})` : ""}`,
      });
      result.applicationsCreated++;
    } catch (err) {
      result.errors.push(`row ${r + 1}: createApplication failed: ${(err as Error).message}`);
    }
  }

  return result;
}
