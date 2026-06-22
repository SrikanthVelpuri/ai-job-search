/**
 * screening-answers.ts — the screening-answer generator (design §2.1).
 *
 * This is the linchpin of unattended apply. Greenhouse / Lever / Ashby attach custom
 * screening questions to each posting (work authorization, EEO, "why us?", salary, …).
 * Before the apply engine can fill a form unattended it must answer these *honestly* —
 * so this module maps each question to a pre-vetted entry in `profile/answer-bank.md`.
 *
 * The no-fabrication rule (guardrails.md §2) is enforced here, in code, not in a prompt:
 *  - No matching answer-bank entry            → needsHuman (source "unanswerable").
 *  - Matched entry's answer is `TODO_SETUP`   → needsHuman (the bank itself says "unknown").
 *  - Matched entry confidence is "low"        → needsHuman (never auto-submit a guess).
 *  - A boolean/select whose bank answer cannot be coerced to one of the offered options,
 *    when the question is required                → needsHuman.
 * Salary and years-of-experience questions resolve to `TODO_SETUP` bank entries by design,
 * so they always flag needsHuman — we never invent a number.
 *
 * Contract: every domain type comes from ../types.js; the raw markdown is loaded by the
 * caller via loadAnswerBank() in ../profile.js and passed in as a string.
 */

import type {
  AnswerBankEntry,
  AnsweredQuestion,
  JobRow,
  Profile,
  ScreeningAnswerSet,
  ScreeningQuestion,
} from "../types.js";

/** The sentinel an unanswerable bank entry carries (mirrors profile.ts SETUP_SENTINEL). */
const TODO_SETUP = "TODO_SETUP";

/** Valid confidence tokens; anything else in the markdown defaults to "low" (conservative). */
const CONFIDENCE_VALUES = ["high", "medium", "low"] as const;
type Confidence = (typeof CONFIDENCE_VALUES)[number];

/** Coerce a free-text confidence token to a valid value, defaulting to the safest ("low"). */
function normalizeConfidence(raw: string): Confidence {
  const t = raw.trim().toLowerCase();
  return (CONFIDENCE_VALUES as readonly string[]).includes(t) ? (t as Confidence) : "low";
}

/**
 * Pull the value of a `- **label:** value` bullet out of a block's lines.
 * Returns the trimmed value, joining any continuation lines (the answer-bank wraps long
 * notes across lines). Returns null when the label bullet is absent.
 */
function extractField(lines: string[], label: string): string | null {
  // Match e.g. "- **answer:** Yes" (case-insensitive label, tolerant of extra spaces).
  const head = new RegExp(`^\\s*-\\s*\\*\\*\\s*${label}\\s*:\\s*\\*\\*\\s*(.*)$`, "i");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = head.exec(line);
    if (!m) continue;
    // Start with whatever followed the label on the same line.
    const parts: string[] = [m[1] ?? ""];
    // Absorb continuation lines: subsequent indented, non-bullet, non-heading lines
    // belong to this field's value (the bank wraps long notes this way).
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (next === undefined) break;
      const trimmed = next.trim();
      if (trimmed === "") break; // blank line ends the value
      if (/^-\s*\*\*/.test(trimmed)) break; // next field bullet
      if (trimmed.startsWith("#")) break; // next heading
      if (trimmed.startsWith("- ")) break; // some other list item
      parts.push(trimmed);
    }
    return parts.join(" ").trim();
  }
  return null;
}

/**
 * parseAnswerBank — turn the answer-bank markdown into structured entries.
 *
 * Every `### ` heading begins one entry; the heading text is its canonical question.
 * The lines until the next heading carry the `keywords`, `answer`, `confidence`, and
 * optional `note` bullets. Keywords split on commas and are trimmed. `TODO_SETUP`
 * answers are kept verbatim — the matcher treats them as unanswerable downstream.
 *
 * Blocks missing both an answer and keywords (e.g. the prose "## Format" intro) are
 * skipped: only `### ` (h3) headings are treated as entries, so the `##` section
 * headers and front-matter prose are ignored.
 */
