# Autonomous Job-Application System (Lane A)

Implements [design/plan.md](../design/plan.md) + [design/design.md](../design/design.md) +
[design/guardrails.md](../design/guardrails.md): a system that sources fresh US senior/staff/lead
AI/ML jobs, scores them against your real profile, tailors artifacts, and submits qualifying
applications **fully unattended but inside a hard safety envelope** — while AIApply (Lane B) and
Jobright (Lane C) feed the same tracker for cross-lane dedup.

> **Default-safe.** `APPLY_MODE=dryrun` out of the box. Nothing is ever submitted until you
> explicitly flip it to `live`, and even then every guardrail must pass. See [Safety](#safety).

## Runtime note (Node, not Bun)

The design specced Bun/`bun:sqlite`; this machine has **Node 22 + npm** and no Bun, so the build
runs on **Node + TypeScript (tsx/tsc) + better-sqlite3**. The architecture is unchanged — only the
runtime differs. To port to Bun later, swap `better-sqlite3` for `bun:sqlite` (same SQL) and run
with `bun` instead of `tsx`.

## Install

```bash
cd agent
npm install
npx playwright install chromium   # only needed for the apply engine (form-fill)
```

## Layout

```
agent/src/
  types.ts              # the shared contract every module is built against
  config.ts             # config + guardrail defaults (all env-overridable)
  profile.ts            # load + zod-validate profile.json / watchlist.json / answer-bank.md
  tracker/db.ts         # SQLite tracker (jobs · applications · lanes · events) + cross-lane dedup
  tracker/dedup.ts      # canonical dedup hashing
  sources/              # greenhouse.ts lever.ts ashby.ts adzuna.ts (live-verified) + index.ts (merge)
  scoring/              # filters.ts (H-1B hard pre-filters) + score.ts (heuristic gate)
  tailoring/            # ats-resume.ts + screening-answers.ts (no fabrication)
  apply/                # base-filler.ts + {greenhouse,lever,ashby}-filler.ts + guardrails.ts + index.ts (engine)
  lanes/                # aiapply.ts + jobright.ts (CSV ingest)
  orchestrator.ts       # the daily run: source → score → tailor → apply (guarded) → report
  report.ts             # dated markdown report
  cli.ts                # operator CLI
  mcp/server.ts         # shared MCP server (Claude Code + Claude Desktop)
profile/                # profile.json (gitignored, personal) + .example + schema + answer-bank + watchlist
data/                   # jobs.db, screenshots/, reports/, resumes/, imports/ (all gitignored)
```

## CLI

```bash
npm run db:init                       # create the tracker
npm run source                        # source the verified watchlist (live)  → data/jobs.db
npx tsx src/cli.ts score              # score unapplied jobs (heuristic gate)
npx tsx src/cli.ts apply <jobId>      # tailor + guarded apply ONE job (dryrun by default)
npx tsx src/cli.ts ingest aiapply <file.csv>     # Lane B ingest
npx tsx src/cli.ts ingest jobright <file.csv>    # Lane C ingest
npm run report                        # write data/reports/report-<date>.md
npm run orchestrate                   # the full daily run (add --skip-apply / --max-apply=N / --adzuna)
npx tsx src/cli.ts halt | resume      # kill switch on/off (data/STOP)
npx tsx src/cli.ts status             # mode, caps, kill switch, counts
```

## Tests

```bash
npm test                                          # spine unit tests (dedup + tracker gates)
JOBS_DB="$(pwd)/data_acc/acc.db" npx tsx src/cli.ts db init && \
JOBS_DB="$(pwd)/data_acc/acc.db" npx tsx src/cli.ts source --limit=8   # populate for acceptance
npx tsx test/acceptance.mts                       # Phases 2/4/5/6 incl. a live dry-run fill
npx tsx test/mcp-client.mts                       # Phase 3: MCP over stdio
```

## Safety

The guardrails (`apply/guardrails.ts`, enforced in **code**, not prompts):

| Guardrail | Default | Env |
|---|---|---|
| Apply mode | `dryrun` (fill+screenshot, never submit) | `APPLY_MODE` |
| Daily cap | 3 submitted/day | `DAILY_CAP` |
| Per-company cap | 1 active app / 30 days | `PER_COMPANY_DAYS` |
| Fit threshold | 70 | `FIT_THRESHOLD` |
| ATS allowlist | greenhouse, lever, ashby | `ATS_ALLOWLIST` |
| Cross-lane dedup | always | — |
| No fabrication | always (unknown ⇒ skip+flag) | `ON_UNKNOWN_FIELD` |
| Kill switch | `data/STOP` file + MCP `halt` | `KILL_FILE` |

**The dry-run → live ramp (guardrails.md §3):**
1. Run unattended in `dryrun` for a week — review screenshots in `data/screenshots/`.
2. `APPLY_MODE=live DAILY_CAP=3 npm run orchestrate` — submit only to the allowlisted ATS.
3. Raise `DAILY_CAP` as real response data justifies it.

Every apply attempt writes a full audit record (mode, outcome, screenshot, exact answers) to the
`applications` + `events` tables.

## Important: populate your profile first

`profile/profile.json` currently holds only the **known** structured facts (name, H-1B/sponsorship,
target titles, relocate-anywhere, Amazon-excluded) — skills/experience are `TODO_SETUP` placeholders.
Run `/setup` (or `/expand`) and mirror the result into `profile.json`. Until then the heuristic
scorer can't find skill/experience overlap, so fit scores stay moderate and the 70 threshold holds
most jobs back — by design (no fabrication). Nothing is invented to fill the gap.

## What's LLM-driven vs deterministic

The deterministic pipeline (sourcing, dedup, filtering, scoring gate, ATS resume, screening answers,
guarded apply, report) runs standalone here. Two stages have an optional LLM upgrade that Claude Code
performs by delegating to existing repo assets:
- **Rich fit rationale** — `04-job-evaluation.md` framework / MCP `score_fit`.
- **LaTeX CV + cover letter** — the [`/apply-unattended`](../.claude/commands/apply-unattended.md)
  command (drafter → reviewer → mandatory PDF compile/inspect loop).

## Deferred (per plan)

- **Workday + custom career sites** (Google/Meta/Apple/Netflix/Microsoft, NVIDIA, Salesforce) —
  sourced-only / attended apply; unattended apply deferred (plan §2.2, design §2.5). They are in the
  watchlist with `enabled:false`.
- **Adzuna** connector is built but needs a free key (`ADZUNA_APP_ID` / `ADZUNA_APP_KEY`).
- **Hugging Face** uses Workable (no v1 connector) — disabled in the watchlist.
