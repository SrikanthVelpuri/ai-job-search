/**
 * ashby-filler.ts — Playwright FormFiller for Ashby (jobs.ashbyhq.com) application forms.
 *
 * Ashby is a client-rendered React app: there are no stable element ids, and fields are wired to
 * their visible labels via aria-labelledby rather than classic <label for>. We therefore lean on
 * Playwright's getByLabel (accessibility-tree aware) for the standard fields — "Name" is a single
 * combined input, plus "Email" and "Phone". The resume is an input[type=file] hidden behind a
 * styled "Upload File" button; setInputFiles still targets the underlying input.
 *
 * Custom questions render as React widgets with a visible question label, handled by the shared
 * label-based mapping. Ashby's selects are React-Select comboboxes, NOT native <select>; the
 * shared selectOptionByLabel will fail on those and the engine flags them (skip + flag), which is
 * the correct conservative behavior — we do not click-drive arbitrary comboboxes unattended.
 *
 * SAFETY: no submit logic here. runStandardFill owns the one guarded submit path; we only provide
 * the submit-button locator, clicked ONLY in live mode after the safety gate. See base-filler.ts
 * CRITICAL SAFETY INVARIANT.
 *
 * Selector assumptions (see assumptions[]): hosted Ashby board at jobs.ashbyhq.com/<org>; fields
 * exposed via accessible labels "Name"/"Email"/"Phone"; submit button reads "Submit Application".
 * React-Select dropdowns are intentionally left to skip+flag.
 */

import type { Page } from "playwright";
import type { FormFiller, FillContext, FillResult } from "../types.js";
import { runStandardFill, type FillerSpec } from "./base-filler.js";

/** Ashby-specific field selectors, as label/attribute patterns. */
const SPEC: FillerSpec = {
  ats: "ashby",
  // Ashby uses a single "Name" field; first/last probes are best-effort, the full-name fallback
  // (matching the "Name" label) is what fills in practice.
  firstNamePatterns: [/first\s*name/i],
  lastNamePatterns: [/last\s*name/i],
  fullNamePatterns: [/^name$/i, /full\s*name/i, /your\s*name/i],
  emailPatterns: [/email/i],
  phonePatterns: [/phone/i, /mobile/i],
  /**
   * Ashby's submit is a <button> reading "Submit Application" (no stable id). We match by
   * accessible name; fall back to a generic form submit button. Returns null if none resolve.
   */
  async findSubmitButton(page: Page) {
    const byName = page.getByRole("button", { name: /submit application|submit/i }).first();
    if ((await byName.count().catch(() => 0)) > 0) return byName;

    const byForm = page.locator("form button[type=submit]").first();
    if ((await byForm.count().catch(() => 0)) > 0) return byForm;

    return null;
  },
};

/**
 * Ashby FormFiller. matches() recognizes ashbyhq.com / jobs.ashby URLs; fill() delegates to the
 * shared safety-gated flow.
 */
export const ashbyFiller: FormFiller = {
  ats: "ashby",
  matches(url: string): boolean {
    return /ashbyhq\.com|jobs\.ashby/i.test(url);
  },
  fill(page: Page, ctx: FillContext): Promise<FillResult> {
    return runStandardFill(page, ctx, SPEC);
  },
};
