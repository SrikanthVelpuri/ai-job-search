/**
 * score.ts — DETERMINISTIC heuristic baseline scorer (design §2.3, 04-job-evaluation.md).
 *
 * This is the CODE GATE that runs on every job that survives the hard pre-filter. It is a
 * cheap, reproducible heuristic — NOT the final word. The MCP `score_fit` tool may invoke
 * an LLM to refine/override these numbers with real semantic judgement; this baseline
 * exists so that (a) the pipeline can rank and threshold jobs without an LLM call, and
 * (b) there is always a sane floor/ceiling if the LLM is unavailable.
 *
 * Dimensions, weights and verdict thresholds mirror 04-job-evaluation.md EXACTLY:
 *   technical 30% · experience 25% · behavioral 15% · career 30%   (location is pass/fail)
 *   verdict: >=75 strong · 60-74 good · 45-59 moderate · 30-44 weak · <30 poor
 */

import type { JobRow, Profile, ScoreDimensions, ScoreResult, Verdict } from "../types.js";
import { prefilter } from "./filters.js";

// ─────────────────────────────────────────────────────────────────────────────
// Dimension weights — must sum to 1.0 (04-job-evaluation.md §Weighting).
// ─────────────────────────────────────────────────────────────────────────────
const WEIGHTS = { technical: 0.3, experience: 0.25, behavioral: 0.15, career: 0.3 } as const;

/** Verdict buckets, ordered high→low (04-job-evaluation.md §Thresholds). */
function toVerdict(overall: number): Verdict {
  if (overall >= 75) return "strong";
  if (overall >= 60) return "good";
  if (overall >= 45) return "moderate";
  if (overall >= 30) return "weak";
  return "poor";
}

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

// ─────────────────────────────────────────────────────────────────────────────
// Tokenization + overlap
// ─────────────────────────────────────────────────────────────────────────────

/** A small stop-word set so common English words don't inflate keyword overlap. */
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "you", "our", "are", "will", "have", "this", "that",
  "from", "your", "all", "can", "who", "but", "not", "they", "their", "what", "into",
  "team", "role", "work", "experience", "years", "year", "ability", "strong", "join",
  "looking", "including", "across", "within", "etc", "such", "able", "help", "more",
]);

