/**
 * types.ts — the shared contract surface for the autonomous job-application system.
 *
 * Every module in `agent/src` is written against the interfaces here. Connectors,
 * scoring, tailoring, apply fillers and lane ingesters all depend ONLY on this file
 * (plus the tracker + config spine), never on each other's concrete implementations.
 *
 * Design refs: design/design.md §2 (components), §2.6 (tracker schema), guardrails.md §2/§8.
 */

import type { Page } from "playwright";

// ─────────────────────────────────────────────────────────────────────────────
// Enums / string unions
// ─────────────────────────────────────────────────────────────────────────────

/** Which applicant-tracking-system a posting / form belongs to. */
export type AtsKind = "greenhouse" | "lever" | "ashby" | "workday" | "other";

/** Where a job row originated. */
export type SourceKind =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "adzuna"
  | "jobright"
  | "aiapply"
  | "manual";

/** Connector reach tier — apply difficulty rises down this list (design §2.2). */
export type ConnectorTier = "clean_ats" | "workday" | "custom_site";

/** The three independent lanes that all write to one tracker (plan §3). */
export type Lane = "custom" | "aiapply" | "jobright";

/** Submission mode. Default is `dryrun` — never live until explicitly flipped (guardrails §3). */
export type ApplyMode = "dryrun" | "live";

/** Lifecycle of an application row. */
export type ApplicationStatus =
  | "sourced"
  | "scored"
  | "tailored"
  | "queued"
  | "filled"
  | "submitted"
  | "skipped"
  | "failed"
  | "needs_review";

/** Fit verdict buckets (04-job-evaluation.md thresholds). */
export type Verdict = "strong" | "good" | "moderate" | "weak" | "poor";

// ─────────────────────────────────────────────────────────────────────────────
// Profile
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkAuthorization {
  /** Free-text status, e.g. "H-1B". */
  status: string;
  authorizedToWorkUS: boolean;
  /** True for H-1B holders who need a new sponsor. */
  requiresSponsorship: boolean;
}

export interface ProfileExperience {
  title: string;
  company: string;
  location: string;
  start: string; // ISO or "YYYY-MM"
  end: string | null; // null = present
  bullets: string[];
}

export interface ProfileEducation {
  degree: string;
  field: string;
  institution: string;
  start: string;
  end: string;
  notes?: string;
}

export interface JobPreferences {
  /** Target titles, e.g. "Senior ML Engineer", "Staff AI Engineer". */
  titles: string[];
  /** Seniority tokens used by the prefilter, e.g. ["senior","staff","lead","principal"]. */
  seniority: string[];
  /** "remote-only" | "hybrid-ok" | "onsite-ok" | "open". */
  remotePreference: "remote-only" | "hybrid-ok" | "onsite-ok" | "open";
  /** Open to relocation anywhere when true → no geographic hard-filter. */
  relocateAnywhere: boolean;
  /** Minimum acceptable base salary (USD). null = no floor. */
  salaryFloorUSD: number | null;
  sectors: string[];
  dealbreakers: string[];
  /** Companies to always exclude from sourcing/scoring, e.g. ["Amazon"]. */
  excludeCompanies: string[];
}

/** EEO / voluntary self-identification defaults. "decline" is always honest. */
export interface EeoDefaults {
  gender: string;
  race: string;
  veteranStatus: string;
  disabilityStatus: string;
  hispanicLatino: string;
}