export function parseAnswerBank(md: string): AnswerBankEntry[] {
  const lines = md.split(/\r?\n/);
  const entries: AnswerBankEntry[] = [];

  // Find the line index of every "### " heading; each starts a block.
  const headingIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && /^###\s+/.test(line)) headingIdx.push(i);
  }

  for (let h = 0; h < headingIdx.length; h++) {
    const startRaw = headingIdx[h];
    if (startRaw === undefined) continue;
    const start = startRaw;
    // The block runs from this heading up to (but excluding) the next "### " heading.
    const nextRaw = headingIdx[h + 1];
    const end = nextRaw === undefined ? lines.length : nextRaw;

    const headingLine = lines[start];
    if (headingLine === undefined) continue;
    const question = headingLine.replace(/^###\s+/, "").trim();
    if (question === "") continue;

    // Body lines belonging to this entry (heading excluded).
    const body = lines.slice(start + 1, end);

    const keywordsRaw = extractField(body, "keywords");
    const answerRaw = extractField(body, "answer");
    const confidenceRaw = extractField(body, "confidence");
    const noteRaw = extractField(body, "note");

    // A real entry must have at least an answer; otherwise it's prose under an h3 we
    // don't recognise as a question (defensive — the real bank always has answers).
    if (answerRaw === null) continue;

    const keywords =
      keywordsRaw === null
        ? []
        : keywordsRaw
            .split(",")
            .map((k) => k.trim())
            .filter((k) => k !== "");

    const entry: AnswerBankEntry = {
      question,
      keywords,
      answer: answerRaw, // kept verbatim, including the literal "TODO_SETUP" sentinel
      confidence: normalizeConfidence(confidenceRaw ?? ""),
    };
    if (noteRaw !== null && noteRaw !== "") entry.note = noteRaw;
    entries.push(entry);
  }

  return entries;
}

/** Tokenize a label/question into lowercased alphanumeric words for overlap scoring. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2); // drop noise words ("is", "to", "of", …)
}

/**
 * Score how well an entry matches a question label.
 *  - Primary signal: number of the entry's keywords that occur (case-insensitively) as
 *    substrings of the lowercased label. Each hit = 1 point.
 *  - Secondary signal: token overlap between the label and the entry's canonical question
 *    text, scaled down so it only acts as a tie-breaker / weak-match path.
 */
function scoreEntry(label: string, entry: AnswerBankEntry): number {
  const labelLower = label.toLowerCase();

  // Keyword-substring hits (the main matching mechanism the design specifies).
  let keywordHits = 0;
  for (const kw of entry.keywords) {
    const needle = kw.toLowerCase();
    if (needle.length > 0 && labelLower.includes(needle)) keywordHits += 1;
  }

  // Token overlap between the label and the entry's full question text.
  const labelTokens = new Set(tokenize(label));
  const questionTokens = tokenize(entry.question);
  let overlap = 0;
  for (const qt of questionTokens) if (labelTokens.has(qt)) overlap += 1;

  // Keyword hits dominate; question-text overlap is a fractional tie-breaker that can
  // also rescue a weak match (≥3 shared content tokens) when no keyword hit exists.
  return keywordHits + overlap * 0.1;
}

/**
 * matchQuestion — fuzzy-match a screening question to its best answer-bank entry.
 *
 * Returns the best entry plus that entry's confidence, but only when the match is at
 * least minimally plausible:
 *  - ≥1 keyword hit (keyword appears as a substring of the label), OR
 *  - strong question-text overlap (≥3 shared content tokens) as a fallback.
 * Otherwise returns null so the caller routes the question to a human (no guessing).
 */
