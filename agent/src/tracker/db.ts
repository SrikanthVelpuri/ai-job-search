/**
 * db.ts — the tracker. One SQLite file (`data/jobs.db`) is the single source of truth
 * across all three lanes (design §2.6). Schema:
 *
 *   jobs(id, source, ats, company, title, location, remote, url, jd_text, posted_at, fetched_at, dedup_hash)
 *   applications(id, job_id, lane, status, fit_score, cv_path, letter_path, resume_path,
 *                answers_json, screenshot_path, mode, submitted_at, outcome, notes, created_at, updated_at)
 *   lanes(name, last_run_at, config_json)
 *   events(id, ts, level, lane, message)
 *
 * Cross-lane dedup: an application in any lane blocks re-apply in others, matched on jobs.dedup_hash.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type {
  ApplicationRow,
  ApplicationStatus,
  ApplyMode,
  EventRow,
  JobRow,
  Lane,
  LaneRow,
  SourcedJob,
} from "../types.js";
import { computeDedupHash } from "./dedup.js";

const nowIso = (): string => new Date().toISOString();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  ats TEXT NOT NULL,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL,
  remote INTEGER,                 -- 1/0/NULL
  url TEXT NOT NULL,
  jd_text TEXT NOT NULL,
  posted_at TEXT,
  fetched_at TEXT NOT NULL,
  dedup_hash TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_jobs_dedup ON jobs(dedup_hash);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  lane TEXT NOT NULL,             -- 'custom' | 'aiapply' | 'jobright'
  status TEXT NOT NULL,
  fit_score REAL,
  cv_path TEXT,
  letter_path TEXT,
  resume_path TEXT,
  answers_json TEXT,
  screenshot_path TEXT,
  mode TEXT,                      -- 'dryrun' | 'live'
  submitted_at TEXT,
  outcome TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_job ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_app_lane ON applications(lane);
CREATE INDEX IF NOT EXISTS idx_app_status ON applications(status);

CREATE TABLE IF NOT EXISTS lanes (
  name TEXT PRIMARY KEY,
  last_run_at TEXT,
  config_json TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  lane TEXT,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
`;

type RawJob = {
  id: number;
  source: string;
  ats: string;
  company: string;
  title: string;
  location: string;
  remote: number | null;
  url: string;
  jd_text: string;
  posted_at: string | null;
  fetched_at: string;
  dedup_hash: string;
};

type RawApp = {
  id: number;
  job_id: number;
  lane: string;
  status: string;
  fit_score: number | null;
  cv_path: string | null;
  letter_path: string | null;
  resume_path: string | null;
  answers_json: string | null;
  screenshot_path: string | null;
  mode: string | null;
  submitted_at: string | null;
  outcome: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

function toJobRow(r: RawJob): JobRow {
  return {
    id: r.id,
    source: r.source as JobRow["source"],
    ats: r.ats as JobRow["ats"],
    company: r.company,
    title: r.title,
    location: r.location,
    remote: r.remote === null ? null : r.remote === 1,
    url: r.url,
    jdText: r.jd_text,
    postedAt: r.posted_at,
    fetchedAt: r.fetched_at,
    dedupHash: r.dedup_hash,
  };
}

function toAppRow(r: RawApp): ApplicationRow {
  return {
    id: r.id,
    jobId: r.job_id,
    lane: r.lane as Lane,
    status: r.status as ApplicationStatus,
    fitScore: r.fit_score,
    cvPath: r.cv_path,
    letterPath: r.letter_path,
    resumePath: r.resume_path,
    answersJson: r.answers_json,
    screenshotPath: r.screenshot_path,
    mode: r.mode as ApplyMode | null,
    submittedAt: r.submitted_at,
    outcome: r.outcome,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface UpsertJobResult {
  id: number;
  inserted: boolean;
  dedupHash: string;
}

export interface JobFilter {
  company?: string;
  ats?: string;
  source?: string;
  /** Only jobs with no application row in any lane. */
  unapplied?: boolean;
  limit?: number;
}

export interface CreateApplicationInput {
  jobId: number;
  lane: Lane;
  status: ApplicationStatus;
  fitScore?: number | null;
  cvPath?: string | null;
  letterPath?: string | null;
  resumePath?: string | null;
  answersJson?: string | null;
  screenshotPath?: string | null;
  mode?: ApplyMode | null;
  submittedAt?: string | null;
  outcome?: string | null;
  notes?: string | null;
}

export type ApplicationPatch = Partial<Omit<CreateApplicationInput, "jobId" | "lane">>;

/**
 * Tracker — synchronous SQLite wrapper. All timestamps are ISO-8601 UTC.
 */