export interface Profile {
  identity: {
    name: string;
    headline: string;
    summary: string;
  };
  contact: {
    email: string;
    phone: string | null;
    location: string;
    linkedin: string | null;
    github: string | null;
    website: string | null;
  };
  workAuthorization: WorkAuthorization;
  languages: string[];
  education: ProfileEducation[];
  experience: ProfileExperience[];
  skills: {
    primary: string[];
    secondary: string[];
    domain: string[];
    tools: string[];
  };
  certifications: string[];
  publications: string[];
  awards: string[];
  preferences: JobPreferences;
  eeo: EeoDefaults;
  /** Marks fields still using /setup placeholders that must not be presented as fact. */
  incompleteFields: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Watchlist
// ─────────────────────────────────────────────────────────────────────────────

export interface WatchlistCompany {
  name: string;
  tier: ConnectorTier;
  ats: AtsKind;
  /**
   * Connector handle:
   *  - greenhouse: board token (the slug in boards-api.greenhouse.io/v1/boards/<token>)
   *  - lever: site slug (api.lever.co/v0/postings/<slug>)
   *  - ashby: org slug (jobs.ashbyhq.com/<slug> / posting-api)
   *  - workday/custom: host or path fragment
   */
  handle?: string;
  notes?: string;
  /** Whether the company is a known H-1B sponsor (boosts fit; informational). */
  sponsorsH1B?: boolean;
  /** Set true once the connector handle was confirmed to return jobs at build time. */
  verified?: boolean;
  enabled: boolean;
}

export interface Watchlist {
  companies: WatchlistCompany[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Jobs
// ─────────────────────────────────────────────────────────────────────────────

/** A normalized posting as produced by a connector — no DB identity yet. */
export interface SourcedJob {
  source: SourceKind;
  ats: AtsKind;
  company: string;
  title: string;
  location: string;
  /** true=remote, false=onsite, null=unknown. */
  remote: boolean | null;
  /** Canonical apply/posting URL. */
  url: string;
  /** Plain-text job description (HTML stripped). */
  jdText: string;
  /** ISO date string or null. */
  postedAt: string | null;
}

/** A job row as stored in the tracker. */
export interface JobRow extends SourcedJob {
  id: number;
  /** sha256 of canonical company|title|location — the cross-lane dedup key. */
  dedupHash: string;
  fetchedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring + hard pre-filters
// ─────────────────────────────────────────────────────────────────────────────

export interface PrefilterResult {
  /** False → job dropped before scoring. */
  pass: boolean;
  reasons: string[];
  sponsorshipSignal: "sponsors" | "no_sponsorship" | "unknown";
  seniorityMatch: boolean;
  excludedCompany: boolean;
  clearanceRequired: boolean;
  citizenshipRequired: boolean;
  salaryBelowFloor: boolean;
}

export interface ScoreDimensions {
  technical: number; // 0-100
  experience: number; // 0-100
  behavioral: number; // 0-100
  career: number; // 0-100
}

export interface ScoreResult {
  jobId: number;
  overall: number; // 0-100 weighted (see 04-job-evaluation.md weights)
  dimensions: ScoreDimensions;
  locationPass: boolean;
  verdict: Verdict;
  strengths: string[];
  gaps: string[];
  recommendation: string;
  prefilter: PrefilterResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Screening answers (the linchpin of unattended apply, design §2.1)
// ─────────────────────────────────────────────────────────────────────────────

export type FieldType =
  | "text"
  | "textarea"
  | "select"
  | "multiselect"
  | "boolean"
  | "file"
  | "unknown";

export interface ScreeningQuestion {
  id: string;
  label: string;
  type: FieldType;
  options?: string[];
  required: boolean;
}

export interface AnsweredQuestion {
  question: ScreeningQuestion;
  answer: string | string[] | boolean | null;
  source: "answer_bank" | "profile" | "generated" | "unanswerable";
  confidence: "high" | "medium" | "low";
  /** True → must not be auto-submitted; queue for human (no-fabrication rule). */
  needsHuman: boolean;
}

export interface ScreeningAnswerSet {
  jobId: number;
  answers: AnsweredQuestion[];
  /** True if any required question could not be answered confidently. */
  hasUnanswerable: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tailoring artifacts
// ─────────────────────────────────────────────────────────────────────────────

export interface ApplyArtifacts {
  /** ATS-safe single-column text/PDF resume (design §2.4). */
  resumePath: string;
  /** moderncv LaTeX CV PDF (optional for clean-ATS unattended apply). */
  cvPath?: string;
  coverLetterPath?: string;
  coverLetterText?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Guardrails + config (guardrails.md §2/§8)
// ─────────────────────────────────────────────────────────────────────────────

export interface GuardrailConfig {
  applyMode: ApplyMode; // default "dryrun"
  dailyCap: number; // default 3
  perCompanyDays: number; // default 30
  fitThreshold: number; // default 70
  atsAllowlist: AtsKind[]; // default [greenhouse, lever, ashby]
  captchaPolicy: "skip_and_flag" | "pause_for_human";
  onUnknownField: "skip_and_flag" | "pause_for_human";
  /** Tier tokens that always require human review even when unattended. */
  reviewRequiredTiers: string[];
  killFile: string; // default "data/STOP"
  /** Abort the run after N consecutive captcha/login/unknown anomalies. */
  consecutiveAnomalyAbort: number;
}

export interface AppConfig {
  rootDir: string;
  dbPath: string;
  screenshotDir: string;
  guardrails: GuardrailConfig;
  adzunaAppId: string | null;
  adzunaAppKey: string | null;
}

/** The answer to "may the apply engine act on this job right now?". */
export interface GuardrailDecision {
  /** True → proceed to fill. In dryrun we fill+screenshot but never submit. */
  allowed: boolean;
  mode: ApplyMode;
  /** Reasons the job was blocked (empty when allowed). */
  blockReasons: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply engine (Playwright fillers)
// ─────────────────────────────────────────────────────────────────────────────

export type FillOutcome =
  | "filled" // dryrun: filled + screenshotted, stopped before submit
  | "submitted" // live: submitted
  | "skipped"
  | "failed"
  | "captcha"
  | "login_required"
  | "unknown_field";

export interface FillContext {
  job: JobRow;
  profile: Profile;
  artifacts: ApplyArtifacts;
  answers: ScreeningAnswerSet;
  /** Where the filler must save its screenshot. */
  screenshotPath: string;
  mode: ApplyMode;
}

export interface FillResult {
  outcome: FillOutcome;
  screenshotPath: string | null;
  submitted: boolean;
  /** Labels of fields the filler could not confidently fill. */
  flaggedFields: string[];
  notes: string;
}

/** One module per ATS. Implementations live in src/apply/*-filler.ts. */
export interface FormFiller {
  ats: AtsKind;
  /** True if this filler recognizes the apply URL. */
  matches(url: string): boolean;
  /** Fill (and, when mode==="live" and allowed, submit) the form. */
  fill(page: Page, ctx: FillContext): Promise<FillResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connector + ingester contracts
// ─────────────────────────────────────────────────────────────────────────────

export interface ConnectorOptions {
  /** Title/keyword tokens to keep (seniority + AI/ML). Case-insensitive substring match. */
  titleKeywords: string[];
  /** Max postings to return per company (politeness/perf cap). */
  limitPerCompany?: number;
  /** Request timeout in ms. */
  timeoutMs?: number;
}

/** Every ATS connector implements this shape. */
export type Connector = (
  company: WatchlistCompany,
  opts: ConnectorOptions,
) => Promise<SourcedJob[]>;

/** Adzuna is cross-company, so it takes a free-text query, not a company. */
export type AggregatorConnector = (
  query: string,
  opts: ConnectorOptions & { adzunaAppId: string; adzunaAppKey: string; resultsPerPage?: number },
) => Promise<SourcedJob[]>;

// ─────────────────────────────────────────────────────────────────────────────
// DB row types (tracker)
// ─────────────────────────────────────────────────────────────────────────────

export interface ApplicationRow {
  id: number;
  jobId: number;
  lane: Lane;
  status: ApplicationStatus;
  fitScore: number | null;
  cvPath: string | null;
  letterPath: string | null;
  resumePath: string | null;
  answersJson: string | null;
  screenshotPath: string | null;
  mode: ApplyMode | null;
  submittedAt: string | null;
  outcome: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventRow {
  id: number;
  ts: string;
  level: "info" | "warn" | "error";
  lane: string | null;
  message: string;
}

export interface LaneRow {
  name: Lane;
  lastRunAt: string | null;
  configJson: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lane ingestion + answer bank
// ─────────────────────────────────────────────────────────────────────────────

export interface IngestResult {
  lane: Lane;
  rowsRead: number;
  jobsUpserted: number;
  applicationsCreated: number;
  duplicatesSkipped: number;
  errors: string[];
}

/** One parsed entry from profile/answer-bank.md. */
export interface AnswerBankEntry {
  question: string;
  keywords: string[];
  answer: string;
  confidence: "high" | "medium" | "low";
  note?: string;
}
