# Design — Autonomous Job-Application System (Architecture)

**Status:** DRAFT for review · **Date:** 2026-06-21

Companion to [plan.md](plan.md) and [guardrails.md](guardrails.md).

---

## 1. Architecture at a glance

```
                       ┌───────────────────────────────────────────────┐
                       │              Shared MCP server                 │
                       │  search_jobs · score_fit · tailor_application  │
                       │  · fill_form · track · report                  │
                       └───────────────────────────────────────────────┘
                              ▲                              ▲
        Claude Code (CLI / scheduled, unattended)   Claude Desktop (interactive)
        - daily orchestrator (/schedule, /loop)     - review queue & analytics
        - source · score · tailor · apply · track   - Playwright form-fill / overrides
                              │                              │
                              └──────────────┬───────────────┘
                                             ▼
                              ┌──────────────────────────────┐
                              │   data/jobs.db  (SQLite)      │  ← single source of truth
                              │   jobs · applications · lanes │     (dedup across A/B/C)
                              └──────────────────────────────┘
            ▲                                ▲                                ▲
   Lane A: CUSTOM (Agent SDK)        Lane B: AIApply (ingest)        Lane C: Jobright (ingest)
```

**Principle:** Claude is the brain, Playwright is the hands, the DB is the memory, and the two
third-party tools are independent lanes that only *report into* the DB.

## 2. Components

### 2.1 Profile & knowledge base
- `profile/profile.json` — machine-readable: identity, contact, **US work authorization (H-1B —
  sponsorship required)**, education,
  experience (rich bullets), skills, preferences (titles, locations, remote, salary floor, sectors,
  dealbreakers), EEO/voluntary self-id defaults.
- `profile/answer-bank.md` — pre-answered common ATS screening questions. **This is the linchpin of
  unattended apply** — Greenhouse/Lever/Ashby ask custom questions; the answer bank lets the agent
  respond without fabricating. Unknown questions → flag, don't guess.
- Existing skills ([job-application-assistant](../.claude/skills/job-application-assistant/)) remain the
  prose/tailoring knowledge; `profile.json` is the structured projection used by code.

### 2.2 Sourcing (Lane A inputs)

**Top-companies-first, excluding Amazon.** Seed watchlist = top tech + AI/ML employers that sponsor
H-1B. They split into three **connector tiers** by how you reach them — sourcing is easy across all
three; **apply difficulty rises down the table** (see §2.5):

| Connector tier | Example top companies | Source mechanism | Apply difficulty |
|---|---|---|---|
| **Clean ATS API** | OpenAI, Anthropic, Databricks, Scale AI, … | Greenhouse / Lever / Ashby public JSON | easiest — no login, unattended-friendly |
| **Workday JSON** | NVIDIA, Salesforce, … | per-company `…/wday/cxs/.../jobs` endpoint | hard (Workday *apply* deferred) |
| **Custom career site** | Google, Meta, Apple, Netflix, Microsoft | per-company (mostly unofficial) search / GraphQL endpoint | hardest — login + bot detection |

Exact endpoints are verified/maintained at build time (the Workday + custom-site ones are unofficial
and per-company). All tiers filtered to **senior / staff / lead AI/ML** titles (§2.3). **Amazon is
excluded** per directive.

Supplement: **Adzuna** REST API (free key) for cross-company aggregated search. (USAJobs/federal is
dropped from the seed — most federal roles require citizenship, so **low fit** under H-1B.)

Watchlist (`profile/watchlist.json`): one entry per company tagged with its connector tier. Normalize
→ dedup (by canonical company+title+location hash) → tracker.

### 2.3 Scoring
Fit-scoring agent reuses the framework in
[04-job-evaluation.md](../.claude/skills/job-application-assistant/04-job-evaluation.md). Output:
score, rationale, skill-match, gaps. A threshold gate (configurable) decides what proceeds to tailoring.

**Hard pre-filters (before scoring):** the candidate is on **H-1B and needs sponsorship**, so drop
postings that state *no visa sponsorship*, *US citizens only*, or *active security clearance
required*; **boost** postings that explicitly offer sponsorship. **Target roles:** **senior / staff /
lead** AI/ML (Engineer / Platform Engineer / Architect), Principal-adjacent. **Companies:** top tech +
AI/ML firms that sponsor, **excluding Amazon**. **No geographic filter** — open to relocation
anywhere; remote in scope.