export class Tracker {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  /** Create tables + seed the three lane rows. Idempotent. */
  init(): void {
    this.db.exec(SCHEMA);
    const seed = this.db.prepare(
      "INSERT OR IGNORE INTO lanes(name, last_run_at, config_json) VALUES (?, NULL, NULL)",
    );
    for (const lane of ["custom", "aiapply", "jobright"] as const) seed.run(lane);
  }

  // ── Jobs ──────────────────────────────────────────────────────────────────

  /** Insert a job, or return the existing row id if its dedup hash already exists. */
  upsertJob(job: SourcedJob): UpsertJobResult {
    const dedupHash = computeDedupHash(job.company, job.title, job.location, job.remote);
    const existing = this.db
      .prepare("SELECT id FROM jobs WHERE dedup_hash = ?")
      .get(dedupHash) as { id: number } | undefined;
    if (existing) return { id: existing.id, inserted: false, dedupHash };

    const info = this.db
      .prepare(
        `INSERT INTO jobs(source, ats, company, title, location, remote, url, jd_text, posted_at, fetched_at, dedup_hash)
         VALUES (@source, @ats, @company, @title, @location, @remote, @url, @jd_text, @posted_at, @fetched_at, @dedup_hash)`,
      )
      .run({
        source: job.source,
        ats: job.ats,
        company: job.company,
        title: job.title,
        location: job.location,
        remote: job.remote === null ? null : job.remote ? 1 : 0,
        url: job.url,
        jd_text: job.jdText,
        posted_at: job.postedAt,
        fetched_at: nowIso(),
        dedup_hash: dedupHash,
      });
    return { id: Number(info.lastInsertRowid), inserted: true, dedupHash };
  }

  getJob(id: number): JobRow | null {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as RawJob | undefined;
    return r ? toJobRow(r) : null;
  }

  findJobByHash(dedupHash: string): JobRow | null {
    const r = this.db.prepare("SELECT * FROM jobs WHERE dedup_hash = ?").get(dedupHash) as
      | RawJob
      | undefined;
    return r ? toJobRow(r) : null;
  }

