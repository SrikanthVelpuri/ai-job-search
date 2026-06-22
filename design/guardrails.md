# Guardrails — Unattended Apply Safety System

**Status:** DRAFT for review · **Date:** 2026-06-21

Companion to [plan.md](plan.md) and [design.md](design.md). You chose **fully unattended apply**, so
this layer is not optional — it is the thing that keeps unattended automation from hurting you.

---

## 1. Honest risk statement (read this)

Fully unattended job application carries real, non-hypothetical risks. I'm flagging them so the
guardrails below make sense — not to talk you out of it.

- **ToS / account risk.** Many ATS portals and job boards prohibit automated submission. Detection
  can mean a rejected application or, worst case, a flagged/blocked account. AIApply and Jobright run
  in *your* browser session under *your* login; the custom lane uses its own automated session.
- **Quality / reputation risk.** Mass auto-apply tends to *lower* callback rates and can annoy
  recruiters at companies you actually want. Volume is a vanity metric.
- **Correctness risk.** An unattended agent filling forms can mis-answer screening questions. The
  hard rule: **never fabricate.** Unknown → skip + flag, not guess.
- **Captcha / bot-detection.** Common on Workday and large boards. We detect and skip; we do not
  defeat them.

The guardrails turn "fully unattended" into "unattended **within a safe envelope, fully audited,
instantly haltable.**"

## 2. Hard limits (enforced in code, not prompts)

| Guardrail | Default | Purpose |
|---|---|---|
| **Daily cap** | 3–5 apps/day (during ramp) | Volume control; avoids spam patterns. |
| **Per-company cap** | 1 active app / 30 days | Never spam one employer. |
| **Fit threshold** | score ≥ configurable floor | Only apply where you genuinely match. |
| **ATS allowlist** | Greenhouse, Lever, Ashby (v1) | Only forms we've validated. Everything else → queue for human. |
| **Dedup gate** | across Lanes A/B/C | Never apply twice via different channels. |
| **No-fabrication rule** | always on | Unknown field/question → skip + flag, never invent. |
| **Salary/auth honesty** | from `profile.json` | Work-auth & salary answers come from your real data only. |

## 3. The dry-run → live ramp

We do **not** start by submitting. Submission is the last switch flipped, gradually:

1. **Dry-run week:** fill every form end-to-end, screenshot, **stop before submit.** You review the
   screenshots. Zero submissions.
2. **Live, cap 3/day:** flip submit on for the validated ATS allowlist only.
3. **Raise cap** only as real response data justifies it.

A single config flag (`APPLY_MODE = dryrun | live`) controls this; default is `dryrun`.

## 4. Kill switch & abort

- **Global kill switch:** a sentinel file (`data/STOP`) and an MCP `halt` tool. Presence/call stops
  the orchestrator mid-run before the next submit.
- **Per-run abort on anomaly:** if N consecutive forms hit captcha/login-wall/unknown fields, the run
  aborts and reports rather than pushing through.
- Both Claude Code and Claude Desktop can trigger the halt.

## 5. Audit trail (every single application)

For each submission attempt, write to `applications` + `events`:
- timestamp, lane, job id/url, ATS, fit score
- exact answers submitted (`answers_json`)
- **screenshot** of the filled form (`screenshot_path`)
- mode (dryrun/live), result (submitted/skipped/failed) + reason

So you can always reconstruct *exactly* what was sent where. Nothing is invisible.

## 6. Captcha / bot-detection policy
- Detect → **skip + flag** for human handling. Default.
- (Optional, your call) **pause-for-human:** queue the job and notify instead of skipping.
- We do **not** integrate captcha-solving services for bot-hostile sites.

## 7. What stays human-in-the-loop even when "unattended"
- Any ATS outside the allowlist (e.g., Workday until validated).
- Any job above a configurable salary/seniority/"dream company" tier you mark `review_required`.
- Any free-text question the answer bank can't cover with high confidence.

## 8. Defaults summary (you can change any of these before Phase 7)
```
APPLY_MODE              = dryrun         # never live until you flip it
DAILY_CAP               = 3
PER_COMPANY_DAYS        = 30
FIT_THRESHOLD           = <set in §6 of plan.md>
ATS_ALLOWLIST           = [greenhouse, lever, ashby]
CAPTCHA_POLICY          = skip_and_flag
ON_UNKNOWN_FIELD        = skip_and_flag
REVIEW_REQUIRED_TIERS   = [dream_company, salary>X, director+]
KILL_FILE               = data/STOP
```