### 2.4 Tailoring
- Reuse the **drafter-reviewer** CV + cover-letter pipeline and the **PDF verification loop** (the
  genuinely strong parts of the current repo): lualatex CV (exactly 2 pp), xelatex cover letter (1 p).
- Add an **ATS-safe resume** variant (clean single-column text PDF) because moderncv's layout can
  confuse ATS parsers.
- **Screening-answer generator:** maps each job's custom questions to the answer bank; tailors the
  free-text ones; flags anything unanswerable.

### 2.5 Apply engine (unattended)
- **Playwright** form-fillers, one module per ATS: Greenhouse → Lever → Ashby first (consistent
  forms), Workday deferred.
- Every run: load profile + tailored artifacts → fill → **screenshot** → (dry-run: stop) / (live:
  submit) → write audit record.
- Captcha / login-wall / unknown field → **skip + flag**, never force.
- **Tiered apply difficulty (maps to §2.2):** the **clean-ATS tier** (Greenhouse/Lever/Ashby) is
  unattended-friendly (no login) and is the v1 unattended target. **Workday** and **custom career
  sites** (Google, Meta, Apple, Netflix, Microsoft) require logins and run bot detection, so v1
  recommendation is **source + tailor automatically, submit attended** there (queued to Claude Desktop
  for a one-click submit). Unattended on those tiers can be enabled later, at a higher skip/flag rate.
- All submission behavior is gated by [guardrails.md](guardrails.md).

### 2.6 Tracker & analytics
SQLite (`data/jobs.db`), accessed via the MCP `track` tool. Tables:

```
jobs(id, source, ats, company, title, location, remote, url, jd_text, posted_at, fetched_at, dedup_hash)
applications(id, job_id, lane, status, fit_score, cv_path, letter_path, answers_json,
             screenshot_path, submitted_at, outcome, notes)
lanes(name, last_run_at, config_json)        -- 'custom' | 'aiapply' | 'jobright'
events(id, ts, level, lane, message)          -- audit log
```

Dedup across lanes uses `jobs.dedup_hash`; an application in any lane blocks re-apply in others.

### 2.7 Orchestration
- **Claude Code**, scheduled (`/schedule` cloud cron or `/loop`): `source → score → tailor → apply
  (within caps) → report`. This is the unattended driver.
- **Claude Desktop**, interactive: review the queue, inspect screenshots, override/abort, read analytics.
- Both call the **same MCP tools** → identical behavior, one DB.

## 3. How the SDK orchestrator reuses existing agents

Lane A is a thin **deterministic shell** around assets that already live in `.claude/`. Because the
Agent SDK runs the same engine as Claude Code *from inside this repo*, it can invoke project skills,
slash commands, and subagents directly — no reimplementation. The SDK owns control flow (loop,
scheduling, guardrails, DB writes); the existing assets own the domain reasoning.

### 3.1 Per-stage delegation

| Stage | SDK does (new) | Delegates to (existing asset) |
|---|---|---|
| **Source** | run API connectors, merge feeds, compute dedup hash | [job-scraper skill](../.claude/skills/job-scraper/SKILL.md) — WebSearch discovery, quick-fit triage, `seen_jobs.json` bookkeeping |
| **Score** | threshold gate, persist score | [job-application-assistant](../.claude/skills/job-application-assistant/SKILL.md) Step 1 + [04-job-evaluation.md](../.claude/skills/job-application-assistant/04-job-evaluation.md) |
| **Tailor** | pick artifacts, route by fit | [/apply](../.claude/commands/apply.md) — draft → reviewer → revise → compile/inspect PDFs (reviewer step may call [gemini-research-expert](../.claude/agents/gemini-research-expert.md)) |
| **Apply** | Playwright fill, screenshot, submit (guarded) | answer-bank + the tailored artifacts produced above |
| **Track** | write `jobs`/`applications`/`events`, cross-lane dedup | — (new SQLite) |
| **Strategy** | schedule periodic runs | [upskill skill](../.claude/skills/upskill/SKILL.md) — steers the watchlist & which roles to chase |

### 3.2 The one change to an existing asset: `/apply --unattended`