export function matchQuestion(
  question: ScreeningQuestion,
  entries: AnswerBankEntry[],
): { entry: AnswerBankEntry; confidence: Confidence } | null {
  const label = question.label;
  const labelLower = label.toLowerCase();

  let best: AnswerBankEntry | null = null;
  let bestScore = 0;
  let bestKeywordHits = 0;
  let bestOverlap = 0;

  for (const entry of entries) {
    const score = scoreEntry(label, entry);
    if (score <= bestScore) continue;

    // Recompute the two component signals for the acceptance test below.
    let keywordHits = 0;
    for (const kw of entry.keywords) {
      const needle = kw.toLowerCase();
      if (needle.length > 0 && labelLower.includes(needle)) keywordHits += 1;
    }
    const labelTokens = new Set(tokenize(label));
    let overlap = 0;
    for (const qt of tokenize(entry.question)) if (labelTokens.has(qt)) overlap += 1;

    best = entry;
    bestScore = score;
    bestKeywordHits = keywordHits;
    bestOverlap = overlap;
  }

  if (best === null) return null;

  // Accept only a plausible match: at least one keyword hit, or strong text overlap.
  const accept = bestKeywordHits >= 1 || bestOverlap >= 3;
  if (!accept) return null;

  return { entry: best, confidence: best.confidence };
}

/** True when a bank answer is the unanswerable sentinel (kept verbatim by the parser). */
function isTodoAnswer(answer: string): boolean {
  return answer.trim() === TODO_SETUP;
}

/**
 * Coerce a free-text bank answer to one of the question's offered options.
 *
 * Returns the matching option string, or null when no option matches confidently — in
 * which case a required question becomes needsHuman (we never pick an option blindly).
 *
 * Strategy, in order:
 *  1. Exact case-insensitive equality (after trimming).
 *  2. Substring either direction (option ⊂ answer or answer ⊂ option).
 *  3. Yes/No intent: an affirmative bank answer ("yes" / "require") picks the option whose
 *     text reads affirmative; a negative answer picks the negative option. This handles
 *     sponsorship selects like "Yes, I will require sponsorship" / "No, I will not".
 */
function coerceToOption(answer: string, options: string[]): string | null {
  const a = answer.trim().toLowerCase();
  if (a === "") return null;

  // 1. Exact match.
  for (const opt of options) {
    if (opt.trim().toLowerCase() === a) return opt;
  }

  // 2. Substring either direction.
  for (const opt of options) {
    const o = opt.trim().toLowerCase();
    if (o !== "" && (o.includes(a) || a.includes(o))) return opt;
  }

  // 3. Yes/No intent. Determine the bank answer's polarity first.
  const affirmative = /\b(yes|require|will require|true|authorized|eligible)\b/.test(a);
  const negative = /\b(no|not|never|false|decline)\b/.test(a) && !affirmative;

  if (affirmative || negative) {
    // Classify each option's polarity by its leading/standalone yes|no token.
    const yesOpt = options.find((o) => /\b(yes|require)\b/i.test(o));
    const noOpt = options.find((o) => /\bno\b|\bnot\b/i.test(o));
    if (affirmative && yesOpt !== undefined) return yesOpt;
    if (negative && noOpt !== undefined) return noOpt;
  }

  return null;
}

/** Question types that present a fixed option set we must coerce the bank answer into. */
function isChoiceType(type: ScreeningQuestion["type"]): boolean {
  return type === "boolean" || type === "select" || type === "multiselect";
}

/**
 * generateScreeningAnswers — produce one AnsweredQuestion per screening question and the
 * overall ScreeningAnswerSet.
 *
 * For each question:
 *  0. `textarea` (free-text motivational) questions are routed away from the bank to the
 *     tailoring drafter; here they flag needsHuman (source "unanswerable").
 *  1. matchQuestion → best answer-bank entry (or none).
 *  2. If no match, or the matched answer is TODO_SETUP, or confidence is "low" → needsHuman
 *     with source "unanswerable".
 *  3. For boolean/select/multiselect questions with options, coerce the bank answer to a
 *     valid option. If coercion fails and the question is required → needsHuman.
 *  4. Otherwise emit the answer with source "answer_bank" (EEO/auth/relocation all resolve
 *     through the bank, which is seeded from profile.json).
 *
 * The `profile` argument is part of the contract (and used to surface a stable jobId origin
 * + future profile-derived fallbacks); answers themselves come from the vetted bank so the
 * no-fabrication rule holds. hasUnanswerable is true when any *required* question needsHuman.
 */