/** Lowercase → split on non-alphanumerics → drop short/stop tokens. Returns a Set. */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9+#./]+/)) {
    const tok = raw.replace(/^[.+#/-]+|[.+#/-]+$/g, "");
    if (tok.length < 3) continue; // keeps "go"/"ml" out but those are matched via phrases
    if (STOP_WORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

/**
 * Multi-word skills ("machine learning", "amazon sagemaker") would be lost by single-token
 * matching, so we ALSO test each skill phrase as a lowercased substring of the JD. Returns
 * the subset of `phrases` present in `jdLower`.
 */
function matchedPhrases(phrases: string[], jdLower: string): string[] {
  const hits: string[] = [];
  for (const p of phrases) {
    const needle = p.trim().toLowerCase();
    if (needle.length < 2) continue;
    if (jdLower.includes(needle)) hits.push(p);
  }
  return hits;
}

/** Tokenize a list of skill phrases into one flat token Set (for single-word overlap). */
function tokensOf(phrases: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of phrases) for (const t of tokenize(p)) out.add(t);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual dimension scorers — each returns 0-100 plus a note for strengths/gaps.
// ─────────────────────────────────────────────────────────────────────────────

interface DimResult {
  score: number;
  /** Optional strength note (added when the score is good). */
  strength?: string;
  /** Optional gap note (added when the score is weak or data is missing). */
  gap?: string;
}

/**
 * TECHNICAL (30%): keyword overlap between the JD and the candidate's skills (primary,
 * secondary, tools) plus the tokens of their target titles. Primary skills are weighted
 * 2x. Score scales with the fraction of the candidate's skill vocabulary the JD mentions.
 *
 * When the profile has no skills populated yet (common right after /setup), we cannot
 * judge technical fit, so we return a neutral 50 and flag it as a gap.
 */
function scoreTechnical(job: JobRow, profile: Profile): DimResult {
  const jdLower = job.jdText.toLowerCase();
  const { primary, secondary, tools } = profile.skills;
  const titleTokenSkills = profile.preferences.titles; // title phrases count toward technical signal

  const haveAnySkills = primary.length + secondary.length + tools.length > 0;
  if (!haveAnySkills) {
    return {
      score: 50,
      gap: "Profile skills not populated — technical fit is a neutral estimate (run /setup or /expand).",
    };
  }

  // Phrase hits (multi-word, weighted) + single-token overlap (catches stemless variants).
  const primaryHits = matchedPhrases(primary, jdLower);
  const secondaryHits = matchedPhrases(secondary, jdLower);
  const toolHits = matchedPhrases(tools, jdLower);
  const titleHits = matchedPhrases(titleTokenSkills, jdLower);

  const jdTokens = tokenize(job.jdText);
  const primaryTok = tokensOf(primary);
  const secondaryTok = tokensOf([...secondary, ...tools]);
  const primaryTokenOverlap = [...primaryTok].filter((t) => jdTokens.has(t)).length;
  const secondaryTokenOverlap = [...secondaryTok].filter((t) => jdTokens.has(t)).length;

  // Weighted hit count: primary skills matter most. Phrase + token hits both contribute.
  const weighted =
    primaryHits.length * 2 +
    primaryTokenOverlap * 2 +
    secondaryHits.length +
    toolHits.length +
    secondaryTokenOverlap +
    titleHits.length;

  // Denominator: the size of the (weighted) candidate vocabulary. We don't require the JD
  // to mention EVERY skill, so saturate quickly — ~40% coverage already reads as strong.
  const denom = Math.max(1, primary.length * 2 + secondary.length + tools.length);
  const coverage = weighted / denom; // can exceed 1 when token + phrase both fire
  const score = clamp(35 + coverage * 90); // floor 35, saturates well before 100

  const topHits = [...primaryHits, ...secondaryHits, ...toolHits].slice(0, 5);
  if (score >= 70 && topHits.length) {
    return { score, strength: `Strong skills overlap: ${topHits.join(", ")}.` };
  }
  if (score < 50) {
    return { score, gap: "Few of the candidate's core skills appear in the job description." };
  }
  return { score, ...(topHits.length ? { strength: `Skills overlap: ${topHits.join(", ")}.` } : {}) };
}

/**
 * EXPERIENCE (25%): overlap of the JD with the candidate's prior job titles and bullet
 * text. When experience is empty (placeholder profile), return a NEUTRAL 55 with a note —
 * we must not penalize a not-yet-populated profile.
 */
function scoreExperience(job: JobRow, profile: Profile): DimResult {
  if (profile.experience.length === 0) {
    return { score: 55, gap: "Profile experience not populated — experience fit is a neutral estimate." };
  }

  const jdLower = job.jdText.toLowerCase();
  const jdTokens = tokenize(job.jdText);

  // Title-phrase hits are strong evidence of role-type alignment.
  const titles = profile.experience.map((e) => e.title);
  const titleHits = matchedPhrases(titles, jdLower);

  // Bullet token overlap captures domain/responsibility alignment.
  const bulletTokens = tokensOf(profile.experience.flatMap((e) => e.bullets));
  const bulletOverlap = [...bulletTokens].filter((t) => jdTokens.has(t)).length;
  const bulletCoverage = bulletTokens.size ? bulletOverlap / bulletTokens.size : 0;

  const score = clamp(45 + titleHits.length * 12 + bulletCoverage * 60);

  if (score >= 70) {
    const note = titleHits.length
      ? `Prior role(s) match: ${titleHits.join(", ")}.`
      : "Prior responsibilities align with the job description.";
    return { score, strength: note };
  }
  if (score < 50) {
    return { score, gap: "Limited overlap between prior experience and this role's responsibilities." };
  }
  return { score };
}

/**
 * BEHAVIORAL (15%): a flat neutral baseline of 60. The heuristic layer has no signal for
 * culture/behavioral fit — that is exactly the kind of judgement the LLM `score_fit`
 * refinement is meant to supply (04-job-evaluation.md §3, "research reviews/media").
 */
function scoreBehavioral(): DimResult {
  return { score: 60 };
}

/**
 * CAREER (30%): title-fit against the candidate's target titles, plus a seniority-match
 * boost and a sponsorship boost (+10 when the JD signals it sponsors visas — directly
 * relevant given the H-1B requirement).
 */
function scoreCareer(
  job: JobRow,
  profile: Profile,
  seniorityMatch: boolean,
  sponsorshipSignal: ScoreResult["prefilter"]["sponsorshipSignal"],
): DimResult {
  const titleLower = job.title.toLowerCase();

  // How well does the posting title fit a target title? Full phrase match is best; failing
  // that, count overlapping title tokens (e.g. "machine learning engineer" vs target list).
  const targetTitles = profile.preferences.titles;
  const fullTitleMatch = targetTitles.some((t) => titleLower.includes(t.toLowerCase()));

  const targetTokens = tokensOf(targetTitles);
  const titleTokens = tokenize(job.title);
  const tokenOverlap = [...titleTokens].filter((t) => targetTokens.has(t)).length;

  let base: number;
  if (fullTitleMatch) base = 80;
  else if (tokenOverlap >= 2) base = 65;
  else if (tokenOverlap === 1) base = 50;
  else base = 35;

  if (seniorityMatch) base += 8; // title carries a senior/staff/lead/principal token
  if (sponsorshipSignal === "sponsors") base += 10; // explicit visa sponsorship — material here

  const score = clamp(base);

  if (fullTitleMatch) {
    return { score, strength: `Title aligns with a target role ("${job.title}").` };
  }
  if (tokenOverlap === 0) {
    return { score, gap: `Title "${job.title}" does not clearly match the candidate's target titles.` };
  }
  return { score };
}

// ─────────────────────────────────────────────────────────────────────────────
// Location (pass/fail, not weighted — 04-job-evaluation.md §4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * locationPass: if the candidate will relocate anywhere → always PASS. Otherwise PASS when
 * the job is remote, or its location/JD mentions a preferred location. With no preferred
 * locations configured we default to PASS for remote jobs and FAIL for onsite-unknown.
 */
function computeLocationPass(job: JobRow, profile: Profile): { pass: boolean; note?: string } {
  if (profile.preferences.relocateAnywhere) {
    return { pass: true, note: "Open to relocation anywhere." };
  }
  if (job.remote === true) return { pass: true, note: "Remote role." };

  // Past this point job.remote is `false | null` (not remote, or unknown).
  // remote-only preference + a non-remote job → fail.
  if (profile.preferences.remotePreference === "remote-only") {
    return { pass: false, note: "Role is not remote but candidate prefers remote-only." };
  }

  // No structured preferred-location list exists on the profile; treat unknown-remote as a
  // soft pass (we don't over-filter on location), onsite as a flag-but-pass for hybrid/open.
  if (job.remote === null) return { pass: true, note: "Remote status unknown — location not blocking." };
  return { pass: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score one job against the profile.
 *
 * Flow:
 *   1. Run the hard pre-filter. If it fails, short-circuit to overall:0 / verdict:'poor'
 *      and surface the prefilter reasons as gaps (the job is disqualified, not merely weak).
 *   2. Otherwise compute the four weighted dimensions and the pass/fail location check.
 *
 * The returned `ScoreResult` is the heuristic BASELINE; an LLM may later overwrite
 * `dimensions`/`overall`/`verdict`/`strengths`/`gaps` in the MCP `score_fit` tool.
 */
export function scoreJob(job: JobRow, profile: Profile): ScoreResult {
  const pf = prefilter(job, profile);

  if (!pf.pass) {
    // Disqualified: do not waste effort scoring dimensions. Report why.
    return {
      jobId: job.id,
      overall: 0,
      dimensions: { technical: 0, experience: 0, behavioral: 0, career: 0 },
      locationPass: false,
      verdict: "poor",
      strengths: [],
      gaps: pf.reasons.length ? [...pf.reasons] : ["Disqualified by hard pre-filter."],
      recommendation: "Skip — disqualified by a hard pre-filter (see gaps).",
      prefilter: pf,
    };
  }

  const technical = scoreTechnical(job, profile);
  const experience = scoreExperience(job, profile);
  const behavioral = scoreBehavioral();
  const career = scoreCareer(job, profile, pf.seniorityMatch, pf.sponsorshipSignal);

  const dimensions: ScoreDimensions = {
    technical: technical.score,
    experience: experience.score,
    behavioral: behavioral.score,
    career: career.score,
  };

  const overall = clamp(
    dimensions.technical * WEIGHTS.technical +
      dimensions.experience * WEIGHTS.experience +
      dimensions.behavioral * WEIGHTS.behavioral +
      dimensions.career * WEIGHTS.career,
  );

  const loc = computeLocationPass(job, profile);
  const verdict = toVerdict(overall);

  // Collect dimension strengths/gaps (drop undefined entries).
  const strengths = [technical, experience, behavioral, career]
    .map((d) => d.strength)
    .filter((s): s is string => typeof s === "string");
  const gaps = [technical, experience, behavioral, career]
    .map((d) => d.gap)
    .filter((g): g is string => typeof g === "string");

  // Sponsorship is the candidate's binding constraint — surface it both ways.
  if (pf.sponsorshipSignal === "sponsors") {
    strengths.push("Posting signals visa sponsorship is available.");
  } else if (pf.sponsorshipSignal === "unknown") {
    gaps.push("Visa sponsorship not mentioned — confirm before applying (candidate needs sponsorship).");
  }
  if (loc.note && !loc.pass) gaps.push(loc.note);

  const recommendation = buildRecommendation(verdict, loc.pass);

  return {
    jobId: job.id,
    overall,
    dimensions,
    locationPass: loc.pass,
    verdict,
    strengths,
    gaps,
    recommendation,
    prefilter: pf,
  };
}

/** One-line apply/skip recommendation derived from verdict + location (mirrors the skill doc). */
function buildRecommendation(verdict: Verdict, locationPass: boolean): string {
  if (!locationPass) return "Skip — location/remote requirements are not met.";
  switch (verdict) {
    case "strong":
      return "Apply — strong fit; tailor CV and cover letter fully.";
    case "good":
      return "Apply — good fit; address the noted gaps in the cover letter.";
    case "moderate":
      return "Consider — moderate fit; review carefully before applying.";
    case "weak":
      return "Probably skip — weak fit unless there is a strategic reason.";
    case "poor":
    default:
      return "Skip — poor fit.";
  }
}

/**
 * Gate used by the apply pipeline: a job is allowed through only when its weighted overall
 * clears the configured fit threshold AND it survived the hard pre-filter AND location
 * passes. (Threshold default is guardrails.fitThreshold, typically 70.)
 */
export function passesThreshold(score: ScoreResult, threshold: number): boolean {
  return score.overall >= threshold && score.prefilter.pass && score.locationPass;
}
