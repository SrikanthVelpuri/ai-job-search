/**
 * orchestrator.ts — the daily unattended run (plan Phase 6/7, design §2.7).
 *
 *   source → score (gate) → tailor (ATS resume + screening answers) → apply (guarded, dryrun) → report
 *
 * The deterministic pipeline here runs standalone (`npm run orchestrate`). Two stages have an
 * optional LLM-refined upgrade that Claude Code performs by delegating to existing repo assets:
 *   • scoring   — the heuristic `scoreJob` is the code gate; the MCP `score_fit` tool / the
 *                 `04-job-evaluation.md` framework can override it with a richer rationale.
 *   • CV+letter — the LaTeX CV + cover letter come from the `/apply-unattended` command
 *                 (drafter→reviewer→PDF loop). The orchestrator always produces the ATS-safe
 *                 resume + screening answers, which are what the clean-ATS apply engine needs.
 *
 * Nothing is ever submitted unless APPLY_MODE=live AND every guardrail passes.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import type { JobRow, ScoreResult, ScreeningQuestion } from "./types.js";
import { loadConfig } from "./config.js";
import { openTracker } from "./tracker/db.js";
import { loadProfile, loadWatchlist, loadAnswerBank } from "./profile.js";
import { sourceAll, type SourceRunResult } from "./sources/index.js";
import { scoreJob, passesThreshold } from "./scoring/score.js";
import { writeAtsResume } from "./tailoring/ats-resume.js";
import { generateScreeningAnswers } from "./tailoring/screening-answers.js";
import { applyToJob, type ApplyEngineResult } from "./apply/index.js";
import { writeReport, type ReportResult } from "./report.js";
import { killSwitchActive } from "./apply/guardrails.js";

/** Standard ATS questions every clean-ATS form asks; the live filler discovers the rest. */
const STANDARD_QUESTIONS: ScreeningQuestion[] = [
  { id: "work_auth", label: "Are you legally authorized to work in the United States?", type: "boolean", options: ["Yes", "No"], required: true },
  { id: "sponsorship", label: "Will you now or in the future require sponsorship for an employment visa?", type: "boolean", options: ["Yes", "No"], required: true },
  { id: "relocate", label: "Are you willing to relocate?", type: "boolean", options: ["Yes", "No"], required: false },
  { id: "gender", label: "Gender", type: "select", required: false },
  { id: "race", label: "Race / Ethnicity", type: "select", required: false },
  { id: "veteran", label: "Veteran status", type: "select", required: false },
  { id: "disability", label: "Disability status", type: "select", required: false },
];

export interface OrchestratorOptions {
  limitPerCompany?: number;
  /** Max guarded apply attempts this run (politeness; default 5). */
  maxApplyAttempts?: number;
  includeAdzuna?: boolean;
  skipSourcing?: boolean;
  /** Tailor + queue but do not run the apply engine (no browser). */
  skipApply?: boolean;
  titleKeywords?: string[];
}

export interface OrchestratorResult {
  startedAt: string;
  mode: string;
  killed: boolean;
  source: SourceRunResult | null;
  scored: number;
  passedThreshold: number;
  attempted: number;
  applyResults: ApplyEngineResult[];
  queued: number;
  report: ReportResult;
}

interface Scored {
  job: JobRow;
  score: ScoreResult;
}

