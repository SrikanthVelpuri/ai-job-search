/**
 * ats-report.ts — run ATS matching over the tracker and render a markdown report.
 */

import fs from "node:fs";
import path from "node:path";
import type { JobRow } from "../types.js";
import { atsMatchMany, type AtsMatchResult } from "./ats-match.js";

/** Platform-role filter: title OR jd signals ML/AI platform / infra / MLOps / serving work. */
export function isPlatformRole(job: JobRow): boolean {
  const t = job.title.toLowerCase();
  const jd = job.jdText.toLowerCase();
  const titleHit = /platform|mlops|ml infra|infrastructure|ml systems|distributed|serving|llmops|ml engineer|machine learning engineer|ai engineer|applied|research engineer/.test(t);
  const jdHit = /ml platform|ai platform|mlops|model serving|feature store|distributed training|inference|kubernetes|llmops/.test(jd);
  return titleHit || jdHit;
}

function band(score: number): string {
  if (score >= 80) return "🟢 strong";
  if (score >= 65) return "🟡 good";
  if (score >= 50) return "🟠 fair";
  return "🔴 weak";
}

export interface AtsReport {
  results: AtsMatchResult[];
  markdown: string;
  path: string;
}

export function runAtsMatch(
  resumeText: string,
  resumeName: string,
  jobs: JobRow[],
  rootDir: string,
  opts: { topDetail?: number } = {},
): AtsReport {
  const results = atsMatchMany(resumeText, jobs);
  const topDetail = opts.topDetail ?? 15;

  const lines: string[] = [];
  lines.push(`# ATS Match Report — ${resumeName}`);
  lines.push("");
  lines.push(`Scored **${results.length}** AI/ML platform jobs. Score = 75% JD hard-skill keyword coverage + 25% title alignment (Jobscan-style).`);
  lines.push("");
  const avg = results.length ? Math.round(results.reduce((a, r) => a + r.score, 0) / results.length) : 0;
  lines.push(`Average ATS match: **${avg}** · ≥80: ${results.filter((r) => r.score >= 80).length} · 65–79: ${results.filter((r) => r.score >= 65 && r.score < 80).length} · <65: ${results.filter((r) => r.score < 65).length}`);
  lines.push("");

  lines.push("## Ranked matches");
  lines.push("");
  lines.push("| # | ATS | Band | Company | Title | Remote | Job |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  results.forEach((r, i) => {
    lines.push(`| ${i + 1} | **${r.score}** | ${band(r.score)} | ${r.company} | ${r.title.slice(0, 52)} | ${r.remote ? "✅" : "—"} | [#${r.jobId}](${r.url}) |`);
  });
  lines.push("");

  lines.push(`## Top ${Math.min(topDetail, results.length)} — matched vs missing keywords`);
  lines.push("");
  for (const r of results.slice(0, topDetail)) {
    lines.push(`### ${r.score} · ${r.company} — ${r.title}`);
    lines.push(`[Apply](${r.url}) · keyword coverage ${r.keywordScore}% (${r.matched.length}/${r.jdKeywordCount}) · title ${r.titleScore}%`);
    lines.push("");
    lines.push(`- ✅ **Matched (${r.matched.length}):** ${r.matched.join(", ") || "—"}`);
    lines.push(`- ❌ **Missing — add if true (${r.missing.length}):** ${r.missing.join(", ") || "none 🎉"}`);
    lines.push("");
  }
  lines.push("---");
  lines.push("_Missing keywords are gaps the ATS will penalize. Add ONLY the ones you genuinely have — never fabricate._");

  const markdown = lines.join("\n");
  const dir = path.join(rootDir, "data", "reports");
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `ats-match-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(outPath, markdown, "utf8");
  return { results, markdown, path: outPath };
}
