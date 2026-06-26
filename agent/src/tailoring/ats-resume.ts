/**
 * ats-resume.ts — ATS-safe single-column plain-text resume (design §2.4).
 *
 * The moderncv LaTeX layout is visually polished but its two-column geometry and
 * font tricks routinely confuse applicant-tracking-system parsers (skills land in
 * the wrong field, dates get dropped). For unattended clean-ATS apply we therefore
 * emit a deterministic, single-column, ASCII-friendly TEXT resume that any parser
 * can read top-to-bottom.
 *
 * Rules (CLAUDE.md no-fabrication policy):
 *  - We NEVER invent experience, skills, or achievements to fill a gap. An empty
 *    profile field produces an omitted section plus a warning, not filler text.
 *  - We lightly tailor by *reordering* skills so those that literally appear in the
 *    job description sort first — we never add a skill the profile doesn't list.
 *  - Output is deterministic: no Date.now / timestamps are written into the text.
 *
 * Contract: all domain types come from ../types.js; helpers from ../profile.js.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobRow, Profile, ProfileEducation, ProfileExperience } from "../types.js";
import { SETUP_SENTINEL } from "../profile.js";
import { buildResumeDocx } from "./docx-resume.js";
import { atsMatch, type AtsMatchResult } from "../tooling/ats-match.js";

/** ASCII bullet prefix — never a unicode glyph (parsers choke on "•"). */
const BULLET = "- ";

/** A horizontal section rule, kept short + ASCII so it never wraps oddly. */
function sectionHeader(title: string): string {
  // Blank line, the uppercased label, then a dashed rule the width of the label.
  const label = title.toUpperCase();
  return `\n${label}\n${"-".repeat(label.length)}`;
}

/** True when a string is missing, blank, or still carries a /setup placeholder. */
function isPlaceholder(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.includes(SETUP_SENTINEL);
}

/** Keep only real, non-placeholder strings from a list (and trim them). */
function cleanList(values: readonly string[]): string[] {
  return values.map((v) => v.trim()).filter((v) => v !== "" && !v.includes(SETUP_SENTINEL));
}

/**
 * Order `skills` so any that appear (case-insensitive substring) in `jdText` come
 * first, preserving the profile's original relative order within each group. This
 * is the only "tailoring" — purely a stable reordering, no additions/removals.
 */
function orderSkillsByJd(skills: readonly string[], jdText: string): string[] {
  const cleaned = cleanList(skills);
  const jdLower = jdText.toLowerCase();
  const matched: string[] = [];
  const rest: string[] = [];
  for (const skill of cleaned) {
    // A skill "matches" when its (non-empty) text is a substring of the JD.
    const needle = skill.toLowerCase();
    if (needle.length > 0 && jdLower.includes(needle)) matched.push(skill);
    else rest.push(skill);
  }
  return [...matched, ...rest];
}

/** Format a date range like "2021-03 — Present" / "2019 — 2021". */
function formatDateRange(start: string, end: string | null): string {
  const s = start.trim();
  const e = end === null || end.trim() === "" ? "Present" : end.trim();
  if (s === "" ) return e;
  return `${s} — ${e}`;
}

/** Render one experience entry as a header line plus indented bullets. */
function renderExperience(exp: ProfileExperience): string[] {
  const lines: string[] = [];
  // "Title — Company, Location, dates" — drop empty fields so we never print ", ,".
  const left = [exp.title.trim(), exp.company.trim()].filter((s) => s !== "").join(" — ");
  const meta = [exp.location.trim(), formatDateRange(exp.start, exp.end)]
    .filter((s) => s !== "")
    .join(", ");
  const headline = [left, meta].filter((s) => s !== "").join(" | ");
  if (headline !== "") lines.push(headline);
  for (const bullet of cleanList(exp.bullets)) lines.push(`${BULLET}${bullet}`);
  return lines;
}

