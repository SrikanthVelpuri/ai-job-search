/**
 * cli.ts — operator entry point for the job-apply system.
 *
 * Usage:
 *   tsx src/cli.ts db init
 *   tsx src/cli.ts source [--adzuna] [--limit=N]
 *   tsx src/cli.ts score [--persist]
 *   tsx src/cli.ts report
 *   tsx src/cli.ts apply <jobId>
 *   tsx src/cli.ts ingest aiapply <csvPath>
 *   tsx src/cli.ts ingest jobright <csvPath>
 *   tsx src/cli.ts halt | resume        # kill switch on/off (guardrails.md §4)
 *   tsx src/cli.ts status
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { openTracker } from "./tracker/db.js";
import { loadProfile, loadWatchlist, loadAnswerBank } from "./profile.js";
import { sourceAll } from "./sources/index.js";
import { scoreJob, passesThreshold } from "./scoring/score.js";
import { writeTailoredArtifacts } from "./tailoring/ats-resume.js";
import { generateScreeningAnswers } from "./tailoring/screening-answers.js";
import { applyToJob } from "./apply/index.js";
import { writeReport } from "./report.js";
import { ingestAiApplyCsv } from "./lanes/aiapply.js";
import { ingestJobrightCsv } from "./lanes/jobright.js";
import { killSwitchActive } from "./apply/guardrails.js";
import { runAtsMatch, isPlatformRole } from "./tooling/ats-report.js";
import type { ScreeningQuestion } from "./types.js";

const STANDARD_QUESTIONS: ScreeningQuestion[] = [
  { id: "work_auth", label: "Are you legally authorized to work in the United States?", type: "boolean", options: ["Yes", "No"], required: true },
  { id: "sponsorship", label: "Will you now or in the future require sponsorship for an employment visa?", type: "boolean", options: ["Yes", "No"], required: true },
  { id: "relocate", label: "Are you willing to relocate?", type: "boolean", options: ["Yes", "No"], required: false },
  { id: "gender", label: "Gender", type: "select", required: false },
];

function flag(argv: string[], name: string): string | undefined {
  const f = argv.find((a) => a.startsWith(`--${name}=`));
  return f ? f.split("=")[1] : undefined;
}

async function main(): Promise<void> {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  const argv = process.argv.slice(2);
  const config = loadConfig();

  switch (cmd) {
    case "db": {
      if (sub === "init") {
        const t = openTracker(config.dbPath);
        console.log(`DB ready at ${config.dbPath} (jobs: ${t.countJobs()})`);
        t.close();
      } else {
        console.error("usage: db init");
        process.exit(1);
      }
      break;
    }

    case "source": {
      const t = openTracker(config.dbPath);
      const profile = loadProfile();
      const watchlist = loadWatchlist();
      const limit = flag(argv, "limit");
      const res = await sourceAll(t, watchlist, profile, config, {
        includeAdzuna: argv.includes("--adzuna"),
        limitPerCompany: limit ? Number.parseInt(limit, 10) : 50,
      });
      console.log(`Sourced: ${res.totals.inserted} new, ${res.totals.duplicates} dup, ${res.totals.prefilteredOut} pre-filtered, ${res.totals.errors} errors.`);
      for (const c of res.companies) {
        console.log(`  ${c.company} (${c.ats}): +${c.inserted} new / ${c.fetched} fetched${c.error ? ` [ERR: ${c.error}]` : ""}`);
      }
      if (res.adzuna) console.log(`  adzuna: +${res.adzuna.inserted} new${res.adzuna.error ? ` [ERR: ${res.adzuna.error}]` : ""}`);
      t.close();
      break;
    }

    case "score": {
      const t = openTracker(config.dbPath);
      const profile = loadProfile();
      const jobs = t.listJobs({ unapplied: true });
      const scored = jobs.map((j) => ({ j, s: scoreJob(j, profile) })).sort((a, b) => b.s.overall - a.s.overall);
      const passing = scored.filter((x) => passesThreshold(x.s, config.guardrails.fitThreshold));
      console.log(`Scored ${scored.length} unapplied jobs; ${passing.length} ≥ threshold ${config.guardrails.fitThreshold}.`);
      for (const { j, s } of scored.slice(0, 20)) {
        console.log(`  [${s.overall.toFixed(0).padStart(3)}] ${s.verdict.padEnd(8)} ${j.company} — ${j.title.slice(0, 55)}`);
      }
      if (argv.includes("--persist")) {
        for (const { j, s } of passing) {
          t.createApplication({ jobId: j.id, lane: "custom", status: "scored", fitScore: s.overall, mode: config.guardrails.applyMode, notes: `scored ${s.verdict}` });
        }
        console.log(`Persisted ${passing.length} 'scored' application rows.`);
      }
      t.close();
      break;
    }

    case "apply": {
      const jobId = Number.parseInt(sub ?? "", 10);
      if (!Number.isFinite(jobId)) {
        console.error("usage: apply <jobId>");
        process.exit(1);
      }
      const t = openTracker(config.dbPath);
      const profile = loadProfile();
      const answerBank = loadAnswerBank();
      const job = t.getJob(jobId);
      if (!job) {
        console.error(`job ${jobId} not found`);
        process.exit(1);
      }
      const score = scoreJob(job, profile);
      const { txtPath, docxPath, ats, warnings } = await writeTailoredArtifacts(profile, job, `${config.rootDir}/data/resumes`);
      if (warnings.length) console.log(`  resume warnings: ${warnings.join("; ")}`);
      console.log(`  ATS match: ${ats.score}/100 (keywords ${ats.keywordScore}%, title ${ats.titleScore}%, ${ats.matched.length}/${ats.jdKeywordCount} JD terms) → ${path.basename(docxPath)}`);
      if (ats.missing.length) console.log(`  ATS gaps (JD terms not in resume): ${ats.missing.slice(0, 12).join(", ")}`);
      t.logEvent("info", `ATS ${ats.score}/100 for job ${jobId} (${job.company}); resume ${path.basename(docxPath)} / ${path.basename(txtPath)}`, "custom");
      const answers = generateScreeningAnswers(job, STANDARD_QUESTIONS, profile, answerBank);
      // Upload the Word doc (ATS parses .docx most reliably); pass the ATS score for the live gate.
      const res = await applyToJob({ job, profile, artifacts: { resumePath: docxPath }, answers, score, atsScore: ats.score, tracker: t, config });
      console.log(`apply [${config.guardrails.applyMode}] job ${jobId} → ${res.status}`);
      console.log(`  allowed: ${res.decision.allowed}${res.decision.blockReasons.length ? ` (${res.decision.blockReasons.join("; ")})` : ""}`);
      if (res.fill) console.log(`  outcome: ${res.fill.outcome}, submitted: ${res.fill.submitted}, screenshot: ${res.fill.screenshotPath ?? "none"}`);
      t.close();
      break;
    }

    case "ingest": {
      const csv = rest[0];
      if (!csv || (sub !== "aiapply" && sub !== "jobright")) {
        console.error("usage: ingest <aiapply|jobright> <csvPath>");
        process.exit(1);
      }
      const t = openTracker(config.dbPath);
      const res = sub === "aiapply" ? ingestAiApplyCsv(csv, t) : ingestJobrightCsv(csv, t);
      t.touchLane(sub);
      console.log(`Ingested ${sub}: ${res.rowsRead} rows, ${res.jobsUpserted} jobs, ${res.applicationsCreated} apps, ${res.duplicatesSkipped} dup, ${res.errors.length} errors.`);
      for (const e of res.errors.slice(0, 5)) console.log(`  err: ${e}`);
      t.close();
      break;
    }

    case "report": {
      const t = openTracker(config.dbPath);
      const r = writeReport(t, config);
      console.log(`Report written: ${r.path}`);
      t.close();
      break;
    }

    case "ats": {
      // usage: ats <resumePath> [--platform] [--top=N] [--min=N]
      const resumePath = sub;
      if (!resumePath || !fs.existsSync(resumePath)) {
        console.error("usage: ats <resumePath> [--platform] [--top=N] [--min=N]");
        process.exit(1);
      }
      const t = openTracker(config.dbPath);
      const resumeText = fs.readFileSync(resumePath, "utf8");
      let jobs = t.listJobs({ limit: 1000 });
      if (argv.includes("--platform")) jobs = jobs.filter(isPlatformRole);
      const minScore = flag(argv, "min");
      const topDetail = Number.parseInt(flag(argv, "top") ?? "15", 10);
      const r = runAtsMatch(resumeText, resumePath.split(/[\\/]/).pop() ?? "resume", jobs, config.rootDir, { topDetail });
      const shown = minScore ? r.results.filter((x) => x.score >= Number.parseInt(minScore, 10)) : r.results;
      console.log(`ATS-scored ${r.results.length} jobs against ${resumePath.split(/[\\/]/).pop()}.`);
      for (const x of shown.slice(0, topDetail)) {
        console.log(`  [${String(x.score).padStart(3)}] ${x.company.padEnd(14)} ${x.title.slice(0, 48).padEnd(48)} ${x.remote ? "remote" : ""}`);
      }
      console.log(`\nFull report: ${r.path}`);
      t.close();
      break;
    }

    case "halt": {
      fs.mkdirSync(config.rootDir + "/data", { recursive: true });
      fs.writeFileSync(config.guardrails.killFile, `halted at ${new Date().toISOString()}\n`, "utf8");
      console.log(`🛑 Kill switch ON — wrote ${config.guardrails.killFile}. The orchestrator will not submit until removed.`);
      break;
    }

    case "resume": {
      if (fs.existsSync(config.guardrails.killFile)) fs.rmSync(config.guardrails.killFile);
      console.log(`Kill switch OFF — removed ${config.guardrails.killFile}.`);
      break;
    }

    case "status": {
      const t = openTracker(config.dbPath);
      const g = config.guardrails;
      console.log(`Mode: ${g.applyMode} | daily cap: ${g.dailyCap} | fit threshold: ${g.fitThreshold} | allowlist: ${g.atsAllowlist.join(",")}`);
      console.log(`Kill switch: ${killSwitchActive(g) ? "🛑 ACTIVE" : "off"} (${g.killFile})`);
      console.log(`Jobs: ${t.countJobs()} | custom apps: ${t.listApplications({ lane: "custom" }).length} | aiapply: ${t.listApplications({ lane: "aiapply" }).length} | jobright: ${t.listApplications({ lane: "jobright" }).length}`);
      t.close();
      break;
    }

    default:
      console.log("commands: db init | source | score | ats <resume> [--platform] | apply <id> | ingest <aiapply|jobright> <csv> | report | halt | resume | status");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error("CLI error:", err);
  process.exit(1);
});
