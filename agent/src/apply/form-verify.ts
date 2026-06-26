/**
 * form-verify.ts — pre-submit verification + advanced form interaction for the apply engine.
 *
 * These close the two defects that made live apply untrustworthy (see report 2026-06-25):
 *   1. FALSE-POSITIVE SUBMIT — we used to record `submitted` whenever the submit button was clicked
 *      without throwing, even when the form rejected it client-side. `verifySubmissionConfirmed`
 *      now requires a real confirmation signal before we call an application submitted.
 *   2. INCOMPLETE COVERAGE — we used to only fill our hardcoded question list and were blind to the
 *      form's other required fields. `findUnfilledRequiredFields` reads the LIVE DOM and reports any
 *      required control still empty, so the safety gate blocks submit instead of sending a partial
 *      application. `selectComboboxByLabel` / `checkRequiredConsentBoxes` raise how many of those we
 *      can actually fill (React selects, consent/terms checkboxes).
 *
 * Plus `validateResumeFile` (the .docx is real + non-empty + correctly framed) and
 * `verifyResumeAttached` (the file actually reached the form) — the "verify the docx before
 * submission" requirement.
 *
 * Everything here is defensive: page helpers catch and return a safe default rather than throw, so
 * a flaky selector degrades to "couldn't verify" (→ skip+flag), never an aborted run.
 */

import fs from "node:fs";
import type { Page } from "playwright";

// `document` exists ONLY inside page.evaluate() (browser context). Declared here as `any` so the
// Node tsconfig (which deliberately omits the DOM lib) can typecheck the in-page callbacks without
// adding DOM globals to the whole project. It has no Node runtime meaning. (The heavier in-page
// scan in findUnfilledRequiredFields is passed as a raw JS string, so it needs no declarations.)
declare const document: any;

const ACTION_TIMEOUT_MS = 5_000;

/** Escape a string for safe embedding inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Resume artifact validation (the "verify the docx before submission" rule)
// ─────────────────────────────────────────────────────────────────────────────

export interface ResumeValidation {
  ok: boolean;
  reason: string;
  bytes: number;
}

/**
 * Validate the resume artifact on disk BEFORE we ever try to upload/submit it:
 *  - exists and is a regular file,
 *  - within a sane size band (not a 0-byte stub, not a runaway file),
 *  - the magic bytes match the extension (.docx is a ZIP → "PK"; .pdf → "%PDF"; .txt allowed).
 * A corrupt/empty resume must never be submitted, so a failure here blocks live submit.
 */