  listJobs(filter: JobFilter = {}): JobRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.company) {
      where.push("company = @company");
      params.company = filter.company;
    }
    if (filter.ats) {
      where.push("ats = @ats");
      params.ats = filter.ats;
    }
    if (filter.source) {
      where.push("source = @source");
      params.source = filter.source;
    }
    if (filter.unapplied) {
      where.push("id NOT IN (SELECT job_id FROM applications)");
    }
    const sql =
      "SELECT * FROM jobs" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY fetched_at DESC" +
      (filter.limit ? ` LIMIT ${Math.max(0, Math.floor(filter.limit))}` : "");
    return (this.db.prepare(sql).all(params) as RawJob[]).map(toJobRow);
  }

  countJobs(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;
  }

  // ── Cross-lane dedup gate ───────────────────────────────────────────────────

  /**
   * True if ANY lane already has an active/submitted application for the job's dedup
   * hash. This is the guardrails.md §2 dedup gate — never apply twice via two channels.
   * "Active" excludes skipped/failed so a previous skip does not permanently block.
   */
  hasApplicationForHash(dedupHash: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM applications a
         JOIN jobs j ON j.id = a.job_id
         WHERE j.dedup_hash = ?
           AND a.status NOT IN ('skipped','failed')
         LIMIT 1`,
      )
      .get(dedupHash);
    return row !== undefined;
  }

  /** Per-company cap: most recent active application for a company within N days. */
  recentApplicationForCompany(company: string, days: number): ApplicationRow | null {
    const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
    const r = this.db
      .prepare(
        `SELECT a.* FROM applications a
         JOIN jobs j ON j.id = a.job_id
         WHERE j.company = ?
           AND a.status NOT IN ('skipped','failed')
           AND a.created_at >= ?
         ORDER BY a.created_at DESC LIMIT 1`,
      )
      .get(company, sinceIso) as RawApp | undefined;
    return r ? toAppRow(r) : null;
  }

  /** Daily cap counter: applications created since `sinceIso`, optionally scoped. */
  countApplicationsSince(sinceIso: string, opts: { lane?: Lane; mode?: ApplyMode; submittedOnly?: boolean } = {}): number {
    const where = ["created_at >= @since"];
    const params: Record<string, unknown> = { since: sinceIso };
    if (opts.lane) {
      where.push("lane = @lane");
      params.lane = opts.lane;
    }
    if (opts.mode) {
      where.push("mode = @mode");
      params.mode = opts.mode;
    }
    if (opts.submittedOnly) {
      where.push("status = 'submitted'");
    }
    const sql = `SELECT COUNT(*) AS n FROM applications WHERE ${where.join(" AND ")}`;
    return (this.db.prepare(sql).get(params) as { n: number }).n;
  }

  // ── Applications ─────────────────────────────────────────────────────────────

  createApplication(input: CreateApplicationInput): number {
    const ts = nowIso();
    const info = this.db
      .prepare(
        `INSERT INTO applications(job_id, lane, status, fit_score, cv_path, letter_path, resume_path,
            answers_json, screenshot_path, mode, submitted_at, outcome, notes, created_at, updated_at)
         VALUES (@job_id, @lane, @status, @fit_score, @cv_path, @letter_path, @resume_path,
            @answers_json, @screenshot_path, @mode, @submitted_at, @outcome, @notes, @created_at, @updated_at)`,
      )
      .run({
        job_id: input.jobId,
        lane: input.lane,
        status: input.status,
        fit_score: input.fitScore ?? null,
        cv_path: input.cvPath ?? null,
        letter_path: input.letterPath ?? null,
        resume_path: input.resumePath ?? null,
        answers_json: input.answersJson ?? null,
        screenshot_path: input.screenshotPath ?? null,
        mode: input.mode ?? null,
        submitted_at: input.submittedAt ?? null,
        outcome: input.outcome ?? null,
        notes: input.notes ?? null,
        created_at: ts,
        updated_at: ts,
      });
    return Number(info.lastInsertRowid);
  }

  updateApplication(id: number, patch: ApplicationPatch): void {
    const map: Record<string, string> = {
      status: "status",
      fitScore: "fit_score",
      cvPath: "cv_path",
      letterPath: "letter_path",
      resumePath: "resume_path",
      answersJson: "answers_json",
      screenshotPath: "screenshot_path",
      mode: "mode",
      submittedAt: "submitted_at",
      outcome: "outcome",
      notes: "notes",
    };
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, updated_at: nowIso() };
    for (const [key, col] of Object.entries(map)) {
      if (key in patch) {
        sets.push(`${col} = @${col}`);
        params[col] = (patch as Record<string, unknown>)[key] ?? null;
      }
    }
    sets.push("updated_at = @updated_at");
    this.db.prepare(`UPDATE applications SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  getApplication(id: number): ApplicationRow | null {
    const r = this.db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as
      | RawApp
      | undefined;
    return r ? toAppRow(r) : null;
  }

  listApplications(filter: { lane?: Lane; status?: ApplicationStatus; jobId?: number; limit?: number } = {}): ApplicationRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.lane) {
      where.push("lane = @lane");
      params.lane = filter.lane;
    }
    if (filter.status) {
      where.push("status = @status");
      params.status = filter.status;
    }
    if (filter.jobId !== undefined) {
      where.push("job_id = @jobId");
      params.jobId = filter.jobId;
    }
    const sql =
      "SELECT * FROM applications" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY created_at DESC" +
      (filter.limit ? ` LIMIT ${Math.max(0, Math.floor(filter.limit))}` : "");
    return (this.db.prepare(sql).all(params) as RawApp[]).map(toAppRow);
  }

  // ── Lanes + events ──────────────────────────────────────────────────────────

  touchLane(name: Lane, configJson?: string): void {
    this.db
      .prepare(
        `INSERT INTO lanes(name, last_run_at, config_json) VALUES (@name, @ts, @cfg)
         ON CONFLICT(name) DO UPDATE SET last_run_at = @ts, config_json = COALESCE(@cfg, config_json)`,
      )
      .run({ name, ts: nowIso(), cfg: configJson ?? null });
  }

  getLanes(): LaneRow[] {
    return (this.db.prepare("SELECT * FROM lanes ORDER BY name").all() as Array<{ name: string; last_run_at: string | null; config_json: string | null }>).map((r) => ({
      name: r.name as Lane,
      lastRunAt: r.last_run_at,
      configJson: r.config_json,
    }));
  }

  logEvent(level: EventRow["level"], message: string, lane: string | null = null): void {
    this.db
      .prepare("INSERT INTO events(ts, level, lane, message) VALUES (?, ?, ?, ?)")
      .run(nowIso(), level, lane, message);
  }

  listEvents(opts: { since?: string; limit?: number } = {}): EventRow[] {
    const where = opts.since ? "WHERE ts >= @since" : "";
    const rows = this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY ts DESC ${opts.limit ? `LIMIT ${Math.floor(opts.limit)}` : ""}`)
      .all(opts.since ? { since: opts.since } : {}) as Array<{ id: number; ts: string; level: string; lane: string | null; message: string }>;
    return rows.map((r) => ({ id: r.id, ts: r.ts, level: r.level as EventRow["level"], lane: r.lane, message: r.message }));
  }

  close(): void {
    this.db.close();
  }
}

/** Convenience: open + init a tracker at the given path. */
export function openTracker(dbPath: string): Tracker {
  const t = new Tracker(dbPath);
  t.init();
  return t;
}
