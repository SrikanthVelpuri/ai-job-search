/**
 * spine.test.ts — tests for the stable foundation: dedup canonicalization and the tracker's
 * dedup / per-company / daily-cap gates. Run: `node --test --import tsx ./test/spine.test.ts`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeDedupHash, canonicalizeCompany, canonicalizeTitle } from "../src/tracker/dedup.js";
import { Tracker } from "../src/tracker/db.js";
import type { SourcedJob } from "../src/types.js";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jobsdb-")), "jobs.db");
}

function fakeJob(over: Partial<SourcedJob> = {}): SourcedJob {
  return {
    source: "greenhouse",
    ats: "greenhouse",
    company: "Anthropic, Inc.",
    title: "Senior Machine Learning Engineer (Remote)",
    location: "San Francisco, CA, USA",
    remote: false,
    url: "https://example.com/job/1",
    jdText: "We sponsor H-1B visas.",
    postedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

test("dedup hash is stable across cosmetic company/title/location variance", () => {
  const a = computeDedupHash("Anthropic, Inc.", "Senior ML Engineer", "San Francisco, CA, USA", false);
  const b = computeDedupHash("Anthropic", "senior ml engineer", "San Francisco", null);
  assert.equal(a, b, "company suffix + case + location tail should not change the hash");
});

test("canonicalizers strip noise", () => {
  assert.equal(canonicalizeCompany("OpenAI LLC"), "openai");
  assert.equal(canonicalizeTitle("Staff AI Engineer (Remote, US)"), "staff ai engineer");
});

test("upsertJob dedups on hash", () => {
  const t = new Tracker(tmpDb());
  t.init();
  const r1 = t.upsertJob(fakeJob());
  const r2 = t.upsertJob(fakeJob({ url: "https://different-url.com/2" })); // same company/title/loc
  assert.equal(r1.inserted, true);
  assert.equal(r2.inserted, false);
  assert.equal(r1.id, r2.id);
  assert.equal(t.countJobs(), 1);
  t.close();
});

test("cross-lane dedup: an active application in any lane blocks re-apply", () => {
  const t = new Tracker(tmpDb());
  t.init();
  const { id, dedupHash } = t.upsertJob(fakeJob());
  assert.equal(t.hasApplicationForHash(dedupHash), false);
  t.createApplication({ jobId: id, lane: "aiapply", status: "submitted" });
  assert.equal(t.hasApplicationForHash(dedupHash), true, "submitted in lane B blocks lane A");
  t.close();
});

test("skipped/failed applications do NOT permanently block", () => {
  const t = new Tracker(tmpDb());
  t.init();
  const { id, dedupHash } = t.upsertJob(fakeJob());
  t.createApplication({ jobId: id, lane: "custom", status: "skipped" });
  assert.equal(t.hasApplicationForHash(dedupHash), false);
  t.close();
});

test("per-company cap finds a recent active application", () => {
  const t = new Tracker(tmpDb());
  t.init();
  const { id } = t.upsertJob(fakeJob());
  assert.equal(t.recentApplicationForCompany("Anthropic, Inc.", 30), null);
  t.createApplication({ jobId: id, lane: "custom", status: "submitted" });
  assert.notEqual(t.recentApplicationForCompany("Anthropic, Inc.", 30), null);
  t.close();
});

test("daily-cap counter counts submitted-today only when asked", () => {
  const t = new Tracker(tmpDb());
  t.init();
  const { id } = t.upsertJob(fakeJob());
  t.createApplication({ jobId: id, lane: "custom", status: "tailored", mode: "dryrun" });
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const since = startOfDay.toISOString();
  assert.equal(t.countApplicationsSince(since, { submittedOnly: true }), 0, "no submissions yet");
  assert.equal(t.countApplicationsSince(since), 1, "one application row today");
  t.close();
});