`/apply` today has two human gates ("Should I proceed with drafting?" and the final "ready for your
review" hand-off). For unattended operation we add a parameterized **non-interactive mode** that:
- replaces the proceed-gate with the **fit-threshold** decision from the scoring stage,
- replaces the final hand-off with **auto-continue into the apply engine**,
- keeps every other step identical — crucially the **mandatory PDF compile-and-inspect loop**, which
  is exactly the quality bar unattended apply needs.

Interactive `/apply` stays untouched for when you drive an application by hand in Claude Desktop.

### 3.3 Invocation mechanics
- Skills/commands/subagents resolve automatically: the SDK process runs with this repo as its working
  directory, so discovery is identical to Claude Code.
- The orchestrator invokes them as **subagents / command runs** and captures structured results (fit
  score, file paths, reviewer feedback) to drive the next stage.
- [gemini-research-expert](../.claude/agents/gemini-research-expert.md) is **optional** — it needs the
  `gemini` CLI on PATH. If absent, the reviewer falls back to the WebSearch research already built
  into [/apply](../.claude/commands/apply.md) Step 3.

## 4. Third-party lanes

> **Reality:** Neither AIApply nor Jobright exposes a public API. Their "auto-apply" is a browser
> extension. So we do **not** drive them programmatically — we keep them as independent lanes and
> integrate at the **data** level for dedup + analytics.

### Lane B — AIApply (independent)
- You run AIApply's extension as usual.
- Integration = **ingest its application history** (CSV/manual export → `lane='aiapply'` rows).
- Benefit: cross-lane dedup + unified response-rate analytics. No coupling, no ToS risk.

### Lane C — Jobright (independent)
- You run Jobright's matcher as usual.
- Integration = **ingest its match list** (export → `lane='jobright'`), optionally **re-score** with
  Claude against your real profile, and **route** high-fit matches into Lane A's apply queue.
- So Jobright becomes a *discovery feed* for the custom lane, while still operating on its own.

## 5. Runtime split: Claude Code vs Claude Desktop

| Concern | Claude Code | Claude Desktop |
|---|---|---|
| Scheduled/unattended source+score+tailor+apply | ✅ primary | — |
| Heavy batch, LaTeX compile, git history of artifacts | ✅ | — |
| Interactive queue review + screenshot inspection | — | ✅ primary |
| Browser form-fill with a human watching / overrides | possible | ✅ primary |
| Analytics dashboard reading | both | both |

Glue = the shared MCP server (§2) + the shared DB.

## 6. Tech stack
- **TypeScript on Bun** for new code (matches existing `.agents/skills/*` CLIs).
- **Claude Agent SDK (TS)** for Lane A workflows.
- **Playwright** for browser automation.
- **SQLite** (`bun:sqlite`) for the tracker.
- **MCP server (TS)** exposing tools to both clients.
- **LaTeX** (lualatex/xelatex) reused for CV/letter; plus an ATS-safe text resume.
- **Python** kept only where it already lives (salary tools).

## 7. Proposed folder layout (for the build)
```
agent/                      # Claude Agent SDK app (Lane A)
  src/
    sources/                # greenhouse.ts lever.ts ashby.ts adzuna.ts usajobs.ts
    scoring/                # fit scoring
    tailoring/              # cv, cover letter, ats-resume, screening answers
    apply/                  # playwright fillers per ATS + guardrails wrapper
    tracker/                # sqlite access
    lanes/                  # custom.ts aiapply.ts(ingest) jobright.ts(ingest)
    orchestrator.ts         # daily run
mcp/                        # shared MCP server
profile/
  profile.json
  answer-bank.md
  watchlist.json
data/
  jobs.db
  screenshots/
design/                     # ← these docs
```

## 8. Reused vs new vs retired
- **Reused (existing `.claude/` assets — see [§3](#3-how-the-sdk-orchestrator-reuses-existing-agents)):**
  [job-scraper](../.claude/skills/job-scraper/SKILL.md), [job-application-assistant](../.claude/skills/job-application-assistant/SKILL.md)
  + its 01–07 knowledge files, [/apply drafter-reviewer + PDF verification loop](../.claude/commands/apply.md),
  [gemini-research-expert](../.claude/agents/gemini-research-expert.md) (optional), [upskill](../.claude/skills/upskill/SKILL.md),
  LaTeX templates, [CLAUDE.md](../CLAUDE.md) profile.
- **New:** `profile.json` + answer bank, US API connectors, SQLite tracker, MCP server, Playwright
  apply engine, lane ingestion, the orchestrator, guardrails, and the `/apply --unattended` mode.
- **Retired from active path:** Danish portal CLIs (`.agents/skills/job*-search`) — kept in repo, off the path.
