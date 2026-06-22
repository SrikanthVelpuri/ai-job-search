/**
 * guardrails.ts — the safety envelope for unattended apply, enforced IN CODE.
 *
 * Implements the hard limits from guardrails.md §2 (daily cap, per-company cap, fit
 * threshold, ATS allowlist, cross-lane dedup, no-fabrication rule) and the kill switch
 * from §4. Prompts never decide whether to submit — this module does.
 *
 * Design contract: this module only AUTHORIZES an apply attempt. It returns a
 * GuardrailDecision { allowed, mode, blockReasons }. The actual submit/no-submit
 * behaviour for `mode === "dryrun"` is enforced downstream by the apply engine + the
 * Playwright fillers: in dryrun they fill the form and screenshot it but STOP before
 * pressing submit. Guardrails just say "you may attempt this job"; it never submits.
 *
 * Refs: guardrails.md §2 (hard limits), §3 (dryrun→live ramp), §4 (kill switch).
 */

import fs from "node:fs";
import type { Tracker } from "../tracker/db.js";
import type {
  ApplyMode,
  GuardrailConfig,
  GuardrailDecision,
  JobRow,
  ScoreResult,
  ScreeningAnswerSet,
} from "../types.js";

/**
 * True if the global kill switch is engaged: the sentinel file (cfg.killFile, default
 * "data/STOP") exists on disk. guardrails.md §4 — its mere presence halts the run before
 * the next submit. Checked synchronously so the decision is cheap and deterministic.
 */
export function killSwitchActive(cfg: GuardrailConfig): boolean {
  return fs.existsSync(cfg.killFile);
}

/**
 * Start-of-today in UTC as an ISO-8601 string (…T00:00:00.000Z). Used as the lower bound
 * for the daily-cap counter so "today" is a stable, timezone-independent window matching
 * the ISO-8601 UTC timestamps the tracker writes.
 */
export function startOfTodayUtcIso(): string {
  const now = new Date();
  // Date.UTC pins the day boundary to midnight UTC regardless of the host timezone.
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/**
 * Evaluate every hard guardrail for one candidate job and return the authorization
 * decision. Reasons accumulate — we surface ALL blocking conditions, not just the first,
 * so the audit trail explains exactly why a job was held back.
 *
 * The job is allowed iff blockReasons is empty. `mode` is taken straight from config
 * (default "dryrun"); a job can be `allowed: true` in dryrun, which authorizes the engine
 * to fill + screenshot but NOT submit (that boundary lives in the engine/fillers, §3).
 */
export function evaluateGuardrails(args: {
  job: JobRow;
  score: ScoreResult | null;
  answers?: ScreeningAnswerSet | null;
  tracker: Tracker;
  cfg: GuardrailConfig;
}): GuardrailDecision {
  const { job, score, answers, tracker, cfg } = args;
  const blockReasons: string[] = [];

  // §4 kill switch — highest priority; an engaged STOP file halts everything.
  if (killSwitchActive(cfg)) {
    blockReasons.push("kill switch active (data/STOP present)");
  }

  // §2 ATS allowlist — only forms we've validated (Greenhouse/Lever/Ashby v1). Anything
  // else (Workday / custom / other) is blocked here and queued for a human (§7).
  if (!cfg.atsAllowlist.includes(job.ats)) {
    blockReasons.push(`ats ${job.ats} not in allowlist`);
  }

  // §2 fit threshold — must have a passing hard pre-filter AND clear the score floor.
  // A null score means scoring never ran or the job was dropped pre-scoring.
  if (score === null || !score.prefilter.pass) {
    const detail = score?.prefilter.reasons?.length
      ? `: ${score.prefilter.reasons.join("; ")}`
      : "";
    blockReasons.push(`failed hard pre-filter${detail}`);
  } else if (score.overall < cfg.fitThreshold) {
    // Only meaningful once the prefilter passed and we have a real overall score.
    blockReasons.push(`below fit threshold (${score.overall} < ${cfg.fitThreshold})`);
  }

  // §2 cross-lane dedup gate — an active/submitted app in ANY lane blocks re-apply.
  if (tracker.hasApplicationForHash(job.dedupHash)) {
    blockReasons.push("already applied in another lane (dedup)");
  }

  // §2 per-company cap — at most one active app per company within the rolling window.
  const recent = tracker.recentApplicationForCompany(job.company, cfg.perCompanyDays);
  if (recent !== null) {
    blockReasons.push(
      `per-company cap: applied to ${job.company} within ${cfg.perCompanyDays}d`,
    );
  }

  // §2 daily cap — count SUBMITTED applications created since UTC midnight today.
  // NOTE: in dryrun nothing is ever submitted (the engine stops before submit), so this
  // counter stays at 0 and the daily cap never trips during the dry-run ramp. It only
  // becomes a live constraint once APPLY_MODE=live starts producing 'submitted' rows.
  const submittedToday = tracker.countApplicationsSince(startOfTodayUtcIso(), {
    submittedOnly: true,
  });
  if (submittedToday >= cfg.dailyCap) {
    blockReasons.push(`daily cap reached (${cfg.dailyCap})`);
  }

  // §2 no-fabrication rule — if any required screening question is unanswerable, we must
  // not auto-submit a guessed answer. Hold for human review instead.
  if (answers?.hasUnanswerable) {
    blockReasons.push("unanswerable screening questions (no-fabrication rule)");
  }

  const allowed = blockReasons.length === 0;
  const mode: ApplyMode = cfg.applyMode;
  return { allowed, mode, blockReasons };
}