/** Render one education entry on a single line. */
function renderEducation(edu: ProfileEducation): string {
  // "Degree in Field, Institution (2015 — 2019)"
  const degreeField = [edu.degree.trim(), edu.field.trim()].filter((s) => s !== "").join(" in ");
  const range = formatDateRange(edu.start, edu.end);
  const head = [degreeField, edu.institution.trim()].filter((s) => s !== "").join(", ");
  const withRange = range !== "" ? `${head} (${range})` : head;
  return edu.notes && !isPlaceholder(edu.notes) ? `${withRange} — ${edu.notes.trim()}` : withRange;
}

/**
 * Build the ATS-safe plain-text resume.
 *
 * Sections are emitted in a fixed order; empty sections are skipped, and each
 * skipped-because-empty section adds a warning so the caller knows the resume is
 * thin and that /setup should be run.
 */
export function buildAtsResume(
  profile: Profile,
  job: JobRow,
): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  const blocks: string[] = [];

  // ── Header: name ─────────────────────────────────────────────────────────────
  if (isPlaceholder(profile.identity.name)) {
    warnings.push("identity.name empty — resume has no name; run /setup");
  } else {
    blocks.push(profile.identity.name.trim());
  }

  // ── Contact line: email / phone / location / linkedin / github, real values only.
  const contactParts: string[] = [];
  const c = profile.contact;
  if (!isPlaceholder(c.email)) contactParts.push(c.email.trim());
  if (!isPlaceholder(c.phone)) contactParts.push((c.phone as string).trim());
  if (!isPlaceholder(c.location)) contactParts.push(c.location.trim());
  if (!isPlaceholder(c.linkedin)) contactParts.push((c.linkedin as string).trim());
  if (!isPlaceholder(c.github)) contactParts.push((c.github as string).trim());
  if (!isPlaceholder(c.website)) contactParts.push((c.website as string).trim());
  if (contactParts.length > 0) blocks.push(contactParts.join(" | "));
  else warnings.push("contact empty — no contact details; run /setup");

  // ── Summary ──────────────────────────────────────────────────────────────────
  if (!isPlaceholder(profile.identity.summary)) {
    blocks.push(`${sectionHeader("Summary")}\n${profile.identity.summary.trim()}`);
  } else {
    warnings.push("identity.summary empty — no summary section; run /setup");
  }

  // ── Optional headline (only if real; not a required section). ──────────────────
  if (!isPlaceholder(profile.identity.headline)) {
    blocks.push(`${sectionHeader("Headline")}\n${profile.identity.headline.trim()}`);
  }

  // ── Skills (primary / secondary / tools), reordered by JD relevance. ───────────
  const primary = orderSkillsByJd(profile.skills.primary, job.jdText);
  const secondary = orderSkillsByJd(profile.skills.secondary, job.jdText);
  const tools = orderSkillsByJd(profile.skills.tools, job.jdText);
  const skillLines: string[] = [];
  if (primary.length > 0) skillLines.push(`Primary: ${primary.join(", ")}`);
  if (secondary.length > 0) skillLines.push(`Secondary: ${secondary.join(", ")}`);
  if (tools.length > 0) skillLines.push(`Tools: ${tools.join(", ")}`);
  if (skillLines.length > 0) {
    blocks.push(`${sectionHeader("Skills")}\n${skillLines.join("\n")}`);
  } else {
    warnings.push("skills empty — no skills section; run /setup");
  }

  // ── Experience ─────────────────────────────────────────────────────────────────
  if (profile.experience.length > 0) {
    const entries = profile.experience.map((e) => renderExperience(e).join("\n"));
    blocks.push(`${sectionHeader("Experience")}\n${entries.join("\n\n")}`);
  } else {
    warnings.push("experience empty — resume will be thin; run /setup");
  }

  // ── Education ────────────────────────────────────────────────────────────────
  if (profile.education.length > 0) {
    const entries = profile.education.map((e) => `${BULLET}${renderEducation(e)}`);
    blocks.push(`${sectionHeader("Education")}\n${entries.join("\n")}`);
  } else {
    warnings.push("education empty — no education section; run /setup");
  }

  // ── Certifications ───────────────────────────────────────────────────────────
  const certs = cleanList(profile.certifications);
  if (certs.length > 0) {
    blocks.push(`${sectionHeader("Certifications")}\n${certs.map((x) => `${BULLET}${x}`).join("\n")}`);
  } else if (profile.certifications.length === 0) {
    // Certs are optional, so only warn when the field is an explicit TODO placeholder
    // sentinel-bearing list; an honestly-empty list is fine and silent. Empty array →
    // no warning (many candidates have no certifications).
  }

  // ── Publications ─────────────────────────────────────────────────────────────
  const pubs = cleanList(profile.publications);
  if (pubs.length > 0) {
    blocks.push(`${sectionHeader("Publications")}\n${pubs.map((x) => `${BULLET}${x}`).join("\n")}`);
  }

  // ── Awards ───────────────────────────────────────────────────────────────────
  const awards = cleanList(profile.awards);
  if (awards.length > 0) {
    blocks.push(`${sectionHeader("Awards")}\n${awards.map((x) => `${BULLET}${x}`).join("\n")}`);
  }

  // Join blocks; collapse any run of 3+ newlines so output stays tidy + deterministic.
  const text = blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  return { text, warnings };
}

