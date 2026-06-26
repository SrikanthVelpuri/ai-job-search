/**
 * config.ts — central configuration + guardrail defaults.
 *
 * All guardrail values are read here (guardrails.md §8). Code, not prompts, enforces them.
 * Everything is overridable by environment variables so the dry-run → live ramp is a
 * single config change with no code edit.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AppConfig, ApplyMode, AtsKind, GuardrailConfig } from "./types.js";

/** Repo root = two levels up from agent/src (…/agent/src → …/). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const AGENT_ROOT = path.resolve(REPO_ROOT, "agent");

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

function envMode(name: string, fallback: ApplyMode): ApplyMode {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  return v === "live" ? "live" : v === "dryrun" ? "dryrun" : fallback;
}

function envAtsList(name: string, fallback: AtsKind[]): AtsKind[] {
  const v = process.env[name];
  if (!v) return fallback;
  const valid: AtsKind[] = ["greenhouse", "lever", "ashby", "smartrecruiters", "workable", "workday", "other"];
  const parsed = v
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is AtsKind => (valid as string[]).includes(s));
  return parsed.length ? parsed : fallback;
}

/**
 * Guardrail defaults (guardrails.md §8). APPLY_MODE defaults to `dryrun`:
 * the system NEVER submits until the user explicitly sets APPLY_MODE=live.
 */
export function loadGuardrails(): GuardrailConfig {
  return {
    applyMode: envMode("APPLY_MODE", "dryrun"),
    dailyCap: envInt("DAILY_CAP", 3),
    perCompanyDays: envInt("PER_COMPANY_DAYS", 30),
    fitThreshold: envInt("FIT_THRESHOLD", 70),
    atsMinScore: envInt("ATS_MIN_SCORE", 60),
    atsAllowlist: envAtsList("ATS_ALLOWLIST", ["greenhouse", "lever", "ashby"]),
    captchaPolicy: envStr("CAPTCHA_POLICY", "skip_and_flag") === "pause_for_human" ? "pause_for_human" : "skip_and_flag",
    onUnknownField: envStr("ON_UNKNOWN_FIELD", "skip_and_flag") === "pause_for_human" ? "pause_for_human" : "skip_and_flag",
    reviewRequiredTiers: envStr("REVIEW_REQUIRED_TIERS", "dream_company,director_plus").split(",").map((s) => s.trim()).filter(Boolean),
    killFile: envStr("KILL_FILE", path.join(REPO_ROOT, "data", "STOP")),
    consecutiveAnomalyAbort: envInt("ANOMALY_ABORT", 3),
  };
}

export function loadConfig(): AppConfig {
  return {
    rootDir: REPO_ROOT,
    dbPath: envStr("JOBS_DB", path.join(REPO_ROOT, "data", "jobs.db")),
    screenshotDir: envStr("SCREENSHOT_DIR", path.join(REPO_ROOT, "data", "screenshots")),
    guardrails: loadGuardrails(),
    adzunaAppId: process.env.ADZUNA_APP_ID ?? null,
    adzunaAppKey: process.env.ADZUNA_APP_KEY ?? null,
  };
}

/** Default title keywords for the senior/staff/lead AI/ML target (plan §6.2, design §2.3). */
export const DEFAULT_TITLE_KEYWORDS: string[] = [
  "machine learning",
  "ml engineer",
  "ml platform",
  "ai engineer",
  "applied scientist",
  "research engineer",
  "ai/ml",
  "artificial intelligence",
  "deep learning",
  "mlops",
  "ai architect",
  "ml architect",
];

/** Seniority tokens required by the prefilter (one must appear in the title). */
export const SENIORITY_TOKENS: string[] = ["senior", "sr.", "sr ", "staff", "lead", "principal"];
