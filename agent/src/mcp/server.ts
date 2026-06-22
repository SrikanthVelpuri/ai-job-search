/**
 * mcp/server.ts — the shared MCP server (plan Phase 3, design §2/§5).
 *
 * Exposes the system's capabilities as MCP tools over stdio so BOTH Claude Code (scheduled,
 * unattended) and Claude Desktop (interactive review) drive the SAME tracker DB with identical
 * behavior. Tools (design §1): search_jobs · score_fit · tailor_application · fill_form · track ·
 * report — plus halt/resume (the kill switch, guardrails.md §4).
 *
 * Launch: `npm run mcp` (or `tsx src/mcp/server.ts`). Register it in the client's MCP config.
 */

import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { openTracker } from "../tracker/db.js";
import { loadProfile, loadWatchlist, loadAnswerBank } from "../profile.js";
import { sourceAll } from "../sources/index.js";
import { scoreJob, passesThreshold } from "../scoring/score.js";
import { writeAtsResume } from "../tailoring/ats-resume.js";
import { generateScreeningAnswers } from "../tailoring/screening-answers.js";
import { applyToJob } from "../apply/index.js";
import { writeReport } from "../report.js";
import { ingestAiApplyCsv } from "../lanes/aiapply.js";
import { ingestJobrightCsv } from "../lanes/jobright.js";
import { killSwitchActive } from "../apply/guardrails.js";
import type { ApplicationStatus, ScreeningQuestion } from "../types.js";

const config = loadConfig();

const STANDARD_QUESTIONS: ScreeningQuestion[] = [
  { id: "work_auth", label: "Are you legally authorized to work in the United States?", type: "boolean", options: ["Yes", "No"], required: true },
  { id: "sponsorship", label: "Will you now or in the future require sponsorship for an employment visa?", type: "boolean", options: ["Yes", "No"], required: true },
  { id: "relocate", label: "Are you willing to relocate?", type: "boolean", options: ["Yes", "No"], required: false },
  { id: "gender", label: "Gender", type: "select", required: false },
];

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({ name: "job-apply", version: "0.1.0" });

// ── search_jobs: run the sourcing pipeline (connectors → prefilter → dedup-insert) ──────────
server.registerTool(
  "search_jobs",
  {
    title: "Search / source jobs",
    description: "Run the sourcing pipeline across the verified watchlist (Greenhouse/Lever/Ashby + optional Adzuna), apply the H-1B hard pre-filter, and dedup-insert new jobs into the tracker. Returns per-company counts.",
    inputSchema: {
      limitPerCompany: z.number().int().positive().max(200).optional(),
      includeAdzuna: z.boolean().optional(),
    },
  },
  async ({ limitPerCompany, includeAdzuna }) => {
    const t = openTracker(config.dbPath);
    try {
      const res = await sourceAll(t, loadWatchlist(), loadProfile(), config, {
        limitPerCompany: limitPerCompany ?? 50,
        includeAdzuna: includeAdzuna ?? false,
      });
      return json(res);
    } finally {
      t.close();
    }
  },
);

// ── score_fit: heuristic baseline score for a job (or all unapplied) ─────────────────────────
server.registerTool(
  "score_fit",
  {
    title: "Score job fit",
    description: "Score a job against the profile (hard pre-filters + 04-job-evaluation weighting). Pass a jobId, or omit to score all unapplied jobs. This is the deterministic gate; an LLM may refine the rationale.",
    inputSchema: { jobId: z.number().int().optional() },
  },
  async ({ jobId }) => {
    const t = openTracker(config.dbPath);
    const profile = loadProfile();
    try {
      if (jobId !== undefined) {
        const job = t.getJob(jobId);
        if (!job) return json({ error: `job ${jobId} not found` });
        const score = scoreJob(job, profile);
        return json({ job: { id: job.id, company: job.company, title: job.title }, score, passes: passesThreshold(score, config.guardrails.fitThreshold) });
      }
      const jobs = t.listJobs({ unapplied: true });
      const scored = jobs
        .map((j) => ({ jobId: j.id, company: j.company, title: j.title, ats: j.ats, ...summarizeScore(scoreJob(j, profile)) }))
        .sort((a, b) => b.overall - a.overall);
      return json({ count: scored.length, threshold: config.guardrails.fitThreshold, scored });
    } finally {
      t.close();
    }
  },
);

function summarizeScore(s: ReturnType<typeof scoreJob>) {
  return { overall: s.overall, verdict: s.verdict, prefilterPass: s.prefilter.pass, locationPass: s.locationPass };
}

// ── tailor_application: ATS resume + screening answers (no fabrication) ──────────────────────
server.registerTool(
  "tailor_application",
  {
    title: "Tailor application artifacts",
    description: "Produce the ATS-safe resume + screening-answer set for a job, grounded only in profile.json + answer-bank.md. Flags any unanswerable required question (no fabrication). The LaTeX CV + cover letter come separately from the /apply-unattended command.",
    inputSchema: { jobId: z.number().int() },
  },
  async ({ jobId }) => {
    const t = openTracker(config.dbPath);
    const profile = loadProfile();
    try {
      const job = t.getJob(jobId);
      if (!job) return json({ error: `job ${jobId} not found` });
      const { path: resumePath, warnings } = await writeAtsResume(profile, job, path.join(config.rootDir, "data", "resumes"));
      const answers = generateScreeningAnswers(job, STANDARD_QUESTIONS, profile, loadAnswerBank());
      return json({ jobId, resumePath, warnings, hasUnanswerable: answers.hasUnanswerable, answers: answers.answers });
    } finally {
      t.close();
    }
  },
);

