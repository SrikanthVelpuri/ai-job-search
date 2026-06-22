/**
 * greenhouse-filler.ts — Playwright FormFiller for Greenhouse-hosted application forms.
 *
 * Greenhouse is the cleanest of the v1 ATS targets: public apply page, a stable `#job_application`
 * form, and well-known field ids (#first_name, #last_name, #email, #phone, #resume file input).
 * Custom screening questions render as labelled inputs/selects inside `.field` wrappers, so the
 * shared label-based mapping in runStandardFill handles them without Greenhouse-specific code.
 *
 * SAFETY: this module owns NO submit logic of its own. The single guarded submit path lives in
 * runStandardFill (base-filler.ts); we only hand it a locator for the submit button, which it
 * clicks ONLY in live mode after the unanswerable/flagged-field gate clears. See that file's
 * CRITICAL SAFETY INVARIANT.
 *
 * Selector assumptions (documented in assumptions[]): board served at boards.greenhouse.io /
 * job-boards.greenhouse.io / an embedded grnhse iframe; classic field ids present. We use
 * tolerant label/attribute fallbacks so the embedded React board variant still fills.
 */

import type { Page } from "playwright";
import type { FormFiller, FillContext, FillResult } from "../types.js";
import { runStandardFill, type FillerSpec } from "./base-filler.js";

/** Greenhouse-specific field selectors, expressed as label/attribute patterns. */
const SPEC: FillerSpec = {
  ats: "greenhouse",
  // #first_name / #last_name ids + the visible "First Name" / "Last Name" labels.
  firstNamePatterns: [/first\s*name/i, /given\s*name/i],
  lastNamePatterns: [/last\s*name/i, /family\s*name|surname/i],
  fullNamePatterns: [/full\s*name/i, /^name$/i],
  emailPatterns: [/email/i],
  phonePatterns: [/phone/i, /mobile/i],
  /**
   * Greenhouse's submit control is an <input type="submit" id="submit_app"> or a button reading
   * "Submit Application". We try the id first, then the accessible-name button, then a generic
   * submit input within the application form. Returns null if none resolve.
   */
  async findSubmitButton(page: Page) {
    const byId = page.locator("#submit_app, input#submit_app").first();
    if ((await byId.count().catch(() => 0)) > 0) return byId;

    const byName = page.getByRole("button", { name: /submit application|submit/i }).first();
    if ((await byName.count().catch(() => 0)) > 0) return byName;

    const byType = page.locator("#job_application input[type=submit], form input[type=submit]").first();
    if ((await byType.count().catch(() => 0)) > 0) return byType;

    return null;
  },
};

/**
 * Greenhouse FormFiller. matches() recognizes greenhouse.io boards in their several URL shapes;
 * fill() delegates entirely to the shared, safety-gated flow.
 */
export const greenhouseFiller: FormFiller = {
  ats: "greenhouse",
  matches(url: string): boolean {
    return /greenhouse\.io|boards\.greenhouse|job-boards\.greenhouse/i.test(url);
  },
  fill(page: Page, ctx: FillContext): Promise<FillResult> {
    return runStandardFill(page, ctx, SPEC);
  },
};
