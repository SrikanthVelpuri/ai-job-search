# /apply-unattended - Non-Interactive Drafter-Reviewer Apply

You are running the **unattended** variant of `/apply` (design.md §3.2). It is identical to
`/apply` except the two human gates are replaced by automated decisions, and it auto-continues
into the guarded apply engine. **Interactive `/apply` is unchanged — use this only inside the
orchestrator or when the caller explicitly asks for unattended mode.**

The job is provided as `$ARGUMENTS`: a tracker **job id** (preferred) or a URL/text. When given a
job id, load the job + its fit score from the tracker (`data/jobs.db`) instead of re-fetching.

**This command never submits an application by itself.** Submission is gated by the apply engine +
guardrails (`agent/src/apply/`), which default to `APPLY_MODE=dryrun`. This command's job is to
produce the *tailored artifacts + screening answers* and hand them to the engine.

---

## Step 0: Parse Input & Load Context
- If `$ARGUMENTS` is a job id: read the job row + latest `ScoreResult` from the tracker.
- If URL/text: fetch as in `/apply` Step 0 and run scoring first (see Step 1 gate).
- Load `profile/profile.json`, `profile/answer-bank.md`, and the config (`agent/src/config.ts` defaults).

## Step 1: Fit-threshold gate (replaces "Should I proceed with drafting?")
Instead of asking the user, decide automatically:
- Compute / load the fit score using `04-job-evaluation.md` (the same framework as `/apply` Step 1).
- **Proceed only if** `score.overall >= FIT_THRESHOLD` (default 70) **and** `score.prefilter.pass`
  **and** `score.locationPass`.
- If the gate fails: write an `applications` row with `status='skipped'`, `notes` = the reason,
  log an event, and STOP. Do not draft.

## Step 2: Draft CV + Cover Letter
Identical to `/apply` Step 2 (read `03-writing-style`, `05-cv-templates`, `06-cover-letter-templates`;
write `cv/main_<company>.tex` + `cover_letters/cover_<company>_<role>.tex`). English CV always.

## Step 3: Reviewer
Identical to `/apply` Step 3 (spawn the `general-purpose` reviewer; gemini-research-expert is
optional). Pass drafts inline.

## Step 4: Revise
Identical to `/apply` Step 4. Apply structured + narrative edits. **No fabrication.**

## Step 4b: ATS-safe resume + screening answers (NEW — unattended needs these)
- Generate the **ATS-safe text resume** (`agent/src/tailoring/ats-resume.ts` → `writeAtsResume`).
- Generate the **screening answer set** for the job's known questions
  (`agent/src/tailoring/screening-answers.ts` → `generateScreeningAnswers`), grounded ONLY in
  `profile.json` + `answer-bank.md`. Any unanswerable required question ⇒ the set is flagged
  `hasUnanswerable=true`.

## Step 5: Compile & Inspect PDFs (MANDATORY — unchanged)
Identical to `/apply` Step 5. **Never skip.** lualatex CV (exactly 2 pp), xelatex cover letter
(1 p). Iterate until both PDFs pass inspection. This is the quality bar unattended apply depends on.

## Step 6: Hand to the apply engine (replaces "ready for your review" hand-off)
Instead of telling the user the files are ready:
1. Record/return the artifact paths (CV, letter, ATS resume, answers_json) on the `applications` row
   with `status='tailored'`.
2. The orchestrator passes these to `agent/src/apply/` which:
   - re-checks guardrails (`evaluateGuardrails`): allowlisted ATS, caps, dedup, kill switch,
     `hasUnanswerable` ⇒ block;
   - fills the form via the matching Playwright filler;
   - **screenshots**, then in `dryrun` STOPS before submit, or in `live` submits;
   - writes the full audit record (mode, outcome, screenshot path).

## Hard rules (carried over + added)
- No fabrication, ever. Unknown screening field ⇒ flag `needsHuman`, never guess.
- Agentic-coding / AI-tooling references in CV/letter mention **Claude Code** by name.
- The mandatory PDF compile-and-inspect loop is non-skippable.
- This command does not flip `APPLY_MODE`. Going live is a separate, explicit human action.
