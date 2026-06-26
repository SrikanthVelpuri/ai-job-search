/**
 * form-verify.test.ts — verifies the apply-engine hardening WITHOUT touching a real ATS or
 * submitting anything. Uses a local HTML form fixture loaded into headless chromium.
 *
 * Covers the two defects fixed after the 2026-06-25 false-submit incident:
 *   • findUnfilledRequiredFields reads the live DOM and reports empty required fields (so the gate
 *     blocks a partial submit), and reports [] once they're filled.
 *   • verifySubmissionConfirmed only confirms on a real success signal, and treats lingering
 *     "this field is required" errors as NOT confirmed (→ rejected, not submitted).
 *   • validateResumeFile rejects missing/empty/corrupt resumes and accepts a real .docx.
 *   • verifyResumeAttached / checkRequiredConsentBoxes behave against the fixture.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  validateResumeFile,
  verifyResumeAttached,
  checkRequiredConsentBoxes,
  findUnfilledRequiredFields,
  verifySubmissionConfirmed,
} from "../src/apply/form-verify.js";
import { buildResumeDocx } from "../src/tailoring/docx-resume.js";
import { launchBrowser } from "../src/apply/base-filler.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fv-"));

const FORM_HTML = `<!doctype html><html><body>
  <form id="job_application">
    <label for="fn">First Name *</label><input id="fn" required />
    <label for="ln">LinkedIn Profile *</label><input id="ln" required />
    <label for="src">How did you hear about this job? *</label>
    <select id="src" required><option value="">Select...</option><option value="web">Company Website</option></select>
    <input type="checkbox" id="consent" required aria-label="I agree to the terms" />
    <input type="file" id="resume" required aria-label="Resume/CV" />
    <button type="submit" id="submit_app">Submit Application</button>
  </form>
</body></html>`;

test("validateResumeFile: accepts a real .docx, rejects missing/empty/corrupt", async () => {
  const docx = path.join(tmp, "resume.docx");
  fs.writeFileSync(docx, await buildResumeDocx("Jane Doe\njane@x.com | 555\n\nSUMMARY\n-------\nML engineer.\n"));
  assert.equal(validateResumeFile(docx).ok, true, "valid docx should pass");

  assert.equal(validateResumeFile(path.join(tmp, "nope.docx")).ok, false, "missing file fails");

  const empty = path.join(tmp, "empty.docx");
  fs.writeFileSync(empty, "");
  assert.equal(validateResumeFile(empty).ok, false, "0-byte fails");

  const corrupt = path.join(tmp, "corrupt.docx");
  fs.writeFileSync(corrupt, "x".repeat(2000)); // not a ZIP → bad magic
  assert.equal(validateResumeFile(corrupt).ok, false, "non-zip .docx fails");

  const txt = path.join(tmp, "resume.txt");
  fs.writeFileSync(txt, "Jane Doe\n".repeat(80));
  assert.equal(validateResumeFile(txt).ok, true, ".txt is accepted");
});

test("findUnfilledRequiredFields detects empty required fields, then clears once filled", async () => {
  const browser = await launchBrowser({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(FORM_HTML);

    // All five required controls start empty.
    const before = await findUnfilledRequiredFields(page);
    const joined = before.join(" | ").toLowerCase();
    assert.ok(joined.includes("first name"), `expected First Name flagged, got: ${before.join(", ")}`);
    assert.ok(joined.includes("linkedin"), `expected LinkedIn flagged, got: ${before.join(", ")}`);
    assert.ok(joined.includes("how did you hear"), `expected source flagged, got: ${before.join(", ")}`);
    assert.ok(joined.includes("agree"), `expected consent flagged, got: ${before.join(", ")}`);
    assert.ok(joined.includes("resume"), `expected resume flagged, got: ${before.join(", ")}`);

    // Fill them all the way a successful run would.
    await page.fill("#fn", "Jane");
    await page.fill("#ln", "https://linkedin.com/in/jane");
    await page.selectOption("#src", "web");
    const checked = await checkRequiredConsentBoxes(page);
    assert.equal(checked, 1, "consent checkbox should be checked by helper");
    const docx = path.join(tmp, "resume.docx");
    await page.setInputFiles("#resume", docx);

    assert.equal(await verifyResumeAttached(page, docx), true, "resume should read as attached");

    const after = await findUnfilledRequiredFields(page);
    assert.deepEqual(after, [], `all required filled → none missing, got: ${after.join(", ")}`);
  } finally {
    await browser.close();
  }
});

test("verifySubmissionConfirmed: true on a confirmation, false while errors remain", async () => {
  const browser = await launchBrowser({ headless: true });
  try {
    const page = await browser.newPage();

    await page.setContent("<body><h1>Thank you for applying!</h1></body>");
    const ok = await verifySubmissionConfirmed(page, "about:blank#before");
    assert.equal(ok.confirmed, true, `confirmation copy should confirm, got: ${ok.signal}`);

    await page.setContent('<body><form><span class="error">This field is required</span><button>Submit Application</button></form></body>');
    const bad = await verifySubmissionConfirmed(page, "about:blank#before");
    assert.equal(bad.confirmed, false, `lingering validation errors must NOT confirm, got: ${bad.signal}`);
  } finally {
    await browser.close();
  }
});
