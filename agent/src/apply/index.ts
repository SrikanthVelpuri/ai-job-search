/**
 * apply/index.ts — the apply engine (plan Phase 4, design §2.5, guardrails.md §4/§5).
 *
 * Given a tailored job, this:
 *   1. asks the guardrails whether it may act (evaluateGuardrails),
 *   2. picks the matching ATS filler,
 *   3. fills + screenshots (and, only in live mode after every gate, submits),
 *   4. writes a complete audit record to applications + events.
 *
 * SAFETY: default APPLY_MODE is `dryrun`. Even when guardrails authorize, the filler never
 * clicks submit unless mode==='live'. This engine passes mode through and persists exactly
 * what happened (mode, outcome, screenshot) so every attempt is reconstructable.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  AppConfig,
  ApplicationStatus,
  ApplyArtifacts,
  FillContext,
  FillResult,
  FormFiller,
  GuardrailDecision,
  JobRow,
  Profile,
  ScoreResult,
  ScreeningAnswerSet,
} from "../types.js";
import type { Tracker } from "../tracker/db.js";
import { evaluateGuardrails } from "./guardrails.js";
import { launchBrowser, NAV_TIMEOUT_MS } from "./base-filler.js";
import { greenhouseFiller } from "./greenhouse-filler.js";
import { leverFiller } from "./lever-filler.js";
import { ashbyFiller } from "./ashby-filler.js";

/** v1 allowlisted fillers (guardrails.md §2: only validated ATS forms). */
export const FILLERS: FormFiller[] = [greenhouseFiller, leverFiller, ashbyFiller];

export function fillerForUrl(url: string): FormFiller | null {
  return FILLERS.find((f) => f.matches(url)) ?? null;
}

export function fillerForAts(ats: string): FormFiller | null {
  return FILLERS.find((f) => f.ats === ats) ?? null;
}

export interface ApplyInput {
  job: JobRow;
  profile: Profile;
  artifacts: ApplyArtifacts;
  answers: ScreeningAnswerSet;
  score: ScoreResult | null;
  tracker: Tracker;
  config: AppConfig;
}

export interface ApplyEngineResult {
  jobId: number;
  decision: GuardrailDecision;
  fill: FillResult | null;
  applicationId: number;
  status: ApplicationStatus;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "job";
}

/** Map a fill outcome + mode to the application status we persist. */
function statusFor(outcome: FillResult["outcome"]): ApplicationStatus {
  switch (outcome) {
    case "submitted":
      return "submitted";
    case "filled":
      return "filled";
    case "captcha":
    case "login_required":
    case "unknown_field":
      return "needs_review";
    case "skipped":
      return "skipped";
    case "failed":
    default:
      return "failed";
  }
}

/**
 * Run the guarded apply flow for one job. Blocked jobs never launch a browser.
 * Returns the persisted application id + final status.
 */
export async function applyToJob(input: ApplyInput): Promise<ApplyEngineResult> {
  const { job, profile, artifacts, answers, score, tracker, config } = input;
  const cfg = config.guardrails;

  const decision = evaluateGuardrails({ job, score, answers, tracker, cfg });

  // ── Blocked: record why, never open a browser. ──────────────────────────────
  if (!decision.allowed) {
    // ATS-not-allowlisted or unanswerable → queue for human; everything else → skipped.
    const needsReview =
      decision.blockReasons.some((r) => r.includes("not in allowlist") || r.includes("unanswerable"));
    const status: ApplicationStatus = needsReview ? "needs_review" : "skipped";
    const applicationId = tracker.createApplication({
      jobId: job.id,
      lane: "custom",
      status,
      fitScore: score?.overall ?? null,
      resumePath: artifacts.resumePath,
      cvPath: artifacts.cvPath ?? null,
      letterPath: artifacts.coverLetterPath ?? null,
      answersJson: JSON.stringify(answers),
      mode: cfg.applyMode,
      outcome: status,
      notes: decision.blockReasons.join("; "),
    });
    tracker.logEvent("info", `apply blocked [${job.company} #${job.id}]: ${decision.blockReasons.join("; ")}`, "custom");
    return { jobId: job.id, decision, fill: null, applicationId, status };
  }

  // ── Allowed: pick a filler. ─────────────────────────────────────────────────
  const filler = fillerForUrl(job.url) ?? fillerForAts(job.ats);
  if (!filler) {
    const applicationId = tracker.createApplication({
      jobId: job.id,
      lane: "custom",
      status: "needs_review",
      fitScore: score?.overall ?? null,
      resumePath: artifacts.resumePath,
      answersJson: JSON.stringify(answers),
      mode: cfg.applyMode,
      outcome: "needs_review",
      notes: `no filler for ats=${job.ats} url=${job.url}`,
    });
    return { jobId: job.id, decision, fill: null, applicationId, status: "needs_review" };
  }

  // Screenshot path for this attempt (guardrails.md §5: every attempt is screenshotted).
  fs.mkdirSync(config.screenshotDir, { recursive: true });
  const screenshotPath = path.join(
    config.screenshotDir,
    `${slug(job.company)}_${job.id}_${cfg.applyMode}.png`,
  );

  const ctx: FillContext = { job, profile, artifacts, answers, screenshotPath, mode: cfg.applyMode };

  let fill: FillResult;
  let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null;
  try {
    browser = await launchBrowser({ headless: true });
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    fill = await filler.fill(page, ctx);
  } catch (err) {
    fill = {
      outcome: "failed",
      screenshotPath: null,
      submitted: false,
      flaggedFields: [],
      notes: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  const status = statusFor(fill.outcome);
  const applicationId = tracker.createApplication({
    jobId: job.id,
    lane: "custom",
    status,
    fitScore: score?.overall ?? null,
    resumePath: artifacts.resumePath,
    cvPath: artifacts.cvPath ?? null,
    letterPath: artifacts.coverLetterPath ?? null,
    answersJson: JSON.stringify(answers),
    screenshotPath: fill.screenshotPath,
    mode: cfg.applyMode,
    submittedAt: fill.submitted ? new Date().toISOString() : null,
    outcome: fill.outcome,
    notes: [fill.notes, fill.flaggedFields.length ? `flagged: ${fill.flaggedFields.join(", ")}` : ""]
      .filter(Boolean)
      .join(" | "),
  });
  tracker.logEvent(
    fill.outcome === "failed" ? "error" : "info",
    `apply ${cfg.applyMode} [${job.company} #${job.id}] → ${fill.outcome}${fill.submitted ? " (SUBMITTED)" : ""}`,
    "custom",
  );

  return { jobId: job.id, decision, fill, applicationId, status };
}
