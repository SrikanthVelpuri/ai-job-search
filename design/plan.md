# Plan — Autonomous Job-Application System

**Status:** ✅ BUILT (Phases 0–7) · **Date:** 2026-06-21 · **Owner:** Srikanth Velpuri

> **Built & verified 2026-06-21.** The system lives under [`agent/`](../agent/README.md) (Node + TS,
> not Bun — see the runtime note). 28 automated checks pass (7 spine unit, 16 acceptance incl. a live
> dry-run fill of a real Greenhouse form, 5 MCP). Live sourcing pulled 97 senior-AI/ML jobs from 16
> companies across 3 ATS connectors. `APPLY_MODE=dryrun` by default — nothing submits until you flip
> it and ramp. **Before real use: populate skills/experience in `profile/profile.json` via `/setup`.**
> Phase-by-phase status is in §5 below.

---

## 1. What we decided (from the scoping Q&A)

| Decision | Choice | Consequence |
|---|---|---|
| **Market** | US / North America | Drop the Danish scrapers. Build US sources: ATS public APIs (Greenhouse / Lever / Ashby), Adzuna, USAJobs, remote aggregators. |
| **First targets** | **Top tech + AI/ML companies that sponsor H-1B — excluding Amazon** | Reached via 3 connector tiers (clean ATS API / Workday / custom career site). Sourcing is easy across all; *apply* difficulty rises by tier. See [design.md §2.2](design.md#22-sourcing-lane-a-inputs) + [§2.5](design.md#25-apply-engine-unattended). |
| **Submit automation** | **Fully unattended** | Highest-risk path. Built behind a hard guardrail layer (caps, dry-run ramp, kill switch, audit log). See [guardrails.md](guardrails.md). |
| **AIApply** | **Separate lane** | Not driven programmatically. We ingest *what it applied to* into the shared tracker for dedup + analytics. |
| **Jobright** | **Separate lane** | Not driven programmatically. We ingest its *matches* into the tracker; optionally re-score and route high-fit ones into the custom lane. |
| **Custom workflows** | **Claude Agent SDK** | The "brain": source → score → tailor → apply → track, as composable SDK workflows. |
| **Runtime** | **Both** | Claude Code = scheduled/unattended batch. Claude Desktop = interactive review + browser. Shared MCP server glues them. |

## 2. Goal & non-goals

**Goal:** A system that, every day and unattended, sources fresh US jobs, scores them against your
real profile, tailors a CV + cover letter + screening answers, submits qualifying applications, and
logs everything — while two independent lanes (AIApply, Jobright) run in parallel and feed the same
tracker so nothing is applied to twice.

**Non-goals (v1):**
- No reverse-engineering of AIApply / Jobright private APIs (they have none — see [design.md](design.md#4-third-party-lanes)).
- No fabricated answers, skills, or experience — ever. Unattended ≠ dishonest.
- No captcha-defeating against sites that block bots. We detect → skip → flag.
- No Workday in the first apply release (hardest ATS; deferred to Phase 4b).

## 3. The three-lane model

All three lanes write to **one shared tracker** (`data/jobs.db`). Dedup runs across lanes so you
never double-apply via two channels.

```
 Lane A — CUSTOM (Claude Agent SDK)   ← the system we build
   source → score → tailor → apply(unattended) → track

 Lane B — AIApply (independent)        ← you run its extension
   ... → ingest its application log → track

 Lane C — Jobright (independent)       ← you run its matcher
   export matches → ingest → (re-score) → optionally route to Lane A → track
```

## 4. Reusing the repo's existing agents & skills

The custom lane (A) is **not built from scratch.** The Agent SDK orchestrator runs *inside this
repo*, so it inherits every existing skill, slash command, and subagent under `.claude/`
automatically (same engine as Claude Code, same `CLAUDE.md`, same MCP servers). The SDK becomes the
deterministic, scheduled, guard-railed **outer loop**; the existing assets stay the **domain experts
it delegates to.**

| Stage | Existing asset reused | Adaptation |
|---|---|---|
| Discovery / triage | [job-scraper skill](../.claude/skills/job-scraper/SKILL.md) — dedup (`seen_jobs.json`), quick-fit triage, tracker bookkeeping | Swap Danish WebSearch queries → US; runs **alongside** the new API connectors, both writing to one tracker |
| Fit scoring | [job-application-assistant skill](../.claude/skills/job-application-assistant/SKILL.md) Step 1 + [04-job-evaluation.md](../.claude/skills/job-application-assistant/04-job-evaluation.md) | Used as-is; threshold gate added |
| Tailoring (CV + letter) | [/apply drafter-reviewer command](../.claude/commands/apply.md) — draft → reviewer agent → revise → compile & inspect PDFs | Add an **`/apply --unattended`** variant: the two "Should I proceed?" gates become the fit-threshold + guardrail checks |
| Company research (in review) | [gemini-research-expert subagent](../.claude/agents/gemini-research-expert.md) or the existing `general-purpose` reviewer | gemini path optional (needs `gemini` CLI); default stays the WebSearch reviewer already in `/apply` |
| Strategy / gap analysis | [upskill skill](../.claude/skills/upskill/SKILL.md) | Run periodically against the tracker to steer the watchlist & which roles to chase |
| Profile knowledge | [01–07 profile files](../.claude/skills/job-application-assistant/) + [CLAUDE.md](../CLAUDE.md) | `profile.json` is a structured **projection** of these, not a replacement |

So **"Claude SDK agent + existing repo agents"** = the SDK schedules, gates, dedups, and enforces
guardrails; the existing skills/commands/subagents do the domain work they already do well. We only
write *new* code where no asset exists: API connectors, SQLite tracker, Playwright apply engine, and
lane ingestion. Architecture detail is in [design.md §3](design.md#3-how-the-sdk-orchestrator-reuses-existing-agents).

## 5. Phased roadmap

Each phase ships independently and has an acceptance test. We do **not** turn on unattended submit
until Phase 7.

### Phase 0 — Foundations
- `profile/profile.json` (machine-readable profile) + `profile/answer-bank.md` (pre-answered common
  ATS screening questions: work auth, years of experience, relocation, salary, EEO defaults).
- SQLite schema for jobs / applications / lanes (`data/jobs.db`).
- Sideline the Danish scrapers (keep in repo, remove from the active path).
- **Accept:** `profile.json` validates against schema; empty DB created; market switch documented.

### Phase 1 — Sourcing (Lane A inputs)
- **Top-companies watchlist (excl. Amazon)** across three connector tiers: **(a) clean ATS APIs**
  (Greenhouse/Lever/Ashby) — e.g. top AI labs/startups; **(b) Workday** JSON — e.g. NVIDIA and many
  large firms; **(c) custom career sites** — Google, Meta, Apple, Netflix, Microsoft. Filtered to
  **senior/staff/lead AI/ML** roles. Endpoints verified at build time.
- Adzuna as a cross-company supplement.
- Normalize → dedup → write to tracker.
- **Accept:** one command pulls N senior/staff/lead AI/ML jobs from ≥3 companies across ≥2 tiers into
  the DB, deduplicated.

### Phase 2 — Scoring + tailoring
- Fit-scoring agent (reuse [04-job-evaluation.md](../.claude/skills/job-application-assistant/04-job-evaluation.md)); threshold gate.
- Reuse drafter-reviewer CV + cover-letter pipeline + PDF verification loop.
- Add **ATS-safe resume** variant + **screening-answer generator** (from answer bank).
- **Accept:** for a sample job, produce scored rationale + compiled CV/letter + a filled screening-answer set.

### Phase 3 — Shared MCP server
- MCP server exposing tools: `search_jobs`, `score_fit`, `tailor_application`, `fill_form`,
  `track`, `report`. Usable from Claude Code **and** Claude Desktop.
- **Accept:** both clients can call every tool against the same DB.

### Phase 4 — Apply engine (Playwright)
- **4a:** Form-fillers for Greenhouse, Lever, Ashby (simplest, most consistent forms). Dry-run only.
- **4b (deferred):** Workday.
- Audit log + screenshot of every (simulated) submission.
- **Accept:** dry-run fills a real form end-to-end and stops *before* submit, with a screenshot.

### Phase 5 — Lanes B & C ingestion
- AIApply application-log ingest; Jobright match export ingest; cross-lane dedup; optional re-score + route.
- **Accept:** a job applied via AIApply is never re-applied by Lane A.

### Phase 6 — Orchestration + scheduling + dashboard
- Daily orchestrator (Claude Code `/schedule` or `/loop`): source → score → tailor → queue.
- Markdown/HTML daily report: new matches, drafts ready, per-lane response rates.
- **Accept:** a single scheduled run produces a dated report and a ready apply-queue.

### Phase 7 — Unattended hardening + ramp
- Wire guardrails ([guardrails.md](guardrails.md)): daily cap, per-company cap, fit threshold,
  ATS allowlist, kill switch, dry-run→live ramp.
- Ramp: dry-run week → 3 live apps/day → raise cap as response data comes in.
- **Accept:** kill switch halts mid-run; caps enforced; every submission has an audit record.

## 6. Open questions — answers & what's left

### Resolved (answered 2026-06-21)
1. **US work authorization:** On **H-1B — sponsorship required.** Consequences:
   - Screening forms auto-answer: "Authorized to work in the US?" = **Yes (H-1B)**; "Will you now or
     in the future require sponsorship?" = **Yes**.
   - Sourcing/scoring apply a **hard pre-filter**: drop postings that say *no sponsorship*, *US
     citizens only*, or *active clearance required*; **boost** postings that explicitly sponsor.
2. **Target roles:** **senior / staff / lead** AI/ML — Senior/Staff/Lead AI/ML Engineer, ML Platform
   Engineer, AI/ML Architect (Principal-adjacent). **Companies:** top tech + AI/ML firms that sponsor
   H-1B, **excluding Amazon**. **Locations: open — willing to relocate anywhere**, no geographic
   filter (remote also in scope).

### Resolved (answered 2026-06-24)
3. **Remote preference & salary floor:** **Open to all** (remote/hybrid/onsite — no geo filter, relocation OK) and **no salary floor**. → no remote or salary prefilter is applied.
4. **Daily application cap:** **5/day** during the live ramp (`DAILY_CAP=5`; code default stays 3 until live). Start there, raise as response data comes in.
5. **Captcha policy:** **skip-and-flag** (`CAPTCHA_POLICY=skip_and_flag`, already the default) — detect, skip that app, log for manual handling.

### Still open
6. **Do AIApply / Jobright export/import a job list**, or only manual log? (couples Lanes B/C)
7. **Workday now or later?** (Recommend later.)

## 7. What you're reviewing
- This plan ([plan.md](plan.md))
- The architecture ([design.md](design.md))
- The safety system for unattended apply ([guardrails.md](guardrails.md))

Approve / edit these, answer §6, and I'll start at Phase 0.