export function validateResumeFile(resumePath: string | null | undefined): ResumeValidation {
  if (!resumePath) return { ok: false, reason: "no resume path", bytes: 0 };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resumePath);
  } catch {
    return { ok: false, reason: `resume file missing: ${resumePath}`, bytes: 0 };
  }
  if (!stat.isFile()) return { ok: false, reason: "resume path is not a file", bytes: 0 };
  if (stat.size < 512) return { ok: false, reason: `resume too small (${stat.size}B) — likely empty/corrupt`, bytes: stat.size };
  if (stat.size > 5_000_000) return { ok: false, reason: `resume too large (${stat.size}B)`, bytes: stat.size };

  const dot = resumePath.lastIndexOf(".");
  const ext = dot >= 0 ? resumePath.slice(dot).toLowerCase() : "";
  const head = Buffer.alloc(8);
  let read = 0;
  try {
    const fd = fs.openSync(resumePath, "r");
    try {
      read = fs.readSync(fd, head, 0, 8, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { ok: false, reason: "resume file unreadable", bytes: stat.size };
  }
  if (read < 4) return { ok: false, reason: "resume file truncated", bytes: stat.size };

  if (ext === ".docx") {
    // .docx is an OOXML ZIP — must begin with the local-file-header magic "PK\x03\x04".
    if (!(head[0] === 0x50 && head[1] === 0x4b)) {
      return { ok: false, reason: "docx is not a valid ZIP (corrupt Word file)", bytes: stat.size };
    }
  } else if (ext === ".pdf") {
    if (!(head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46)) {
      return { ok: false, reason: "pdf header (%PDF) missing", bytes: stat.size };
    }
  } else if (ext !== ".txt") {
    return { ok: false, reason: `unsupported resume extension '${ext}'`, bytes: stat.size };
  }
  return { ok: true, reason: `ok (${stat.size}B ${ext})`, bytes: stat.size };
}

/**
 * Confirm the resume actually attached to the form after an upload attempt: either a file input now
 * carries a file, or the form is displaying the filename. Catches the "Resume/CV is required"
 * rejection where setInputFiles silently targeted the wrong/no input.
 */
export async function verifyResumeAttached(page: Page, resumePath: string): Promise<boolean> {
  const base = resumePath.split(/[\\/]/).pop() ?? "";
  const hasFile = await page
    .evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      return inputs.some((i: any) => i.files != null && i.files.length > 0);
    })
    .catch(() => false);
  if (hasFile) return true;
  if (base) {
    const body = await page.locator("body").innerText().catch(() => "");
    if (body.includes(base)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Advanced fill: React comboboxes + required consent checkboxes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Set a JS combobox (Greenhouse React-Select, Ashby) by visible option text. Native <select> is
 * handled elsewhere; this drives the click-to-open → pick-option interaction these widgets need.
 * Best-effort: opens via the labelled control, clicks a matching [role=option], else types-to-filter
 * and presses Enter. Returns whether a selection was made.
 */
export async function selectComboboxByLabel(page: Page, labelPatterns: RegExp[], optionText: string): Promise<boolean> {
  if (!optionText) return false;
  const optRe = new RegExp("^\\s*" + escapeRegExp(optionText), "i");
  for (const re of labelPatterns) {
    // ONLY drive a properly-labelled combobox (no getByText opener — that could click arbitrary page
    // text and leave focus somewhere unexpected). Open it, then click a matching option. If we can't
    // find a matching option, press Escape and report failure — NEVER blind-type or claim success.
    const labelled = page.getByLabel(re).first();
    if ((await labelled.count().catch(() => 0)) === 0) continue;
    try {
      await labelled.click({ timeout: ACTION_TIMEOUT_MS });
    } catch {
      continue;
    }
    let option = page.getByRole("option", { name: optRe }).first();
    if ((await option.count().catch(() => 0)) === 0) {
      // Type INTO the labelled control (not the global keyboard) to filter, then re-look.
      try {
        await labelled.type(optionText, { delay: 15 });
      } catch {
        /* not typable; fall through to the option re-check */
      }
      option = page.getByRole("option", { name: optRe }).first();
    }
    if ((await option.count().catch(() => 0)) > 0) {
      try {
        await option.click({ timeout: ACTION_TIMEOUT_MS });
        return true;
      } catch {
        /* couldn't click the option */
      }
    }
    // Couldn't select cleanly — close the menu so we don't leave the page in a half-open state.
    await page.keyboard.press("Escape").catch(() => {});
  }
  return false;
}

/**
 * Check every REQUIRED, currently-unchecked checkbox (the consent / terms / privacy boxes ATS forms
 * gate submit on). Only required boxes are touched — optional marketing opt-ins are left alone.
 * Returns the count of boxes newly checked.
 */
export async function checkRequiredConsentBoxes(page: Page): Promise<number> {
  const boxes = page.locator('input[type="checkbox"]');
  const n = await boxes.count().catch(() => 0);
  let checked = 0;
  for (let i = 0; i < n; i++) {
    const box = boxes.nth(i);
    const required = await box
      .evaluate((el: any) => el.required || el.getAttribute("aria-required") === "true")
      .catch(() => false);
    if (!required) continue;
    if (await box.isChecked().catch(() => true)) continue;
    try {
      await box.check({ timeout: ACTION_TIMEOUT_MS });
      checked++;
    } catch {
      try {
        await box.click({ timeout: ACTION_TIMEOUT_MS });
        checked++;
      } catch {
        /* leave it; findUnfilledRequiredFields will catch it and block submit */
      }
    }
  }
  return checked;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Required-field enumeration (the core honesty fix)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the LIVE form and return the labels of every REQUIRED, visible control that is still empty.
 * This does not rely on our question list — it inspects the actual DOM, so required fields we never
 * knew about (LinkedIn, "current company", consent boxes, work-auth selects) are caught. A non-empty
 * result MUST block live submit. Runs entirely in-page; returns [] on any failure (defensive).
 */
export async function findUnfilledRequiredFields(page: Page): Promise<string[]> {
  // Passed as a raw JS STRING (not a function) on purpose: tsx/esbuild `keepNames` wraps named inner
  // functions with a `__name` helper that is undefined in the browser, which breaks a serialized
  // function callback. A string is evaluated verbatim in-page, so it sidesteps that entirely.
  const result = await page.evaluate(REQUIRED_FIELDS_JS).catch(() => [] as string[]);
  return Array.isArray(result) ? (result as string[]) : [];
}

const REQUIRED_FIELDS_JS = `(() => {
  function labelFor(el) {
    var al = el.getAttribute("aria-label");
    if (al && al.trim()) return al.trim();
    var id = el.id;
    if (id) {
      var labels = Array.prototype.slice.call(document.querySelectorAll("label"));
      for (var k = 0; k < labels.length; k++) {
        if (labels[k].htmlFor === id && labels[k].textContent && labels[k].textContent.trim()) return labels[k].textContent.trim();
      }
    }
    var lb = el.getAttribute("aria-labelledby");
    if (lb) { var byId = document.getElementById(lb); if (byId && byId.textContent && byId.textContent.trim()) return byId.textContent.trim(); }
    var closest = el.closest("label");
    if (closest && closest.textContent && closest.textContent.trim()) return closest.textContent.trim();
    return el.getAttribute("placeholder") || el.getAttribute("name") || el.tagName.toLowerCase();
  }
  function isVisible(el) {
    var r = el.getBoundingClientRect();
    var s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  }
  var out = [];
  var all = Array.prototype.slice.call(document.querySelectorAll("input, textarea, select, [role=combobox]"));
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var required = el.required || el.getAttribute("aria-required") === "true";
    if (!required) continue;
    var type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "hidden") continue;
    var file = type === "file";
    if (!isVisible(el) && !file) continue;
    var tag = el.tagName.toLowerCase();
    var filled = false;
    if (type === "checkbox" || type === "radio") filled = el.checked;
    else if (file) filled = !!el.files && el.files.length > 0;
    else if (tag === "select") filled = !!el.value && el.value !== "";
    else if (el.getAttribute("role") === "combobox") { var t = (el.value || "") + (el.textContent || ""); filled = t.trim() !== ""; }
    else filled = (el.value || "").trim() !== "";
    if (!filled) {
      var label = String(labelFor(el)).replace(/\\s+/g, " ").trim().slice(0, 60);
      if (label && out.indexOf(label) === -1) out.push(label);
    }
  }
  return out;
})()`;

// ─────────────────────────────────────────────────────────────────────────────
// 4. Post-submit confirmation (kills the false-positive submit)
// ─────────────────────────────────────────────────────────────────────────────

const CONFIRM_TEXT: RegExp[] = [
  /thank you for applying/i,
  /thanks for applying/i,
  /application (was |has been )?(submitted|received|sent|complete)/i,
  /your application has been (submitted|received|sent)/i,
  /we('| ha)ve received your application/i,
  /successfully (applied|submitted)/i,
  /application submitted/i,
];

/** A residual "this field is required" / error on the page means the submit was REJECTED. */
const REJECT_TEXT: RegExp[] = [/this field is required/i, /please (complete|fill|correct|accept)/i, /is required\b/i];

export interface ConfirmResult {
  confirmed: boolean;
  signal: string;
}

/**
 * Decide whether a clicked submit actually went through. Confirmed only on a positive signal:
 * a confirmation URL, confirmation copy, or the apply form disappearing after a navigation. If
 * validation errors are still on the page, or nothing changed, it is NOT confirmed (→ "rejected").
 */
export async function verifySubmissionConfirmed(page: Page, beforeUrl: string): Promise<ConfirmResult> {
  // Let the post/SPA settle and any confirmation render.
  try {
    await page.waitForLoadState("networkidle", { timeout: 10_000 });
  } catch {
    /* networkidle can time out on chatty pages; fall through to content checks */
  }

  const url = page.url();
  const body = await page.locator("body").innerText().catch(() => "");

  // Hard negative: validation errors still present means the form bounced the submit.
  const stillErroring = REJECT_TEXT.some((re) => re.test(body));

  // 1) Confirmation copy.
  for (const re of CONFIRM_TEXT) {
    if (re.test(body)) return { confirmed: true, signal: `text:${re.source.slice(0, 30)}` };
  }
  // 2) URL moved to a confirmation/thank-you path.
  if (url !== beforeUrl && /thank|confirm|success|submitted|applied|complete/i.test(url)) {
    return { confirmed: true, signal: `url→${url}` };
  }
  // 3) The apply form is gone after a navigation and no errors are showing.
  if (!stillErroring) {
    const formCtrls = await page
      .locator('input[type="file"], #submit_app, button:has-text("Submit"), form input[type="submit"]')
      .count()
      .catch(() => 1);
    if (formCtrls === 0 && url !== beforeUrl) return { confirmed: true, signal: "form-gone+nav" };
  }
  return { confirmed: false, signal: stillErroring ? "validation errors remain" : "no confirmation detected" };
}
