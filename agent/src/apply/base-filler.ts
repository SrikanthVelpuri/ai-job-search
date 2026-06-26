/**
 * base-filler.ts — shared Playwright helpers for the per-ATS apply fillers (design §2.5).
 *
 * Every concrete filler (greenhouse/lever/ashby) navigates ctx.job.url, then leans on these
 * helpers to detect bot walls, fill labelled inputs, attach a resume, and screenshot. The
 * helpers are deliberately *defensive*: ATS markup drifts, so each one tries several selector
 * strategies and quietly reports failure (returning false / null) rather than throwing — a
 * filler that throws would abort the whole run, but a filler that returns "couldn't fill this"
 * lets the engine flag the field and move on (guardrails.md §2 no-fabrication / skip+flag).
 *
 * Playwright is an OPTIONAL dependency (package.json optionalDependencies). We therefore import
 * it lazily via dynamic import inside launchBrowser, so this module can be imported (and
 * typechecked) on a box with no chromium binary. The `Page`/`Locator`/`Browser` *types* come
 * from the type-only import, which is erased at compile time and needs no runtime install.
 */

import type { Browser, Locator, Page } from "playwright";
import type { AtsKind, FillContext, FillResult } from "../types.js";
import {
  validateResumeFile,
  verifyResumeAttached,
  selectComboboxByLabel,
  checkRequiredConsentBoxes,
  findUnfilledRequiredFields,
  verifySubmissionConfirmed,
} from "./form-verify.js";

/** Per-action timeout for individual fills/clicks. Kept short so a missing field fails fast. */
export const ACTION_TIMEOUT_MS = 5_000;

/** How long to wait for the apply page to settle after navigation. */
export const NAV_TIMEOUT_MS = 20_000;

/**
 * Launch a headless Chromium browser.
 *
 * Lazy dynamic import keeps `playwright` off the module-load critical path: if the package or
 * its browser binary is absent the failure surfaces here (when an apply actually runs), not at
 * import time. Defaults to headless — unattended runs must never pop a visible window.
 */