// ── fill_form: the guarded apply engine (dryrun by default) ──────────────────────────────────
server.registerTool(
  "fill_form",
  {
    title: "Fill (and, if live, submit) an application form",
    description: "Run the guarded apply engine for a job: evaluate guardrails → fill the ATS form → screenshot → (dryrun: STOP before submit / live: submit). Writes a full audit record. APPLY_MODE defaults to dryrun; nothing is submitted unless explicitly live AND every guardrail passes.",
    inputSchema: { jobId: z.number().int() },
  },
  async ({ jobId }) => {
    const t = openTracker(config.dbPath);
    const profile = loadProfile();
    try {
      const job = t.getJob(jobId);
      if (!job) return json({ error: `job ${jobId} not found` });
      const score = scoreJob(job, profile);
      const { path: resumePath } = await writeAtsResume(profile, job, path.join(config.rootDir, "data", "resumes"));
      const answers = generateScreeningAnswers(job, STANDARD_QUESTIONS, profile, loadAnswerBank());
      const res = await applyToJob({ job, profile, artifacts: { resumePath }, answers, score, tracker: t, config });
      return json({ mode: config.guardrails.applyMode, ...res });
    } finally {
      t.close();
    }
  },
);

// ── track: read/update the tracker (status, lists, ingest, status-update) ────────────────────
server.registerTool(
  "track",
  {
    title: "Track / query / update applications",
    description: "Query and update the shared tracker. action='status' (counts + guardrails), 'list_jobs', 'list_applications', 'update_status' (needs applicationId+status), 'ingest_aiapply'/'ingest_jobright' (needs csvPath).",
    inputSchema: {
      action: z.enum(["status", "list_jobs", "list_applications", "update_status", "ingest_aiapply", "ingest_jobright"]),
      lane: z.enum(["custom", "aiapply", "jobright"]).optional(),
      limit: z.number().int().positive().max(500).optional(),
      applicationId: z.number().int().optional(),
      status: z.string().optional(),
      csvPath: z.string().optional(),
    },
  },
  async ({ action, lane, limit, applicationId, status, csvPath }) => {
    const t = openTracker(config.dbPath);
    try {
      switch (action) {
        case "status":
          return json({
            jobs: t.countJobs(),
            mode: config.guardrails.applyMode,
            killSwitch: killSwitchActive(config.guardrails),
            lanes: t.getLanes(),
            applications: { custom: t.listApplications({ lane: "custom" }).length, aiapply: t.listApplications({ lane: "aiapply" }).length, jobright: t.listApplications({ lane: "jobright" }).length },
          });
        case "list_jobs":
          return json(t.listJobs({ limit: limit ?? 50 }));
        case "list_applications":
          return json(t.listApplications({ lane, limit: limit ?? 50 }));
        case "update_status":
          if (applicationId === undefined || !status) return json({ error: "update_status needs applicationId + status" });
          t.updateApplication(applicationId, { status: status as ApplicationStatus });
          return json({ updated: applicationId, status });
        case "ingest_aiapply":
          if (!csvPath) return json({ error: "ingest_aiapply needs csvPath" });
          return json(ingestAiApplyCsv(csvPath, t));
        case "ingest_jobright":
          if (!csvPath) return json({ error: "ingest_jobright needs csvPath" });
          return json(ingestJobrightCsv(csvPath, t));
      }
    } finally {
      t.close();
    }
  },
);

// ── report: write + return the dated markdown report ─────────────────────────────────────────
server.registerTool(
  "report",
  {
    title: "Generate the daily report",
    description: "Build + write the dated markdown report (new matches, drafts, per-lane response rates, guardrail status) to data/reports/ and return its markdown.",
    inputSchema: {},
  },
  async () => {
    const t = openTracker(config.dbPath);
    try {
      const r = writeReport(t, config);
      return { content: [{ type: "text" as const, text: r.markdown }] };
    } finally {
      t.close();
    }
  },
);

// ── halt / resume: the kill switch (guardrails.md §4) ────────────────────────────────────────
server.registerTool(
  "halt",
  { title: "Engage kill switch", description: "Write the kill file (data/STOP). The orchestrator/apply engine halts before the next submit. Both clients can call this.", inputSchema: {} },
  async () => {
    fs.mkdirSync(path.dirname(config.guardrails.killFile), { recursive: true });
    fs.writeFileSync(config.guardrails.killFile, `halted at ${new Date().toISOString()}\n`, "utf8");
    return json({ killSwitch: true, killFile: config.guardrails.killFile });
  },
);

server.registerTool(
  "resume",
  { title: "Release kill switch", description: "Remove the kill file (data/STOP).", inputSchema: {} },
  async () => {
    if (fs.existsSync(config.guardrails.killFile)) fs.rmSync(config.guardrails.killFile);
    return json({ killSwitch: false });
  },
);

async function main(): Promise<void> {
  // Ensure the DB exists before serving.
  openTracker(config.dbPath).close();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout is the MCP channel.
  process.stderr.write(`[job-apply MCP] serving on stdio · db=${config.dbPath} · mode=${config.guardrails.applyMode}\n`);
}

main().catch((err) => {
  process.stderr.write(`[job-apply MCP] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
