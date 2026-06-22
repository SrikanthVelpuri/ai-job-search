/**
 * aiapply.ts — Lane B ingester (plan Phase 5, design §4).
 *
 * AIApply has no public API, so the user manually exports their AIApply
 * APPLICATION LOG to CSV and we ingest it here. Every row in that log is a job
 * AIApply has *already applied to* on the user's behalf, so each ingested row
 * becomes:
 *   - a `jobs` row (source 'aiapply', ats 'other'), deduped on the cross-lane hash, and
 *   - an `applications` row in lane 'aiapply' with status 'submitted'.
 *
 * Ingesting into the shared tracker gives us cross-lane dedup (so Lane A / custom
 * never re-applies to something AIApply already did) plus unified analytics.
 *
 * The CSV is *user-exported* and therefore messy: column order varies, headers
 * use synonyms, fields may be quoted with embedded commas/newlines. We parse with
 * a small self-contained RFC4180-ish reader (no csv dependency) and tolerate
 * missing/extra columns. Malformed rows are collected into `IngestResult.errors`
 * rather than aborting the whole import.
 */

import fs from "node:fs";
import type { IngestResult, SourcedJob } from "../types.js";
import type { Tracker } from "../tracker/db.js";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal RFC4180-ish CSV parser (self-contained — no external dependency).
//
// Handles: quoted fields, commas/newlines inside quotes, doubled "" escapes,
// and CRLF or LF line endings. It is intentionally small; it does not attempt to
// validate column counts (callers tolerate ragged rows).
// ─────────────────────────────────────────────────────────────────────────────

/** Parse CSV text into an array of string-cell rows. Empty trailing line dropped. */
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
        // A doubled quote ("") inside a quoted field is a literal quote.
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
      // Swallow CR; the following LF (CRLF) ends the row, or a bare CR also ends it.
      if (text[i + 1] === "\n") {
        i++;
      }
      pushRow();
    } else {
      field += c;
    }
  }
  // Flush the final field/row if the file did not end with a newline.
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
  url: ["url", "link", "job url", "job link", "apply url", "posting url"],
  status: ["status", "outcome", "stage", "result", "application status"],
  date: ["date", "applied_at", "applied at", "applied", "date applied", "applied date", "submitted_at", "submitted at"],
};

/**
 * Build a map from logical column name → header index, using the synonym table.
 * Headers are matched case-insensitively and trimmed. First match wins.
 */
function mapHeaders(header: string[]): Record<string, number> {
  const norm = header.map((h) => h.trim().toLowerCase());
  const out: Record<string, number> = {};
  for (const [logical, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    for (let idx = 0; idx < norm.length; idx++) {
      const cell = norm[idx];
      if (cell !== undefined && synonyms.includes(cell)) {
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
 * Parse a free-text date into an ISO-8601 string, or null when unparseable.
 * AIApply exports use a variety of formats; we lean on Date and reject NaN.
 */
function parseDateIso(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Remote heuristic: the word "remote" appearing in title or location text. */
function inferRemote(title: string, location: string): boolean | null {
  return /\bremote\b/i.test(`${title} ${location}`) ? true : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ingestAiApplyCsv — read an AIApply application-log CSV and fold it into the tracker.
 *
 * For each data row:
 *   1. upsert a Job (source 'aiapply', ats 'other'). upsertJob dedups on the
 *      cross-lane hash, so a job AIApply touched that Lane A also sourced shares
 *      the same job_id automatically.
 *   2. if that job already had an *active* application in ANY lane
 *      (tracker.hasApplicationForHash, true before we add ours), count it as a
 *      cross-lane duplicate — but STILL record the aiapply application so the log
 *      stays faithful (it naturally points at the shared job_id).
 *   3. create an application: lane 'aiapply', status 'submitted' (AIApply already
 *      applied), submittedAt = parsed date or null, outcome = the raw status text.
 *
 * Malformed/empty rows (no company AND no title) are skipped and recorded in errors[].
 *
 * @param csvPath  path to the user-exported AIApply CSV.
 * @param tracker  an opened+inited Tracker (see openTracker).
 */
export function ingestAiApplyCsv(csvPath: string, tracker: Tracker): IngestResult {
  const result: IngestResult = {
    lane: "aiapply",
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

  // First non-empty row is the header. mapHeaders tolerates missing logical columns.
  const header = rows[0] ?? [];
  const cols = mapHeaders(header);

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row === undefined) continue;
    // Skip blank lines (a trailing newline yields a single empty cell).
    if (row.length === 0 || (row.length === 1 && (row[0] ?? "").trim() === "")) continue;

    result.rowsRead++;

    const company = cell(row, cols.company);
    const title = cell(row, cols.title);

    // A row with neither company nor title is unusable — flag and move on.
    if (!company && !title) {
      result.errors.push(`row ${r + 1}: missing both company and title`);
      continue;
    }

    const location = cell(row, cols.location);
    const url = cell(row, cols.url);
    const status = cell(row, cols.status);
    const dateRaw = cell(row, cols.date);

    const job: SourcedJob = {
      source: "aiapply",
      ats: "other",
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

    // Cross-lane dedup probe BEFORE we add our row: was this job already applied to
    // (in any lane) via an active/submitted application? If so, count it.
    if (tracker.hasApplicationForHash(upsert.dedupHash)) {
      result.duplicatesSkipped++;
    }

    try {
      tracker.createApplication({
        jobId: upsert.id,
        lane: "aiapply",
        status: "submitted", // AIApply has already applied.
        submittedAt: parseDateIso(dateRaw),
        outcome: status || null,
        notes: `Ingested from AIApply CSV${status ? ` (status: ${status})` : ""}`,
      });
      result.applicationsCreated++;
    } catch (err) {
      result.errors.push(`row ${r + 1}: createApplication failed: ${(err as Error).message}`);
    }
  }

  return result;
}