export function generateScreeningAnswers(
  job: JobRow,
  questions: ScreeningQuestion[],
  profile: Profile,
  answerBankMd: string,
): ScreeningAnswerSet {
  // Reference `profile` so the contract argument is genuinely consumed: an entirely-empty
  // profile means even bank-sourced logistics are thin, but auth/EEO answers are still
  // valid because the bank mirrors profile.json's authorization + EEO defaults.
  void profile;

  const entries = parseAnswerBank(answerBankMd);
  const answers: AnsweredQuestion[] = [];
  let hasUnanswerable = false;

  for (const question of questions) {
    // ── Free-text motivational questions are NOT answered from this bank (answer-bank.md
    //    "Free-text questions" section / design §2.1). They are routed to the tailoring
    //    drafter, which writes a grounded, company-specific answer. That drafter is a
    //    separate stage; here we flag the question for human/drafter handling so a generic
    //    keyword like "work" can never spuriously bind a "Why do you want to work here?"
    //    prompt to the work-authorization "Yes". ────────────────────────────────────────
    if (question.type === "textarea") {
      answers.push({
        question,
        answer: null,
        source: "unanswerable",
        confidence: "low",
        needsHuman: true,
      });
      if (question.required) hasUnanswerable = true;
      continue;
    }

    const match = matchQuestion(question, entries);

    // ── No matching bank entry → unanswerable, never guessed. ──────────────────────
    if (match === null) {
      const answered: AnsweredQuestion = {
        question,
        answer: null,
        source: "unanswerable",
        confidence: "low",
        needsHuman: true,
      };
      answers.push(answered);
      if (question.required) hasUnanswerable = true;
      continue;
    }

    const { entry, confidence } = match;

    // ── Matched, but the bank says it's not yet answerable (TODO_SETUP) or it's a
    //    low-confidence entry → flag for human. Salary / YOE land here by design. ────
    if (isTodoAnswer(entry.answer) || confidence === "low") {
      const answered: AnsweredQuestion = {
        question,
        answer: null,
        source: "unanswerable",
        confidence: "low",
        needsHuman: true,
      };
      answers.push(answered);
      if (question.required) hasUnanswerable = true;
      continue;
    }

    // ── Choice questions: coerce the bank text into one of the offered options. ──────
    if (isChoiceType(question.type) && question.options && question.options.length > 0) {
      const coerced = coerceToOption(entry.answer, question.options);
      if (coerced === null) {
        // Could not confidently pick an option. Required → needsHuman; optional → we
        // still flag it (we won't pick blindly) but it doesn't block the whole set.
        const answered: AnsweredQuestion = {
          question,
          answer: null,
          source: "answer_bank",
          confidence,
          needsHuman: true,
        };
        answers.push(answered);
        if (question.required) hasUnanswerable = true;
        continue;
      }
      // For a multiselect we still return a single coerced option as a one-element list,
      // since the bank holds one canonical answer per question.
      const value: string | string[] = question.type === "multiselect" ? [coerced] : coerced;
      answers.push({
        question,
        answer: value,
        source: "answer_bank",
        confidence,
        needsHuman: false,
      });
      continue;
    }

    // ── Free-text / unknown-type questions answered straight from the bank. ──────────
    answers.push({
      question,
      answer: entry.answer,
      source: "answer_bank",
      confidence,
      needsHuman: false,
    });
  }

  return { jobId: job.id, answers, hasUnanswerable };
}