export async function runOrchestrator(opts: OrchestratorOptions = {}): Promise<OrchestratorResult> {
  const startedAt = new Date().toISOString();
  const config = loadConfig();
  const tracker = openTracker(config.dbPath);
  const profile = loadProfile();
  const watchlist = loadWatchlist();
  const answerBank = loadAnswerBank();
  const cfg = config.guardrails;

  const killed = killSwitchActive(cfg);
  if (killed) {
    tracker.logEvent("warn", "orchestrator aborted: kill switch active (data/STOP)", "custom");
  }

  // ── 1. Source ───────────────────────────────────────────────────────────────
  let source: SourceRunResult | null = null;
  if (!killed && !opts.skipSourcing) {
    source = await sourceAll(tracker, watchlist, profile, config, {
      limitPerCompany: opts.limitPerCompany ?? 50,
      includeAdzuna: opts.includeAdzuna,
      titleKeywords: opts.titleKeywords,
    });
  }

  // ── 2. Score every unapplied job (heuristic gate) ────────────────────────────
  const unapplied = tracker.listJobs({ unapplied: true });
  const scoredList: Scored[] = [];
  for (const job of unapplied) {
    const score = scoreJob(job, profile);
    scoredList.push({ job, score });
  }
  const passing = scoredList
    .filter((s) => passesThreshold(s.score, cfg.fitThreshold))
    .sort((a, b) => b.score.overall - a.score.overall);

  // ── 3+4. Tailor + guarded apply for the top N; queue the overflow ────────────
  const maxApply = killed ? 0 : opts.maxApplyAttempts ?? 5;
  const applyResults: ApplyEngineResult[] = [];
  let attempted = 0;
  let queued = 0;
  const resumeDir = path.join(config.rootDir, "data", "resumes");

  for (let i = 0; i < passing.length; i++) {
    const entry = passing[i];
    if (!entry) continue;
    const { job, score } = entry;

    // Tailor: ATS-safe resume + screening answers (no fabrication).
    const { path: resumePath } = await writeAtsResume(profile, job, resumeDir);
    const answers = generateScreeningAnswers(job, STANDARD_QUESTIONS, profile, answerBank);

    if (opts.skipApply || attempted >= maxApply) {
      // Beyond the apply budget → record a ready queue entry for the next run / human.
      tracker.createApplication({
        jobId: job.id,
        lane: "custom",
        status: "queued",
        fitScore: score.overall,
        resumePath,
        answersJson: JSON.stringify(answers),
        mode: cfg.applyMode,
        notes: "queued (apply budget reached or skipApply)",
      });
      queued++;
      continue;
    }

    const result = await applyToJob({
      job,
      profile,
      artifacts: { resumePath },
      answers,
      score,
      tracker,
      config,
    });
    applyResults.push(result);
    attempted++;
  }

  // ── 5. Report ─────────────────────────────────────────────────────────────────
  tracker.touchLane("custom");
  const report = writeReport(tracker, config, startedAt);

  const result: OrchestratorResult = {
    startedAt,
    mode: cfg.applyMode,
    killed,
    source,
    scored: scoredList.length,
    passedThreshold: passing.length,
    attempted,
    applyResults,
    queued,
    report,
  };
  tracker.close();
  return result;
}

/** CLI entry: `tsx src/orchestrator.ts`. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts: OrchestratorOptions = {
    skipSourcing: argv.includes("--skip-sourcing"),
    skipApply: argv.includes("--skip-apply"),
    includeAdzuna: argv.includes("--adzuna"),
  };
  const maxFlag = argv.find((a) => a.startsWith("--max-apply="));
  if (maxFlag) opts.maxApplyAttempts = Number.parseInt(maxFlag.split("=")[1] ?? "5", 10);
  const limFlag = argv.find((a) => a.startsWith("--limit="));
  if (limFlag) opts.limitPerCompany = Number.parseInt(limFlag.split("=")[1] ?? "50", 10);

  const res = await runOrchestrator(opts);
  console.log(
    `\nOrchestrator [${res.mode}] done: sourced ${res.source?.totals.inserted ?? 0} new, scored ${res.scored}, ` +
      `${res.passedThreshold} ≥ threshold, attempted ${res.attempted}, queued ${res.queued}.`,
  );
  console.log(`Report: ${res.report.path}`);
  if (res.killed) console.log("⚠️  Kill switch was active — no apply attempts were made.");
}

// Run only when invoked directly (not when imported).
const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  main().catch((err) => {
    console.error("Orchestrator failed:", err);
    process.exit(1);
  });
}