/** Lowercase + collapse any non-alphanumeric run to a single underscore. */
function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug === "" ? "company" : slug;
}

/**
 * Write the ATS resume to {outDir}/ats_resume_{companySlug}_{jobId}.txt.
 * Creates outDir (recursively) if needed. Returns the absolute-or-given path
 * plus the same warnings buildAtsResume produced.
 */
export async function writeAtsResume(
  profile: Profile,
  job: JobRow,
  outDir: string,
): Promise<{ path: string; warnings: string[] }> {
  const { text, warnings } = buildAtsResume(profile, job);
  await mkdir(outDir, { recursive: true });
  const fileName = `ats_resume_${slugify(job.company)}_${job.id}.txt`;
  const filePath = path.join(outDir, fileName);
  await writeFile(filePath, text, "utf8");
  return { path: filePath, warnings };
}

/** Tailored resume artifacts for one job: plain-text + Word, plus the ATS keyword score. */
export interface TailoredArtifacts {
  /** Plain-text resume (kept for scoring / debugging). */
  txtPath: string;
  /** Reliable Word (.docx) resume — the artifact uploaded to ATS forms. */
  docxPath: string;
  /** ATS keyword-match score of the tailored resume against THIS job's JD. */
  ats: AtsMatchResult;
  warnings: string[];
}

/**
 * Build + persist the tailored resume in BOTH formats and score it for this job.
 *
 * The plain-text resume is the single source of truth; the .docx is rendered from
 * the exact same text (so they never diverge) and is what the apply engine uploads,
 * because ATS widgets parse Word more reliably than .txt. The ATS keyword score is
 * computed here, at generation time, so the operator/orchestrator can see how well
 * the resume keyword-matches the posting (and which JD keywords are missing) before
 * anything is submitted.
 */
export async function writeTailoredArtifacts(
  profile: Profile,
  job: JobRow,
  outDir: string,
): Promise<TailoredArtifacts> {
  const { text, warnings } = buildAtsResume(profile, job);
  await mkdir(outDir, { recursive: true });
  const base = `ats_resume_${slugify(job.company)}_${job.id}`;
  const txtPath = path.join(outDir, `${base}.txt`);
  const docxPath = path.join(outDir, `${base}.docx`);
  await writeFile(txtPath, text, "utf8");
  await writeFile(docxPath, await buildResumeDocx(text));
  const ats = atsMatch(text, job);
  return { txtPath, docxPath, ats, warnings };
}