export async function launchBrowser(opts: { headless?: boolean } = {}): Promise<Browser> {
  // Dynamic import so a missing optional dependency does not break module load / typecheck.
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: opts.headless ?? true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Bot-wall detection (guardrails.md §6 — detect → skip + flag, never force)
// ─────────────────────────────────────────────────────────────────────────────

/** Selectors / iframe sources that betray a captcha challenge on the page. */
const CAPTCHA_SELECTORS: string[] = [
  'iframe[src*="recaptcha"]',
  'iframe[title*="recaptcha" i]',
  'iframe[src*="hcaptcha"]',
  'iframe[title*="hcaptcha" i]',
  'iframe[src*="challenges.cloudflare.com"]', // Cloudflare Turnstile
  ".g-recaptcha",
  ".h-captcha",
  ".cf-turnstile",
  "#cf-challenge-running",
];

/**
 * True if the page shows a captcha / bot-challenge widget. We only check for *presence* of the
 * widget in the DOM (visible or not) — any of these means we must not proceed unattended.
 */
export async function detectCaptcha(page: Page): Promise<boolean> {
  for (const sel of CAPTCHA_SELECTORS) {
    // .count() never throws on a missing selector; >0 means at least one match exists.
    const n = await page.locator(sel).count().catch(() => 0);
    if (n > 0) return true;
  }
  return false;
}

/** Visible-text phrases that indicate a login/auth wall standing between us and the form. */
const LOGIN_TEXT_PATTERNS: RegExp[] = [
  /please log in/i,
  /please sign in/i,
  /log in to (continue|apply)/i,
  /sign in to (continue|apply)/i,
  /you must be logged in/i,
];

/** Selectors for the password field / auth buttons that mark a sign-in form. */
const LOGIN_SELECTORS: string[] = [
  'input[type="password"]',
  'button[type="submit"][name*="login" i]',
  'a[href*="login" i][class*="button" i]',
];

/**
 * True if the page is gated behind a login / sign-in wall. Clean-ATS apply pages (the v1 target)
 * are public and have NO password field, so a password input is a strong positive signal; we also
 * scan the visible body text for the usual "please log in" phrasing.
 */
export async function detectLoginWall(page: Page): Promise<boolean> {
  for (const sel of LOGIN_SELECTORS) {
    const n = await page.locator(sel).count().catch(() => 0);
    if (n > 0) return true;
  }
  // Body text scan — cheap and resilient to markup differences across ATS vendors.
  const body = await page.locator("body").innerText().catch(() => "");
  return LOGIN_TEXT_PATTERNS.some((re) => re.test(body));
}

// ─────────────────────────────────────────────────────────────────────────────
// Field filling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generic English/question stopwords that must NOT drive attribute-substring field matching — they
 * appear in too many unrelated field names and cause cross-field leakage (e.g. "you" → "How did you
 * hear about this job?"). Keep this to filler words only; never add domain keywords like "name".
 */
const ATTR_MATCH_STOPWORDS = new Set([
  "you", "your", "are", "the", "for", "and", "with", "this", "that", "have", "has", "will", "now",
  "any", "did", "how", "what", "when", "where", "which", "who", "why", "our", "their", "about",
  "would", "could", "should", "into", "from", "been", "were", "was", "please", "select", "currently",
]);

/**
 * Build a single Locator that targets a text/textarea control whose label, placeholder, name,
 * id, or aria-label matches any of the given patterns. Strategies, in order of reliability:
 *   1. getByLabel  — proper <label for=…> association (most reliable, accessibility-first).
 *   2. placeholder — getByPlaceholder for inputs without a wired label.
 *   3. attribute   — name / id / aria-label substring contains a stripped keyword from pattern.
 *
 * Returns the first locator that resolves to ≥1 element, or null if nothing matched. We never
 * guess blindly: callers treat a null result as "field not found → flag it".
 */
async function locateLabelledInput(
  page: Page,
  labelPatterns: RegExp[],
  allowAttrFallback = true,
): Promise<Locator | null> {
  // Strategy 1 + 2: label / placeholder association via Playwright's accessibility-aware getters.
  for (const re of labelPatterns) {
    const byLabel = page.getByLabel(re).first();
    if ((await byLabel.count().catch(() => 0)) > 0) return byLabel;

    const byPlaceholder = page.getByPlaceholder(re).first();
    if ((await byPlaceholder.count().catch(() => 0)) > 0) return byPlaceholder;
  }

  // Strategy 3 is loose (keyword-in-attribute) and can grab an unrelated field when the label text
  // doesn't match the form's wording — fine for distinctive contact fields, DANGEROUS for screening
  // answers (a wrong answer in the wrong field). Callers that map answers pass allowAttrFallback=false.
  if (!allowAttrFallback) return null;

  // Strategy 3: attribute-substring match. Derive plain keywords from the regex source so e.g.
  // /first\s*name/i contributes "first" and "name", then probe name/id/aria-label attributes.
  // Common stopwords are dropped: a token like "you" would otherwise match "How did you hear…" and
  // leak an unrelated answer into the wrong field (the 2026-06-25 "Yes"-in-how-did-you-hear bug).
  for (const re of labelPatterns) {
    const keywords = re.source
      .toLowerCase()
      .replace(/[\\^$.*+?()[\]{}|]/g, " ") // strip regex metacharacters
      .replace(/\bs\b/g, " ") // drop leftover \s tokens
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !ATTR_MATCH_STOPWORDS.has(w));
    for (const kw of keywords) {
      const sel =
        `input[name*="${kw}" i], input[id*="${kw}" i], input[aria-label*="${kw}" i], ` +
        `textarea[name*="${kw}" i], textarea[id*="${kw}" i], textarea[aria-label*="${kw}" i]`;
      const loc = page.locator(sel).first();
      if ((await loc.count().catch(() => 0)) > 0) return loc;
    }
  }
  return null;
}

/**
 * Fill the first text/textarea control matching any label pattern with `value`.
 * Returns true if a control was found AND the fill succeeded, false otherwise. A skipped
 * empty value (null/"") is treated as "nothing to do" and returns false without touching the DOM.
 */
export async function fillTextByLabel(
  page: Page,
  labelPatterns: RegExp[],
  value: string | null | undefined,
  allowAttrFallback = true,
): Promise<boolean> {
  if (value === null || value === undefined || value === "") return false;
  const loc = await locateLabelledInput(page, labelPatterns, allowAttrFallback);
  if (!loc) return false;
  try {
    await loc.fill(value, { timeout: ACTION_TIMEOUT_MS });
    return true;
  } catch {
    // Field present but not fillable (disabled, detached, overlaid) → report as not filled.
    return false;
  }
}

/**
 * Select an option in a native <select> (or ARIA combobox rendered as a select) matched by label.
 * Tries selectOption by label first (visible text), then by value. Returns whether it succeeded.
 * Note: JS-app comboboxes (Ashby/React-Select) are NOT native <select>; those are handled in the
 * concrete fillers via click+option, since they vary per vendor.
 */
export async function selectOptionByLabel(
  page: Page,
  labelPatterns: RegExp[],
  value: string,
): Promise<boolean> {
  for (const re of labelPatterns) {
    const byLabel = page.getByLabel(re).first();
    if ((await byLabel.count().catch(() => 0)) === 0) continue;
    try {
      await byLabel.selectOption({ label: value }, { timeout: ACTION_TIMEOUT_MS });
      return true;
    } catch {
      try {
        await byLabel.selectOption(value, { timeout: ACTION_TIMEOUT_MS });
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resume upload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attach the resume file to the first file input on the page. Prefers a resume-specific input
 * (id/name contains "resume"/"cv"/"file"), then falls back to any input[type=file]. Returns
 * whether a file input was found and the file was set. Never throws on a missing input.
 */
export async function uploadResume(page: Page, resumePath: string | null | undefined): Promise<boolean> {
  if (!resumePath) return false;
  const candidates = [
    'input[type="file"][id*="resume" i]',
    'input[type="file"][name*="resume" i]',
    'input[type="file"][id*="cv" i]',
    'input[type="file"][name*="cv" i]',
    'input[type="file"]',
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) === 0) continue;
    try {
      // setInputFiles works even when the input is visually hidden behind a styled button,
      // which is the norm on modern ATS upload widgets. force not needed — it targets the input.
      await loc.setInputFiles(resumePath, { timeout: ACTION_TIMEOUT_MS });
      return true;
    } catch {
      // Try the next candidate selector.
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Screenshot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capture a full-page screenshot to `path` (the engine pre-creates the directory). Returns the
 * path on success. On failure returns null — a missing screenshot must not abort an otherwise
 * good fill, but the engine should note the audit gap.
 */
export async function screenshot(page: Page, path: string): Promise<string | null> {
  try {
    await page.screenshot({ path, fullPage: true });
    return path;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared name splitting (contact.name is a single string in the profile)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split a full name into { first, last }. Everything before the last whitespace token is the
 * first/given name(s); the final token is the surname. Single-token names put the whole string
 * in `first` and leave `last` empty.
 */
export function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0] ?? "", last: "" };
  const last = parts[parts.length - 1] ?? "";
  const first = parts.slice(0, -1).join(" ");
  return { first, last };
}

/**
 * Normalize an AnsweredQuestion's answer value to a single string usable in a text input.
 * Booleans become "Yes"/"No"; string[] is joined with ", "; null becomes "". This is a
 * convenience the concrete fillers share for free-text + simple boolean fields.
 */
export function answerToText(answer: string | string[] | boolean | null): string {
  if (answer === null) return "";
  if (typeof answer === "boolean") return answer ? "Yes" : "No";
  if (Array.isArray(answer)) return answer.join(", ");
  return answer;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared fill orchestration
// ─────────────────────────────────────────────────────────────────────────────
//
// All three ATS fillers share the SAME control flow: navigate → detect walls → fill contact →
// map screening answers → upload resume → screenshot → (and ONLY in live mode, after the safety
// gate) submit. The only per-ATS variation is the selector vocabulary and the submit-button
// locator, which each filler injects via FillerSpec. Centralizing the flow here guarantees the
// CRITICAL SAFETY INVARIANT below is identical and unmissable across every ATS.

/** Per-ATS configuration injected by the concrete fillers into the shared flow. */
export interface FillerSpec {
  ats: AtsKind;
  /** Label/attribute patterns for the standard contact fields on this ATS. */
  firstNamePatterns: RegExp[];
  lastNamePatterns: RegExp[];
  /** Some ATSes use a single "Full name" field instead of first/last. */
  fullNamePatterns: RegExp[];
  emailPatterns: RegExp[];
  phonePatterns: RegExp[];
  /**
   * Locate the final submit/apply button for this ATS, or null if not found. Called ONLY in live
   * mode after the safety gate has already cleared — concrete fillers must not click inside it.
   */
  findSubmitButton(page: Page): Promise<Locator | null>;
}

/**
 * Run the standard fill flow for a clean-ATS application form.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *  CRITICAL SAFETY INVARIANT — READ BEFORE EDITING
 *  We NEVER click submit unless ALL of the following hold:
 *    1. ctx.mode === "live"                    (dryrun is the default and MUST stop before submit)
 *    2. ctx.answers.hasUnanswerable === false  (no fabricated/blank required screening answers)
 *    3. flaggedFields.length === 0             (every field WE tried and couldn't fill blocks submit)
 *    4. the resume artifact validates AND is actually attached to the form
 *    5. ctx.atsScore >= atsMinScore            (don't submit a poorly-matched resume)
 *    6. findUnfilledRequiredFields(page) === [] (the LIVE form has NO empty required field — this is
 *                                               what stops partial/rejected submits)
 *  And even after clicking submit we only record outcome:"submitted" when
 *  verifySubmissionConfirmed() sees a real confirmation; otherwise outcome:"rejected" (needs human).
 *  In dryrun we fill + screenshot then RETURN outcome:"filled", submitted:false — no click, ever.
 *  If you add an early submit path, you are introducing a guardrail violation. Do not.
 * ════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function runStandardFill(
  page: Page,
  ctx: FillContext,
  spec: FillerSpec,
): Promise<FillResult> {
  const flaggedFields: string[] = [];
  const notes: string[] = [];

  // 1) Navigate to the canonical apply URL (page is created by the engine, not us).
  try {
    await page.goto(ctx.job.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  } catch {
    return {
      outcome: "failed",
      screenshotPath: null,
      submitted: false,
      flaggedFields: [],
      notes: `navigation to ${ctx.job.url} failed`,
    };
  }

  // 2) Bot-wall gates — detect → skip + flag, never force (guardrails.md §6). These return
  //    *before* we touch any field, so we never partially fill a form behind a wall.
  if (await detectCaptcha(page)) {
    return {
      outcome: "captcha",
      screenshotPath: null,
      submitted: false,
      flaggedFields: [],
      notes: "captcha/bot-challenge detected; skipped per CAPTCHA_POLICY",
    };
  }
  if (await detectLoginWall(page)) {
    return {
      outcome: "login_required",
      screenshotPath: null,
      submitted: false,
      flaggedFields: [],
      notes: "login/sign-in wall detected; clean-ATS apply pages should be public",
    };
  }

  // 3) Contact fields. contact.name is one string → split into first/last; also try a single
  //    full-name field as a fallback for ATSes that use one combined input.
  const { first, last } = splitName(ctx.profile.identity.name);
  if (first) {
    const filledFirst = await fillTextByLabel(page, spec.firstNamePatterns, first);
    const filledLast = last ? await fillTextByLabel(page, spec.lastNamePatterns, last) : true;
    if (!filledFirst || !filledLast) {
      // Fall back to a single combined "full name" field.
      const full = [first, last].filter(Boolean).join(" ");
      if (await fillTextByLabel(page, spec.fullNamePatterns, full)) {
        notes.push("used combined full-name field");
      } else {
        if (!filledFirst) flaggedFields.push("first name");
        if (!filledLast) flaggedFields.push("last name");
      }
    }
  }
  if (!(await fillTextByLabel(page, spec.emailPatterns, ctx.profile.contact.email))) {
    flaggedFields.push("email");
  }
  if (ctx.profile.contact.phone) {
    if (!(await fillTextByLabel(page, spec.phonePatterns, ctx.profile.contact.phone))) {
      flaggedFields.push("phone");
    }
  }

  // 3b) Derived profile fields ATS forms commonly mark required. Best-effort + honest (real profile
  //     data only): if any of these is required and we miss it, findUnfilledRequiredFields catches it
  //     and blocks submit — so we never fabricate, we just fill what we truthfully can.
  if (ctx.profile.contact.linkedin) await fillTextByLabel(page, [/linkedin/i, /linked\s*in/i], ctx.profile.contact.linkedin);
  const currentJob = ctx.profile.experience.find((e) => e.end === null) ?? ctx.profile.experience[0];
  if (currentJob?.company) {
    await fillTextByLabel(
      page,
      [/current\s*(employer|company)/i, /present\s*(employer|company)/i, /company\s*name/i, /current\s*company/i],
      currentJob.company,
    );
  }
  // "How did you hear about this job?" — we sourced this from the company's own careers/ATS board,
  // so "Company Website" is the truthful answer. Try a text field, then a combobox.
  const heardPatterns = [/how did you hear/i, /how.*hear about/i, /referral source/i, /source/i];
  if (!(await fillTextByLabel(page, heardPatterns, "Company Website"))) {
    await selectComboboxByLabel(page, heardPatterns, "Company Website");
  }

  // 4) Resume upload + verify it actually attached (catches the "Resume/CV is required" rejection).
  const resumeUploaded = await uploadResume(page, ctx.artifacts.resumePath);
  const resumeAttached = resumeUploaded && (await verifyResumeAttached(page, ctx.artifacts.resumePath));
  if (!resumeAttached) flaggedFields.push("resume upload");

  // 5) Screening answers → map each to a field by its question label. Unanswerable / needs-human
  //    answers are never typed: we flag them so the safety gate can block submit. For choice-type
  //    questions (select/multiselect/boolean) we try a native <select>, then a JS combobox, then
  //    plain text; only if all fail do we flag.
  for (const aq of ctx.answers.answers) {
    const label = aq.question.label;
    const patterns = [labelToPattern(label)];

    if (aq.source === "unanswerable" || aq.needsHuman || aq.answer === null) {
      flaggedFields.push(label);
      continue;
    }

    const optionText = answerToText(aq.answer);
    if (!optionText) {
      flaggedFields.push(label);
      continue;
    }

    // Screening answers map by PRECISE label only (allowAttrFallback=false) so a canned answer can
    // never leak into an unrelated field whose attributes happen to share a keyword.
    const isChoice =
      aq.question.type === "select" || aq.question.type === "multiselect" || aq.question.type === "boolean";
    if (isChoice) {
      if (await selectOptionByLabel(page, patterns, optionText)) continue;
      if (await selectComboboxByLabel(page, patterns, optionText)) continue;
      if (await fillTextByLabel(page, patterns, optionText, false)) continue;
      flaggedFields.push(label);
      continue;
    }

    if (await fillTextByLabel(page, patterns, optionText, false)) continue;
    if (await selectComboboxByLabel(page, patterns, optionText)) continue;
    flaggedFields.push(label);
  }

  // 5b) Tick required consent / terms / privacy checkboxes (ATS forms gate submit on these).
  const consentChecked = await checkRequiredConsentBoxes(page);
  if (consentChecked > 0) notes.push(`checked ${consentChecked} required consent box(es)`);

  // 6) Screenshot the filled form (audit record, guardrails.md §5) regardless of mode.
  const shotPath = await screenshot(page, ctx.screenshotPath);

  // Read the LIVE form for any required field still empty — independent of our question list.
  const missingRequired = await findUnfilledRequiredFields(page);

  // 7) ── THE SAFETY GATE ──────────────────────────────────────────────────────────────────────
  // Dryrun (default): stop here, but REPORT whether the form would be submittable so the operator
  // can see real readiness without anything being sent.
  if (ctx.mode !== "live") {
    const readiness =
      missingRequired.length || flaggedFields.length
        ? `WOULD NOT submit live — ${missingRequired.length} required field(s) empty${
            missingRequired.length ? ` [${missingRequired.join("; ")}]` : ""
          }${flaggedFields.length ? `; flagged: ${flaggedFields.join("; ")}` : ""}`
        : "all required fields satisfied — WOULD be submittable live";
    return {
      outcome: "filled",
      screenshotPath: shotPath,
      submitted: false,
      flaggedFields,
      notes: joinNotes(notes, `dryrun: filled + screenshotted; ${readiness}`),
    };
  }

  // ── LIVE gate — each check below must pass or we skip+flag (never a partial/forced submit). ──

  // (a) No-fabrication: any unanswerable screening question blocks.
  if (ctx.answers.hasUnanswerable) {
    return skip(shotPath, flaggedFields, notes, "unanswerable screening questions");
  }
  // (b) Resume artifact must be a real, non-empty, correctly-framed file (verify the docx).
  const resumeVal = validateResumeFile(ctx.artifacts.resumePath);
  if (!resumeVal.ok) {
    return skip(shotPath, flaggedFields, notes, `resume artifact invalid: ${resumeVal.reason}`);
  }
  // (c) ATS keyword score must clear the floor (don't submit a poorly-matched resume).
  const atsMin = ctx.atsMinScore ?? 0;
  if (typeof ctx.atsScore === "number" && ctx.atsScore < atsMin) {
    return skip(shotPath, flaggedFields, notes, `ATS score ${ctx.atsScore} < min ${atsMin}`);
  }
  // (d) Any field WE tried and couldn't fill (includes resume-not-attached) blocks.
  if (flaggedFields.length > 0) {
    return skip(shotPath, flaggedFields, notes, `unfilled fields: ${flaggedFields.join("; ")}`);
  }
  // (e) Any REQUIRED field on the live form still empty blocks — the core anti-false-submit check.
  if (missingRequired.length > 0) {
    return skip(shotPath, [...flaggedFields, ...missingRequired], notes, `required form fields empty: ${missingRequired.join("; ")}`);
  }

  // All gates passed: this is the ONLY place a submit click is allowed in the entire apply cluster.
  const submitBtn = await spec.findSubmitButton(page);
  if (!submitBtn) {
    return skip(shotPath, ["submit button"], notes, "submit button not found");
  }
  const beforeUrl = page.url();
  try {
    await submitBtn.click({ timeout: ACTION_TIMEOUT_MS });
  } catch {
    return {
      outcome: "failed",
      screenshotPath: shotPath,
      submitted: false,
      flaggedFields,
      notes: joinNotes(notes, "submit click failed"),
    };
  }

  // POST-SUBMIT VERIFICATION — only "submitted" when a real confirmation is observed; otherwise the
  // form rejected the click (e.g. a required field we couldn't see) → "rejected" for human follow-up.
  const confirm = await verifySubmissionConfirmed(page, beforeUrl);
  const confirmShot = (await screenshot(page, ctx.screenshotPath)) ?? shotPath;
  if (confirm.confirmed) {
    return {
      outcome: "submitted",
      screenshotPath: confirmShot,
      submitted: true,
      flaggedFields,
      notes: joinNotes(notes, `live: submitted (confirmed: ${confirm.signal})`),
    };
  }
  return {
    outcome: "rejected",
    screenshotPath: confirmShot,
    submitted: false,
    flaggedFields,
    notes: joinNotes(notes, `live: submit clicked but NOT confirmed (${confirm.signal}) — needs human`),
  };
}

/** Build a skip FillResult (filled but not submitted) with a reason. */
function skip(shotPath: string | null, flaggedFields: string[], notes: string[], reason: string): FillResult {
  return {
    outcome: "skipped",
    screenshotPath: shotPath,
    submitted: false,
    flaggedFields,
    notes: joinNotes(notes, `not submitting: ${reason}`),
  };
}

/** Build a forgiving, anchored-substring case-insensitive regex from a question label. */
function labelToPattern(label: string): RegExp {
  // Escape regex metacharacters, collapse whitespace runs into \s+ so minor spacing differs OK.
  const escaped = label
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(escaped, "i");
}

/** Join the running note fragments with a trailing summary into one string. */
function joinNotes(fragments: string[], summary: string): string {
  return [...fragments, summary].filter(Boolean).join("; ");
}
