/**
 * lever-filler.ts — Playwright FormFiller for Lever-hosted application forms.
 *
 * Lever apply pages live at jobs.lever.co/<slug>/<id>/apply and post to a single `.application-form`
 * (a real <form> with id "application-form"). The core fields use HTML name attributes rather than
 * ids: input[name="name"] (a SINGLE full-name field, not first/last), input[name="email"],
 * input[name="phone"], input[name="resume"] (the file input). Custom screening questions render
 * as `.application-question` / `.application-additional` "cards", each with a visible label, so the
 * shared label-based mapping in runStandardFill handles them.
 *
 * Because Lever uses one combined name field, we let runStandardFill's full-name fallback do the
 * work: its first/last patterns also point at name[*name*] but the fullNamePatterns catch the
 * `name="name"` field cleanly.
 *
 * SAFETY: no submit logic here. runStandardFill owns the single guarded submit path; we only
 * provide the submit-button locator, clicked ONLY in live mode after the safety gate. See
 * base-filler.ts CRITICAL SAFETY INVARIANT.
 *
 * Selector assumptions (see assumptions[]): classic Lever hosted form (not the newer embedded
 * widget); fields keyed by name attribute; submit button reads "Submit application".
 */

import type { Page } from "playwright";
import type { FormFiller, FillContext, FillResult } from "../types.js";
import { runStandardFill, type FillerSpec } from "./base-filler.js";

/** Lever-specific field selectors, as label/attribute patterns. */
const SPEC: FillerSpec = {
  ats: "lever",
  // Lever has no dedicated first/last inputs; these still probe in case a custom form adds them,
  // but the fullNamePatterns below are what actually match the standard input[name="name"].
  firstNamePatterns: [/first\s*name/i],
  lastNamePatterns: [/last\s*name/i],
  fullNamePatterns: [/full\s*name/i, /^name$/i, /your\s*name/i],
  emailPatterns: [/email/i],
  phonePatterns: [/phone/i, /mobile/i],
  /**
   * Lever's submit is a <button type="submit"> reading "Submit application" within
   * #application-form (sometimes id "btn-submit"). Try accessible name, then id, then a generic
   * form submit button. Returns null if none resolve.
   */
  async findSubmitButton(page: Page) {
    const byName = page.getByRole("button", { name: /submit application|submit/i }).first();
    if ((await byName.count().catch(() => 0)) > 0) return byName;

    const byId = page.locator("#btn-submit, button#btn-submit").first();
    if ((await byId.count().catch(() => 0)) > 0) return byId;

    const byForm = page.locator("#application-form button[type=submit], form button[type=submit]").first();
    if ((await byForm.count().catch(() => 0)) > 0) return byForm;

    return null;
  },
};

/**
 * Lever FormFiller. matches() recognizes lever.co / jobs.lever URLs; fill() delegates to the
 * shared safety-gated flow.
 */
export const leverFiller: FormFiller = {
  ats: "lever",
  matches(url: string): boolean {
    return /lever\.co|jobs\.lever/i.test(url);
  },
  fill(page: Page, ctx: FillContext): Promise<FillResult> {
    return runStandardFill(page, ctx, SPEC);
  },
};
